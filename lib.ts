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
 * `123:4@lid` → `123@lid`: the JID without its `:device` part. Call offers
 * name the calling DEVICE, while the allowlist, `ownerJids` and every chat id
 * the tools accept name the USER, so a device-suffixed JID matches none of
 * them. Anything that doesn't parse as a JID is returned unchanged.
 */
export function stripJidDevice(jid: string): string {
  const parts = splitJid(jid)
  return parts ? `${parts.local}@${parts.namespace}` : jid
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

// ---------------------------------------------------------------------------
// Inbound contact cards (vCard) — surface the phone numbers, not just the name
// ---------------------------------------------------------------------------
// A shared contact arrives as a vCard. Before this, the agent only saw the
// display name, so "here's Diego's card" was useless without the number.
// The vCard is untrusted content: we only extract digits from TEL lines and a
// sanitized display name; nothing else from the card reaches the agent.

const MAX_CARD_NAME = 60
const MAX_CARD_PHONES = 5

/** Strip control chars/newlines and bracket-like delimiters, cap length. */
export function sanitizeCardName(name: string | null | undefined): string {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.slice(0, MAX_CARD_NAME) || 'unknown'
}

/**
 * Phone numbers from a vCard's TEL lines, as `+<digits>`. Prefers WhatsApp's
 * `waid=` parameter (the account's number) over the free-text value. Folded
 * lines are unfolded first. Deduplicated, 8–15 digits, at most 5.
 */
export function parseVcardPhones(vcard: string | null | undefined): string[] {
  if (!vcard) return []
  const lines = String(vcard).replace(/\r?\n[ \t]/g, '').split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    const m = /^(?:item\d+\.)?TEL([^:]*):(.*)$/i.exec(line.trim())
    if (!m) continue
    const waid = /(?:^|;)waid=(\d+)/i.exec(m[1])
    const digits = (waid ? waid[1] : m[2]).replace(/\D/g, '')
    if (digits.length < 8 || digits.length > 15) continue
    const phone = `+${digits}`
    if (!out.includes(phone)) out.push(phone)
    if (out.length >= MAX_CARD_PHONES) break
  }
  return out
}

/** `[Contact: Diego — +56912345678]` for one or more shared cards. */
export function describeContactCards(cards: Array<{ displayName?: string | null; vcard?: string | null }>): {
  text: string
  phones: string[]
} {
  const parts: string[] = []
  const phones: string[] = []
  for (const c of cards.slice(0, 10)) {
    const p = parseVcardPhones(c.vcard)
    for (const x of p) if (!phones.includes(x)) phones.push(x)
    parts.push(`${sanitizeCardName(c.displayName)}${p.length ? ' — ' + p.join(', ') : ' (no phone number in card)'}`)
  }
  const label = parts.length > 1 ? 'Contacts' : 'Contact'
  return { text: `[${label}: ${parts.join('; ') || 'empty card'}]`, phones }
}

// ---------------------------------------------------------------------------
// Reply quotes — which message an inbound is replying to
// ---------------------------------------------------------------------------
// WhatsApp carries the quote in the replying message's own `contextInfo`
// (`stanzaId`, `participant`, `quotedMessage`). All of it is SENDER-SUPPLIED:
// a modified client can attach any id, author and text. It tells the agent
// what the sender is pointing at; it is never proof of who said what.

export const QUOTED_TEXT_MAX = 300
export const QUOTE_PREFIX_MAX = 120

export interface QuoteRef {
  /** `contextInfo.stanzaId` — id of the quoted message. */
  messageId: string
  /** `contextInfo.participant` exactly as sent ('' when absent). */
  participant: string
  /** One-line, length-capped description of the quoted message ('' if unknown). */
  text: string
}

function unwrapMessage(m: any): any {
  let cur = m
  for (let i = 0; i < 4 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message
    if (!inner) break
    cur = inner
  }
  return cur
}

/** One line, no control / format (bidi, zero-width) characters, at most `max`
 *  code points — an ellipsis marks a cut. */
