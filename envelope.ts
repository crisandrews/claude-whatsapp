// Per-inbound request envelope — published for peer plugins (OpenCLAUDE) that
// need a per-MCP-call binding to the inbound that triggered the notification.
//
// Contract (mirrored in docs/scope-envelope-contract.md):
//   - Path: `<channel-dir>/.request-envelopes/<token>.json` (dir 0o700, file 0o600)
//   - Token: 32 random bytes → base64url (43 chars, no padding, [A-Za-z0-9_-])
//   - Schema v1: { version:1, token, chatId, senderId, ts, expiresAt }
//   - TTL = 60 s; expiresAt = ts + 60_000
//   - Atomic write via O_EXCL + temp+rename
//   - Rotation cap = 500 envelopes; oldest by mtime pruned on every write
//   - TTL cleanup: every write also unlinks files past expiry + 5 s skew
//
// Justification independent of OpenCLAUDE: per-inbound audit log + replay
// fixture corpus, useful for debugging this plugin in isolation.
//
// All failures are silent — never throw out of a messaging hot path. If the
// envelope isn't written, the notification still dispatches (without token);
// OpenCLAUDE peer falls back to its guest mode.

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export const ENVELOPE_DIR_NAME = '.request-envelopes'
export const ENVELOPE_VERSION = 1
export const ENVELOPE_TTL_MS = 60_000
export const ENVELOPE_CLOCK_SKEW_TOLERANCE_MS = 5_000
export const ENVELOPE_TOKEN_BYTES = 32
export const ENVELOPE_TOKEN_LENGTH = 43
export const ENVELOPE_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/
export const ENVELOPE_ROTATION_CAP = 500
export const ENVELOPE_MAX_BYTES = 1024

export interface RequestEnvelopePayload {
  version: number
  token: string
  chatId: string
  senderId: string
  ts: number
  expiresAt: number
}

function generateToken(): string | null {
  // Codex 1st-pass MEDIUM 1: crypto.randomBytes can throw if the OS RNG
  // can't be sourced (rare on POSIX/macOS, but plausible inside
  // chroot/jail environments). Wrap so the "never throws" contract holds.
  try {
    return crypto.randomBytes(ENVELOPE_TOKEN_BYTES).toString('base64url')
  } catch {
    return null
  }
}

function ensureDir(dir: string): boolean {
  // Codex 1st-pass MEDIUM 2: validate that the envelope dir, if it
  // already exists, is a real directory and not a symlink that an
  // attacker (with same-uid write to the parent) might have planted.
  // We can't fully close the symlink race (a swap between lstat and
  // open is racy), but failing closed on the steady-state symlink is
  // the right default.
  try {
    const lst = fs.lstatSync(dir)
    if (lst.isSymbolicLink()) return false
    if (!lst.isDirectory()) return false
    // Pre-existing dir: tighten mode (best-effort).
    try { fs.chmodSync(dir, 0o700) } catch {}
    return true
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') return false
    // Doesn't exist yet — create it.
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      try { fs.chmodSync(dir, 0o700) } catch {}
      return true
    } catch {
      return false
    }
  }
}

function pruneExpiredAndRotate(dir: string, now: number): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }

  interface Entry { name: string; mtimeMs: number; expiresAt: number | null }
  const items: Entry[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    if (!ENVELOPE_TOKEN_REGEX.test(stem)) continue
    const full = path.join(dir, name)
    let st: fs.Stats
    try {
      st = fs.statSync(full)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    // Cheap TTL probe: read expiresAt without full validation; if unreadable,
    // fall back to mtime-based eligibility.
    let expiresAt: number | null = null
    try {
      const raw = fs.readFileSync(full, { encoding: 'utf8' })
      if (raw.length <= ENVELOPE_MAX_BYTES) {
        const obj = JSON.parse(raw)
        if (obj && typeof obj.expiresAt === 'number' && Number.isFinite(obj.expiresAt)) {
          expiresAt = obj.expiresAt
        }
      }
    } catch {}
    items.push({ name: full, mtimeMs: st.mtimeMs, expiresAt })
  }

  // Pass 1: TTL cleanup — drop anything past expiresAt + skew, OR past
  // mtime + TTL + skew (defensive fallback when expiresAt unreadable).
  const cutoff = now - ENVELOPE_CLOCK_SKEW_TOLERANCE_MS
  for (const it of items) {
    const dead = it.expiresAt !== null
      ? it.expiresAt < cutoff
      : (it.mtimeMs + ENVELOPE_TTL_MS) < cutoff
    if (dead) {
      try { fs.unlinkSync(it.name) } catch {}
    }
  }

  // Pass 2: rotation cap — if over capacity after cleanup, drop oldest by mtime.
  let surviving: Entry[]
  try {
    const after = new Set(fs.readdirSync(dir).map(n => path.join(dir, n)))
    surviving = items.filter(it => after.has(it.name))
  } catch {
    return
  }
  if (surviving.length <= ENVELOPE_ROTATION_CAP) return
  surviving.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const toRemove = surviving.length - ENVELOPE_ROTATION_CAP
  for (let i = 0; i < toRemove; i++) {
    try { fs.unlinkSync(surviving[i].name) } catch {}
  }
}

