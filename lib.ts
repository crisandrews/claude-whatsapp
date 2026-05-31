// Pure helpers extracted from server.ts so they can be unit-tested without
// pulling in Baileys / MCP SDK at import time. Algorithms only — no module
// state, no side-effects beyond the explicit filesystem operations on the
// path argument passed in.

import fs from 'fs'

// ---------------------------------------------------------------------------
// JID handling
// ---------------------------------------------------------------------------
export interface JidParts {
  local: string
  namespace: string
}

export function splitJid(jid: string | null | undefined): JidParts | null {
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at < 0) return null
  const beforeAt = jid.slice(0, at)
  const local = beforeAt.split(':')[0]
  const namespace = jid.slice(at + 1)
  if (!local || !namespace) return null
  return { local, namespace }
}

/**
 * Returns true when `jid` resolves to the same identity as the bot. Strict:
 * does not bridge `@s.whatsapp.net` and `@lid` namespaces (cross-namespace
 * resolution would need a LID↔phone cache we don't have yet).
 */
export function matchesBot(
  jid: string | null | undefined,
  botLocal: string | null,
  botNamespace: string | null,
): boolean {
  if (!botLocal || !botNamespace) return false
  const parts = splitJid(jid)
  if (!parts) return false
  return parts.local === botLocal && parts.namespace === botNamespace
}

// ---------------------------------------------------------------------------
// Message chunking — splits a long reply into <= `limit` sized pieces.
// `length` mode is a hard cut at exactly `limit`; `newline` mode looks
// backwards from `limit` for the nearest paragraph break (\n\n), then a
// line break (\n), then a space, falling back to a hard cut only if
// nothing usable lies past the half-way point. Leading newlines on each
// continuation chunk are stripped so the seam reads naturally.
// ---------------------------------------------------------------------------
export type ChunkMode = 'length' | 'newline'

export function chunk(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return text.length ? [text] : []
  const pieces: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const half = Math.floor(limit / 2)
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      // Only honor a soft break if it lies past the half-way point — otherwise
      // we'd produce a tiny chunk followed by a near-full chunk, which is
      // worse UX than just hard-cutting.
      if (para >= half) cut = para
      else if (line >= half) cut = line
      else if (space > 0) cut = space
    }
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.length) pieces.push(rest)
  return pieces
}

// ---------------------------------------------------------------------------
// Permission relay — pure parser
// ---------------------------------------------------------------------------
// Spec: 5 letters from `a-z` minus `l` (looks like 1/I in many fonts).
// Case-insensitive; mobile keyboards autocapitalize the first character.
// The request_id is generated and emitted lowercase by the channel host;
// we normalize on parse so a `YES TBXKQ` reply looks up correctly.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export interface PermissionReply {
  requestId: string
  behavior: 'allow' | 'deny'
}

/**
 * Coarse parse of an inbound text message looking for a permission response
 * in the form `yes <id>` / `no <id>`. The caller is still responsible for
 * verifying the id matches a pending request and the sender is the original
 * DM target.
 */