export function clipOneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const clean = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const points = Array.from(clean)
  if (points.length <= max) return clean
  return points.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…'
}

/**
 * Describe a quoted message body: its text, or a short tag for media plus the
 * caption. `hasText` is false when there was nothing typed to show (a bare
 * voice note, a sticker, an unknown type) — the caller may then look the
 * message up in the local store, where e.g. a transcription lives.
 */
export function describeQuotedContent(message: unknown): { tag: string; text: string; hasText: boolean } {
  const m = unwrapMessage(message)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const out = (tag: string, text: string) => ({ tag, text, hasText: text.trim().length > 0 })
  if (!m || typeof m !== 'object') return out('', '')
  if (str(m.conversation)) return out('', m.conversation)
  if (m.extendedTextMessage) return out('', str(m.extendedTextMessage.text))
  if (m.imageMessage) return out('[image]', str(m.imageMessage.caption))
  if (m.videoMessage) return out('[video]', str(m.videoMessage.caption))
  if (m.audioMessage) return out(m.audioMessage.ptt ? '[voice note]' : '[audio]', '')
  if (m.documentMessage) {
    const name = clipOneLine(str(m.documentMessage.fileName), 80)
    return out(name ? `[document: ${name}]` : '[document]', str(m.documentMessage.caption))
  }
  if (m.stickerMessage) return out('[sticker]', '')
  if (m.contactMessage || m.contactsArrayMessage) return out('[contact]', '')
  if (m.locationMessage || m.liveLocationMessage) return out('[location]', '')
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3) return out('[poll]', '')
  return out('', '')
}

/** The `contextInfo` of a message, across the types that can carry a quote. */
export function findContextInfo(message: unknown): any | null {
  const m = unwrapMessage(message)
  if (!m || typeof m !== 'object') return null
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    null
  )
}

/**
 * The quote an inbound message carries, or null when it is not a reply.
 * `lookupStoredText` is consulted only when the embedded quote has no text of
 * its own (missing, or bare media): it receives the quoted message id and
 * returns that message's text from the local store, if indexed.
 */
export function extractQuote(
  message: unknown,
  lookupStoredText?: (messageId: string) => string | null | undefined,
): QuoteRef | null {
  const ctx = findContextInfo(message)
  if (!ctx || typeof ctx.stanzaId !== 'string' || !ctx.stanzaId) return null
  const desc = describeQuotedContent(ctx.quotedMessage)
  let body = desc.text
  if (!desc.hasText && lookupStoredText) {
    let stored = ''
    try { stored = lookupStoredText(ctx.stanzaId) || '' } catch { stored = '' }
    stored = stored.trim()
    // The store's own placeholders ("[Voice message received]") add nothing
    // over the tag we already have.
    if (stored && !(desc.tag && /^\[[^\]]*\]$/.test(stored))) body = stored
  }
  const text = clipOneLine([desc.tag, body].filter((x) => x && x.trim()).join(' '), QUOTED_TEXT_MAX)
  return {
    messageId: ctx.stanzaId,
    participant: typeof ctx.participant === 'string' ? ctx.participant : '',
    text,
  }
}

/** Meta fields for a quote. `quoted_from` is the author's user JID, or '' when
 *  the quoted message is the bot's own (or the author is unknown). */
export function quoteMeta(quote: QuoteRef, quotedIsOwn: boolean): Record<string, string> {
  return {
    quoted_message_id: quote.messageId,
    quoted_from: quotedIsOwn || !quote.participant ? '' : stripJidDevice(quote.participant),
    quoted_text: quote.text,
  }
}

/** The one-line prefix put in front of the notification content. */
export function quotePrefix(quote: QuoteRef, quotedIsOwn: boolean): string {
  const who = quotedIsOwn ? 'Replying to your message' : 'Replying to'
  const shown = clipOneLine(quote.text, QUOTE_PREFIX_MAX).replace(/"/g, "'")
  return shown ? `[${who}: "${shown}"]` : `[${who === 'Replying to' ? 'Replying to an earlier message' : who}]`
}