/**
 * Write a fresh request envelope and return the token. Returns null on
 * failure (callers should dispatch the notification without a token, and
 * peer plugins will fall back to guest mode). Never throws.
 */
export function writeRequestEnvelope(
  channelDir: string,
  chatId: string,
  senderId: string,
  now: number = Date.now(),
): string | null {
  if (!chatId || chatId === 'system') return null
  if (!senderId) return null

  const dir = path.join(channelDir, ENVELOPE_DIR_NAME)
  if (!ensureDir(dir)) return null

  const token = generateToken()
  if (!token) return null
  const payload: RequestEnvelopePayload = {
    version: ENVELOPE_VERSION,
    token,
    chatId,
    senderId,
    ts: now,
    expiresAt: now + ENVELOPE_TTL_MS,
  }

  const target = path.join(dir, `${token}.json`)
  const tmp = `${target}.tmp`
  let fd: number | null = null
  try {
    // O_EXCL ensures we never overwrite an existing envelope. Token collision
    // is astronomically unlikely (256-bit entropy) but the flag is cheap.
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    const body = JSON.stringify(payload)
    if (body.length > ENVELOPE_MAX_BYTES) {
      // Defensive: payload must fit our reader's cap. Should never trigger
      // with valid JIDs, but if it does we skip the write rather than emit
      // an envelope readers will reject.
      fs.closeSync(fd)
      fd = null
      try { fs.unlinkSync(tmp) } catch {}
      return null
    }
    fs.writeSync(fd, body)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, target)
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd) } catch {}
    }
    try { fs.unlinkSync(tmp) } catch {}
    return null
  }

  // Housekeeping. Always run, even on success, so the directory doesn't
  // grow without bound. Failure inside prune is silent.
  try { pruneExpiredAndRotate(dir, now) } catch {}

  return token
}

/**
 * Phase 6.1 — hardened envelope reader for claude-whatsapp's own
 * internal MCP tools. Mirrors the OpenCLAUDE-side reader exactly:
 *
 *   - TOKEN_REGEX validation BEFORE any FS access.
 *   - `lstat` the envelope dir first; reject if it's a symlink, not a
 *     dir, wrong uid, or world/group-readable (defense against same-uid
 *     attacker who pre-planted a symlink dir before claude-whatsapp's
 *     first write).
 *   - O_NOFOLLOW + O_NONBLOCK on the file (defense against symlink/FIFO).
 *   - Single-fd `fstat` → reject if uid mismatch, mode `& 0o077`, or
 *     size > ENVELOPE_MAX_BYTES.
 *   - Short-read guard: `read !== stat.size` → null.
 *   - Strict schema + TTL + future-skew via parseRequestEnvelope.
 *
 * Returns null on ANY validation failure. Callers in tools should
 * fail-closed when the token was *presented* but loadRequestEnvelope
 * returned null (forged/expired/missing); when the agent omits the
 * token entirely, callers fall back to getInboundContext() for
 * backwards compat. See `scope-context.ts:resolveContextForCall` for
 * the canonical wiring of that distinction.
 */