export function parsePermissionReply(text: string): PermissionReply | null {
  const match = text.match(PERMISSION_REPLY_RE)
  if (!match) return null
  return {
    requestId: match[2].toLowerCase(),
    behavior: match[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
  }
}

// ---------------------------------------------------------------------------
// Permission prompt formatting — extract a friendly highlight (file path,
// URL, command) from the input_preview JSON we receive from Claude Code,
// so the WhatsApp message reads naturally on mobile instead of dumping a
// raw JSON blob. Falls back to the code-blocked preview when we don't
// recognize the tool or the JSON is truncated past the field of interest.
// ---------------------------------------------------------------------------
export function tryExtractJsonField(input: string, field: string): string | null {
  if (!input) return null
  // First try real JSON. CC may truncate input_preview to ~200 chars + '…',
  // which breaks JSON.parse — we then fall back to a regex over the prefix.
  try {
    const obj = JSON.parse(input)
    if (obj && typeof obj === 'object' && typeof (obj as any)[field] === 'string') {
      return (obj as any)[field]
    }
  } catch {}
  // Regex over a possibly-truncated string. Captures escaped quotes/backslashes
  // properly — we don't want a literal `\"` to terminate the match.
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = input.match(re)
  if (!m) return null
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
}

export interface PermissionInputSummary {
  /** A short scannable line shown above the code block (e.g. `📄 path/to/file.ts`). */
  highlight?: string
  /** The raw preview to render in a triple-backtick block. Omitted when the
   *  highlight already conveys everything (e.g. a Read tool with just a path). */
  codeBlock?: string
}

export function summarizePermissionInput(
  toolName: string,
  inputPreview: string,
): PermissionInputSummary {
  if (!inputPreview) return {}
  switch (toolName) {
    case 'Bash':
    case 'BashOutput': {
      const cmd = tryExtractJsonField(inputPreview, 'command')
      return { codeBlock: cmd ?? inputPreview }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const file = tryExtractJsonField(inputPreview, 'file_path')
      return file
        ? { highlight: `📄 ${file}`, codeBlock: inputPreview }
        : { codeBlock: inputPreview }
    }
    case 'NotebookEdit': {
      const nb = tryExtractJsonField(inputPreview, 'notebook_path')
      return nb
        ? { highlight: `📓 ${nb}`, codeBlock: inputPreview }
        : { codeBlock: inputPreview }
    }
    case 'Read': {
      const file = tryExtractJsonField(inputPreview, 'file_path')
      return file ? { highlight: `👁 ${file}` } : { codeBlock: inputPreview }
    }
    case 'WebFetch': {
      const url = tryExtractJsonField(inputPreview, 'url')
      return url ? { highlight: `🌐 ${url}` } : { codeBlock: inputPreview }
    }
    case 'WebSearch': {
      const q = tryExtractJsonField(inputPreview, 'query')
      return q ? { highlight: `🔍 ${q}` } : { codeBlock: inputPreview }
    }
    default:
      return { codeBlock: inputPreview }
  }
}

// ---------------------------------------------------------------------------
// Single-instance lock — atomic create with stale/corrupt recovery
// ---------------------------------------------------------------------------
export type LockResult =
  | { kind: 'acquired' }
  | { kind: 'contended'; existingPid: number; existingStartedAt?: number | null }
  | { kind: 'error'; error: string }

export type CreateLockResult =
  | { kind: 'acquired' }
  | { kind: 'exists' }
  | { kind: 'error'; error: string }

export interface ParsedLock {
  pid: number | null
  /** Epoch ms the holder acquired the lock. null for the legacy bare-PID format. */
  startedAt: number | null
}

/**
 * Serialize the lock payload PID-FIRST: the bare owner PID on the first line,
 * then JSON metadata on the second. This is deliberately back-compatible —
 * an older reader (≤1.20.0) does `parseInt(readFileSync().trim())`, which reads
 * the leading integer and ignores the rest, so it still gets the correct owner
 * PID and never mistakes a newer lock for a "corrupt" one (which would make it
 * reclaim a lock another live server holds). That matters most during an update
 * window when an old and new server may briefly coexist. Newer readers
 * additionally recover `startedAt` from the JSON line via parseLockFile().
 */
export function formatLockContent(pid: number, startedAt: number = Date.now()): string {
  return `${pid}\n${JSON.stringify({ pid, startedAt })}`
}

/** Tolerant parser: handles both the legacy bare-PID format and the PID-first
 *  format from formatLockContent(). Never throws. */
export function parseLockFile(raw: string): ParsedLock {
  const trimmed = (raw || '').trim()
  if (!trimmed) return { pid: null, startedAt: null }
  let pid: number | null = null
  let startedAt: number | null = null
  // Leading integer covers both bare-PID (old) and PID-first (new) formats.
  const lead = parseInt(trimmed, 10)
  if (!Number.isNaN(lead) && lead > 0) pid = lead
  // Recover JSON metadata if present (new format, or a pure-JSON defensive case).
  const brace = trimmed.indexOf('{')
  if (brace >= 0) {
    try {
      const meta = JSON.parse(trimmed.slice(brace))
      if (pid === null && typeof meta.pid === 'number' && meta.pid > 0) pid = meta.pid
      if (typeof meta.startedAt === 'number' && meta.startedAt > 0) startedAt = meta.startedAt
    } catch {
      // Metadata unreadable — the leading PID (if any) still stands.
    }
  }
  return { pid, startedAt }
}

export function tryCreateLockFile(lockPath: string, ownerPid: number): CreateLockResult {
  try {
    // 'wx' = O_CREAT | O_EXCL on POSIX — atomic create-or-fail.
    const fd = fs.openSync(lockPath, 'wx')
    try {
      fs.writeSync(fd, formatLockContent(ownerPid))
    } finally {
      fs.closeSync(fd)
    }
    return { kind: 'acquired' }
  } catch (err: any) {
    if (err?.code === 'EEXIST') return { kind: 'exists' }
    return { kind: 'error', error: err?.message || String(err) }
  }
}

export function unlinkIfExists(p: string): { kind: 'ok' } | { kind: 'error'; error: string } {
  try {
    fs.unlinkSync(p)
    return { kind: 'ok' }
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { kind: 'ok' }
    return { kind: 'error', error: err?.message || String(err) }
  }
}

export interface AcquireLockOptions {
  lockPath: string
  ownerPid: number
  /** Returns true if the given pid is alive. Defaulted to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean
  /** Optional sink for diagnostic messages. */
  log?: (msg: string) => void
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function acquireLock(opts: AcquireLockOptions): LockResult {
  const { lockPath, ownerPid } = opts
  const isAlive = opts.isAlive ?? defaultIsAlive
  const log = opts.log ?? (() => {})

  // First attempt — atomic exclusive create.
  const first = tryCreateLockFile(lockPath, ownerPid)
  if (first.kind === 'acquired') return { kind: 'acquired' }
  if (first.kind === 'error') return { kind: 'error', error: first.error }

  // Lock exists — inspect.
  let existingPid: number | null = null
  let existingStartedAt: number | null = null
  try {
    const parsed = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
    existingPid = parsed.pid
    existingStartedAt = parsed.startedAt
  } catch {
    // Unreadable — treat as corrupt below.
  }

  const reclaim = (reason: string): LockResult => {
    const u = unlinkIfExists(lockPath)
    if (u.kind === 'error') return { kind: 'error', error: u.error }
    const second = tryCreateLockFile(lockPath, ownerPid)
    if (second.kind === 'acquired') return { kind: 'acquired' }
    if (second.kind === 'error') return { kind: 'error', error: second.error }
    // Race: another process grabbed it. Try to give a useful answer.
    try {
      const parsed = parseLockFile(fs.readFileSync(lockPath, 'utf8'))
      if (parsed.pid !== null) {
        return { kind: 'contended', existingPid: parsed.pid, existingStartedAt: parsed.startedAt }
      }
    } catch {}
    return { kind: 'error', error: `lock contended after ${reason} recovery` }
  }

  if (existingPid === null) {
    log('lock file corrupt or unreadable, reclaiming')
    return reclaim('corrupt-lock')
  }

  if (existingPid === ownerPid) {
    log(`lock owned by our own PID ${existingPid}, reclaiming`)
    return reclaim('self-lock')
  }

  if (isAlive(existingPid)) return { kind: 'contended', existingPid, existingStartedAt }

  log(`stale lock found (PID ${existingPid} no longer alive), reclaiming`)
  return reclaim('stale-pid')
}