export function loadRequestEnvelope(
  channelDir: string,
  token: string,
  now: number = Date.now(),
): RequestEnvelopePayload | null {
  if (typeof token !== 'string') return null
  if (!ENVELOPE_TOKEN_REGEX.test(token)) return null

  const envelopeDir = path.join(channelDir, ENVELOPE_DIR_NAME)
  const filePath = path.join(envelopeDir, `${token}.json`)

  // 1. Dir-level lstat — reject symlinks, non-dirs, wrong-uid, world-readable.
  let dirSt: fs.Stats
  try {
    dirSt = fs.lstatSync(envelopeDir)
  } catch {
    return null
  }
  if (dirSt.isSymbolicLink()) return null
  if (!dirSt.isDirectory()) return null
  if (!ownerMatchesProcess(dirSt.uid)) return null
  if ((dirSt.mode & 0o077) !== 0) return null

  // 2. File-level pre-open lstat fast-reject (symlinks/FIFOs/sockets/dirs).
  let lst: fs.Stats
  try {
    lst = fs.lstatSync(filePath)
  } catch {
    return null
  }
  if (!lst.isFile()) return null

  // 3. Open with hardening flags.
  const NOFOLLOW =
    typeof (fs.constants as Record<string, number>).O_NOFOLLOW === 'number'
      ? (fs.constants as Record<string, number>).O_NOFOLLOW
      : 0
  const NONBLOCK =
    typeof (fs.constants as Record<string, number>).O_NONBLOCK === 'number'
      ? (fs.constants as Record<string, number>).O_NONBLOCK
      : 0
  const flags = fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK
  let fd: number
  try {
    fd = fs.openSync(filePath, flags)
  } catch {
    return null
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return null
    if (!ownerMatchesProcess(stat.uid)) return null
    if ((stat.mode & 0o077) !== 0) return null
    if (stat.size <= 0) return null
    if (stat.size > ENVELOPE_MAX_BYTES) return null

    const buf = Buffer.alloc(stat.size)
    const read = fs.readSync(fd, buf, 0, stat.size, 0)
    if (read !== stat.size) return null

    let raw: string
    try {
      raw = buf.subarray(0, read).toString('utf8')
    } catch {
      return null
    }

    // Realpath confirmation post-open: the resolved real file MUST sit
    // under the realpath'd envelope dir. Defense against directory-level
    // aliasing despite the up-front lstat dir check.
    try {
      const realDir = fs.realpathSync.native(envelopeDir)
      const realFile = fs.realpathSync.native(filePath)
      const expectedPrefix = realDir + path.sep
      if (!realFile.startsWith(expectedPrefix)) return null
    } catch {
      return null
    }

    // Final schema + TTL + future-skew via shared parser.
    return parseRequestEnvelope(raw, token, now)
  } finally {
    try { fs.closeSync(fd) } catch {}
  }
}

function ownerMatchesProcess(uid: number): boolean {
  const procUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (procUid === null) return true // non-POSIX (Windows) — skip
  return uid === procUid
}

/**
 * Pure parser/validator for fixture and tier1 tests. Returns null on any
 * schema violation, TTL expiry, or future-skew. Does not touch the
 * filesystem — peer implementations share semantics by reading + parsing
 * themselves.
 */
export function parseRequestEnvelope(
  raw: string,
  filenameToken: string,
  now: number = Date.now(),
): RequestEnvelopePayload | null {
  if (!ENVELOPE_TOKEN_REGEX.test(filenameToken)) return null
  if (raw.length > ENVELOPE_MAX_BYTES) return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.version !== ENVELOPE_VERSION) return null
  if (typeof o.token !== 'string' || o.token !== filenameToken) return null
  if (typeof o.chatId !== 'string' || !o.chatId) return null
  if (typeof o.senderId !== 'string' || !o.senderId) return null
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts) || o.ts <= 0) return null
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null
  if (o.expiresAt !== o.ts + ENVELOPE_TTL_MS) return null
  if (now - o.ts > ENVELOPE_TTL_MS) return null
  if (o.ts > now + ENVELOPE_CLOCK_SKEW_TOLERANCE_MS) return null
  return {
    version: o.version,
    token: o.token,
    chatId: o.chatId,
    senderId: o.senderId,
    ts: o.ts,
    expiresAt: o.expiresAt,
  }
}
