// ---------------------------------------------------------------------------
// Owner-approved, time-limited contact access requests — pure decision logic
// ---------------------------------------------------------------------------
// The agent (LLM) may only REQUEST that a phone number be allowed to DM it.
// The plugin — never the agent — sends the owner its own approval prompt, and
// only an owner decision arriving on the INBOUND path (a 👍/👎 reaction to that
// plugin-authored prompt, or an `approve <id>` / `deny <id>` text) can create a
// grant. Grants are narrow (one phone number, DMs only), temporary (N days,
// capped) and recorded in access.json so the normal inbound gate admits them.
//
// Everything in this module is pure — no Baileys, no MCP, no filesystem, no
// clock reads — so every security decision can be unit-tested without starting
// the server (which would take over the live WhatsApp session). server.ts owns
// the I/O: sending prompts, reading/writing access.json, notifying the agent.

export type Locale = 'en' | 'es'

// ---------------------------------------------------------------------------
// Limits and defaults
// ---------------------------------------------------------------------------
export const DEFAULT_DAYS = 7
export const DEFAULT_MAX_DAYS = 14
/** Hard cap: no configuration can make a grant last longer than this. */
export const HARD_MAX_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
/** A pending request (and its prompt) is valid for 24 h. */
export const REQUEST_TTL_MS = DAY_MS
export const MAX_PENDING_REQUESTS = 3
export const MAX_REQUESTS_PER_WINDOW = 10
export const RATE_WINDOW_MS = DAY_MS
export const LABEL_MAX_LEN = 40
export const REASON_MAX_LEN = 200
/** A label is a name, not a phone number: more digits than this is refused. */
export const LABEL_MAX_DIGITS = 4
/** Prompt message ids remembered as "plugin-authored, agent may not touch". */
const PROTECTED_PROMPT_LIMIT = 500
const MAX_COMMAND_LEN = 256

// ---------------------------------------------------------------------------
// Config (access.json `contactRequests`)
// ---------------------------------------------------------------------------
export interface ContactRequestsConfig {
  enabled: boolean
  locale: Locale
  defaultDays: number
  maxDays: number
}

function intInRange(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.floor(v)
  if (n < min) return null
  return Math.min(n, max)
}

/**
 * Interpret the raw `contactRequests` value from access.json. Fail-closed:
 * anything but a literal `enabled: true` is OFF. `maxDays` is hard-capped at
 * HARD_MAX_DAYS and `defaultDays` can never exceed `maxDays`.
 */
export function resolveContactRequestsConfig(raw: unknown): ContactRequestsConfig {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const maxDays = intInRange(r.maxDays, 1, HARD_MAX_DAYS) ?? DEFAULT_MAX_DAYS
  const defaultDays = intInRange(r.defaultDays, 1, maxDays) ?? Math.min(DEFAULT_DAYS, maxDays)
  return {
    enabled: r.enabled === true,
    locale: r.locale === 'es' ? 'es' : 'en',
    defaultDays,
    maxDays,
  }
}

/** Next raw config value when the owner toggles the feature (keeps other keys). */
export function withContactRequestsEnabled(raw: unknown, enabled: boolean, locale?: Locale): Record<string, unknown> {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  base.enabled = enabled
  if (locale) base.locale = locale
  return base
}

export type DaysResult =
  | { ok: true; days: number; clamped: boolean }
  | { ok: false; error: string }

/** Requested duration → whole days in [1, maxDays]. Absent → defaultDays. */
export function resolveRequestedDays(requested: unknown, cfg: ContactRequestsConfig): DaysResult {
  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, days: cfg.defaultDays, clamped: false }
  }
  let n = NaN
  if (typeof requested === 'number') n = requested
  else if (typeof requested === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(requested)) n = Number(requested)
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: 'days must be a number of days, at least 1.' }
  }
  const whole = Math.floor(n)
  const days = Math.min(whole, cfg.maxDays)
  return { ok: true, days, clamped: days !== whole }
}

// ---------------------------------------------------------------------------
// Phone numbers and JIDs
// ---------------------------------------------------------------------------
export type PhoneResult =
  | { ok: true; digits: string; e164: string }
  | { ok: false; error: string }

/**
 * Strict E.164 normalization. Accepts "+56912345678", "56912345678",
 * "+56 9 1234-5678", "(+56) 9 1234 5678". Rejects anything with letters, `@`,
 * or other symbols (so a JID or a group id can never be smuggled in), numbers
 * without a country code (leading 0), and lengths outside 8–15 digits.
 */
export function normalizePhone(input: unknown): PhoneResult {
  if (typeof input !== 'string' && typeof input !== 'number') {
    return { ok: false, error: 'phone is required (E.164, e.g. "+56912345678").' }
  }
  const s = String(input).normalize('NFKC').trim()
  if (!s) return { ok: false, error: 'phone is required (E.164, e.g. "+56912345678").' }
  if (s.length > 40) return { ok: false, error: 'phone is too long.' }
  if (!/^(?:\+|\(\+)?[0-9 ().-]+$/.test(s)) {
    return {
      ok: false,
      error: 'phone must be a phone number in E.164 format (digits, optional leading "+", spaces/dashes allowed) — not a JID or a group id.',
    }
  }
  const digits = s.replace(/\D/g, '')
  if (digits.startsWith('0')) {
    return { ok: false, error: 'phone must include the country code (E.164, e.g. "+56912345678"); it cannot start with 0.' }
  }
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: 'phone must have 8–15 digits including the country code.' }
  }
  return { ok: true, digits, e164: `+${digits}` }
}

/** Digits of a stored phone ("+569…" or "569…"). */
export function phoneDigits(phone: unknown): string {
  return typeof phone === 'string' ? phone.replace(/\D/g, '') : ''
}

/**
 * Human-readable phone for the owner prompt. Always derived from the
 * normalized digits (never from agent text). Groups only for numbering plans
 * where the split is unambiguous; everything else is shown as plain +digits.
 */
export function formatPhoneDisplay(digits: string): string {
  if (/^569\d{8}$/.test(digits)) return `+56 9 ${digits.slice(3, 7)} ${digits.slice(7)}`
  if (/^1\d{10}$/.test(digits)) return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`
  return `+${digits}`
}

export function pnJidForDigits(digits: string): string {
  return `${digits}@s.whatsapp.net`
}

const USER_JID_RE = /^[0-9]{5,25}@(?:s\.whatsapp\.net|lid)$/

/** A 1:1 user JID (phone-number or LID form, no device suffix). Never a group,
 *  broadcast, status or newsletter JID. */
export function isUserJid(jid: unknown): jid is string {
  return typeof jid === 'string' && USER_JID_RE.test(jid)
}

function jidNamespace(jid: string): string {
  return jid.slice(jid.indexOf('@') + 1)
}

function jidLocal(jid: string): string {
  return jid.slice(0, jid.indexOf('@'))
}

/** `123:4@lid` → `123@lid` (device suffix stripped). null if not a user JID. */
export function normalizeUserJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null
  const at = jid.indexOf('@')
  if (at < 0) return null
  const out = `${jid.slice(0, at).split(':')[0]}@${jid.slice(at + 1)}`
  return isUserJid(out) ? out : null
}

// ---------------------------------------------------------------------------
// Untrusted agent text (label / reason)
// ---------------------------------------------------------------------------
/**
 * Make agent-supplied text safe to embed in a plugin-authored WhatsApp prompt:
 * NFKC-normalize; drop control, format (bidi overrides, zero-width), private-use
 * and surrogate code points and line/paragraph separators; neutralize WhatsApp
 * formatting characters and the delimiters the prompt itself uses; collapse
 * whitespace to one line; cap the length in code points. Idempotent (the
 * truncation marker is ASCII "..." because NFKC would rewrite "…").
 */
export function sanitizeUntrustedText(raw: unknown, maxLen: number): string {
  if (typeof raw !== 'string') return ''
  let s = raw.normalize('NFKC')
  s = s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ')
  s = s.replace(/[*_~`"«»]/g, ' ')
  s = s.replace(/[\s\p{Zs}]+/gu, ' ').trim()
  const cps = Array.from(s)
  if (cps.length > maxLen) s = cps.slice(0, Math.max(1, maxLen - 3)).join('').trimEnd() + '...'
  return s
}

export type TextResult = { ok: true; value: string } | { ok: false; error: string }

export function validateLabel(raw: unknown): TextResult {
  const value = sanitizeUntrustedText(raw, LABEL_MAX_LEN)
  if (!value) return { ok: false, error: 'label is required (a short display name, e.g. "Diego").' }
  const digitCount = (value.match(/\p{Nd}/gu) ?? []).length
  if (digitCount > LABEL_MAX_DIGITS) {
    return { ok: false, error: 'label must be a name, not a phone number (at most 4 digits). The plugin shows the verified phone number itself.' }
  }
  return { ok: true, value }
}

export function validateReason(raw: unknown): TextResult {
  const value = sanitizeUntrustedText(raw, REASON_MAX_LEN)
  if (!value) return { ok: false, error: 'reason is required (why this person should be allowed to message you).' }
  return { ok: true, value }
}

// ---------------------------------------------------------------------------
// Temporary grants (access.json `temporaryAllow`)
// ---------------------------------------------------------------------------
export interface TemporaryGrant {
  /** JIDs this grant ADDED to allowFrom (PN form, plus the LID form when known). */
  jids: string[]
  /** E.164 with leading "+". */
  phone: string
  label: string
  reason: string
  /** ISO-8601. An unparseable value is treated as already expired (fail closed). */
  expiresAt: string
  approvedAt: string
  requestId: string
  /** Owner JID that approved (audit only). */
  approvedBy?: string
}

/** The slice of access.json this module reads and writes. */
export interface ContactAccessView {
  dmPolicy?: string
  allowFrom: string[]
  ownerJids: string[]
  temporaryAllow?: TemporaryGrant[]
}

/**
 * Coerce a raw `temporaryAllow` value from disk. Malformed fields are kept in a
 * coerced form rather than dropped, so the expiry sweep still removes their
 * JIDs from allowFrom (dropping a record would silently make its JIDs permanent).
 */
export function normalizeTemporaryAllow(raw: unknown): TemporaryGrant[] {
  if (!Array.isArray(raw)) return []
  const out: TemporaryGrant[] = []
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue
    const g = e as Record<string, unknown>
    out.push({
      jids: Array.isArray(g.jids) ? g.jids.filter((j): j is string => typeof j === 'string') : [],
      phone: typeof g.phone === 'string' ? g.phone : '',
      label: typeof g.label === 'string' ? g.label : '',
      reason: typeof g.reason === 'string' ? g.reason : '',
      expiresAt: typeof g.expiresAt === 'string' ? g.expiresAt : '',
      approvedAt: typeof g.approvedAt === 'string' ? g.approvedAt : '',
      requestId: typeof g.requestId === 'string' ? g.requestId : '',
      ...(typeof g.approvedBy === 'string' ? { approvedBy: g.approvedBy } : {}),
    })
  }
  return out
}

function grantsOf(access: ContactAccessView): TemporaryGrant[] {
  return Array.isArray(access.temporaryAllow) ? access.temporaryAllow : []
}

export function isGrantExpired(grant: TemporaryGrant, nowMs: number): boolean {
  const t = Date.parse(grant.expiresAt)
  return !Number.isFinite(t) || t <= nowMs
}

export function computeGrantExpiry(approvedAtMs: number, days: number): number {
  return approvedAtMs + days * DAY_MS
}

export function activeGrants(access: ContactAccessView, nowMs: number): TemporaryGrant[] {
  return grantsOf(access).filter((g) => !isGrantExpired(g, nowMs))
}

export function hasExpiredGrant(access: ContactAccessView, nowMs: number): boolean {
  return grantsOf(access).some((g) => isGrantExpired(g, nowMs))
}

/** Every JID that is in allowFrom because of a grant (expired or not). */
function temporaryJidSet(access: ContactAccessView): Set<string> {
  return new Set(grantsOf(access).flatMap((g) => g.jids))
}

export function findActiveGrantForPhone(access: ContactAccessView, digits: string, nowMs: number): TemporaryGrant | null {
  return activeGrants(access, nowMs).find((g) => phoneDigits(g.phone) === digits) ?? null
}

export type TargetVerdict =
  | { kind: 'ok'; activeGrant: TemporaryGrant | null }
  | { kind: 'invalid' }
  | { kind: 'is_self' }
  | { kind: 'is_owner' }
  | { kind: 'already_allowed'; jid: string }

/**
 * May this person (given as their PN JID and, when known, LID JID) receive a
 * temporary grant? Checked when the agent files the request AND again, against
 * a fresh access.json, when the owner approves.
 */
export function evaluateRequestTarget(
  access: ContactAccessView,
  jids: Array<string | null | undefined>,
  digits: string,
  isBot: (jid: string) => boolean,
  nowMs: number,
): TargetVerdict {
  const cand = [...new Set(jids.filter((j): j is string => typeof j === 'string' && j.length > 0))]
  if (cand.length === 0 || cand.some((j) => !isUserJid(j))) return { kind: 'invalid' }
  if (cand.some((j) => isBot(j))) return { kind: 'is_self' }
  if (cand.some((j) => access.ownerJids.includes(j))) return { kind: 'is_owner' }
  const temp = temporaryJidSet(access)
  const permanent = cand.find((j) => access.allowFrom.includes(j) && !temp.has(j))
  if (permanent) return { kind: 'already_allowed', jid: permanent }
  const activeGrant =
    activeGrants(access, nowMs).find((g) => phoneDigits(g.phone) === digits || g.jids.some((j) => cand.includes(j))) ?? null
  return { kind: 'ok', activeGrant }
}

export type ApplyGrantResult<T> =
  | { ok: true; access: T; grant: TemporaryGrant; added: string[] }
  | { ok: false; reason: 'no_grantable_jids' }

/**
 * Record an approved grant. Only user JIDs that are not owners, not the bot,
 * and not already PERMANENTLY allowed are granted (so the expiry sweep can never
 * remove a permanent entry). An existing grant for the same phone is replaced
 * and its JIDs carried over, so nothing is orphaned in allowFrom.
 */
export function applyGrant<T extends ContactAccessView>(
  access: T,
  grant: TemporaryGrant,
  isBot: (jid: string) => boolean,
): ApplyGrantResult<T> {
  const temp = temporaryJidSet(access)
  const grantable = (j: string) =>
    isUserJid(j) && !isBot(j) && !access.ownerJids.includes(j) && !(access.allowFrom.includes(j) && !temp.has(j))
  const jids = [...new Set(grant.jids)].filter(grantable)
  if (jids.length === 0) return { ok: false, reason: 'no_grantable_jids' }

  const digits = phoneDigits(grant.phone)
  const carried = new Set(jids)
  const others: TemporaryGrant[] = []
  for (const g of grantsOf(access)) {
    if (phoneDigits(g.phone) === digits || g.jids.some((j) => carried.has(j))) {
      for (const j of g.jids) if (grantable(j)) carried.add(j)
      continue
    }
    others.push(g)
  }
  const finalGrant: TemporaryGrant = { ...grant, jids: [...carried] }
  const allowFrom = [...access.allowFrom]
  const added: string[] = []
  for (const j of finalGrant.jids) {
    if (!allowFrom.includes(j)) {
      allowFrom.push(j)
      added.push(j)
    }
  }
  return { ok: true, access: { ...access, allowFrom, temporaryAllow: [...others, finalGrant] }, grant: finalGrant, added }
}

export interface RemoveGrantsResult<T> {
  access: T
  removed: TemporaryGrant[]
}

/**
 * Remove the grants matching `pred` and take THEIR JIDs out of allowFrom —
 * never a JID still covered by a remaining grant, never an owner JID, never
 * anything that isn't a 1:1 user JID. Permanent entries are never touched
 * (they are by construction not listed in any grant).
 */
function removeGrantsWhere<T extends ContactAccessView>(access: T, pred: (g: TemporaryGrant) => boolean): RemoveGrantsResult<T> {
  const keep: TemporaryGrant[] = []
  const removed: TemporaryGrant[] = []
  for (const g of grantsOf(access)) (pred(g) ? removed : keep).push(g)
  if (removed.length === 0) return { access, removed }
  const stillGranted = new Set(keep.flatMap((g) => g.jids))
  const drop = new Set(
    removed
      .flatMap((g) => g.jids)
      .filter((j) => isUserJid(j) && !stillGranted.has(j) && !access.ownerJids.includes(j)),
  )
  return {
    access: { ...access, allowFrom: access.allowFrom.filter((j) => !drop.has(j)), temporaryAllow: keep },
    removed,
  }
}

export function removeExpiredGrants<T extends ContactAccessView>(access: T, nowMs: number): RemoveGrantsResult<T> {
  return removeGrantsWhere(access, (g) => isGrantExpired(g, nowMs))
}

export function revokeGrantsForPhone<T extends ContactAccessView>(access: T, digits: string): RemoveGrantsResult<T> {
  return removeGrantsWhere(access, (g) => phoneDigits(g.phone) === digits)
}

export function revokeAllGrants<T extends ContactAccessView>(access: T): RemoveGrantsResult<T> {
  return removeGrantsWhere(access, () => true)
}

/**
 * Access view with expired grants already applied, for admit decisions. Makes
 * expiry exact even before the sweep has persisted the cleanup (or if a
 * concurrent write made it defer).
 */
export function withoutExpiredGrantJids<T extends ContactAccessView>(access: T, nowMs: number): T {
  if (!hasExpiredGrant(access, nowMs)) return access
  return removeExpiredGrants(access, nowMs).access
}

/**
 * Inbound fallback for the LID↔phone split. If a 1:1 message arrives from a
 * JID that isn't allowlisted but whose server-asserted alternate JID
 * (Baileys `key.remoteJidAlt`) is part of an ACTIVE grant, the sender is the
 * same person under the other namespace: add it to that grant (and allowFrom)
 * so the approved person gets through whichever JID form they arrive with.
 */
export function bindAltJidToGrant<T extends ContactAccessView>(
  access: T,
  opts: { senderId: string; chatId: string; altJid: string | null | undefined; senderIsBot: boolean; nowMs: number },
): { access: T; grant: TemporaryGrant | null } {
  const none = { access, grant: null }
  const { senderId, chatId } = opts
  const altJid = normalizeUserJid(opts.altJid)
  if (!altJid || senderId !== chatId || !isUserJid(senderId) || senderId === altJid) return none
  if (jidNamespace(senderId) === jidNamespace(altJid)) return none
  if (opts.senderIsBot) return none
  if (access.allowFrom.includes(senderId) || access.ownerJids.includes(senderId)) return none
  const grants = [...grantsOf(access)]
  const idx = grants.findIndex((g) => !isGrantExpired(g, opts.nowMs) && g.jids.includes(altJid))
  if (idx < 0) return none
  const updated: TemporaryGrant = { ...grants[idx], jids: [...grants[idx].jids, senderId] }
  grants[idx] = updated
  return { access: { ...access, allowFrom: [...access.allowFrom, senderId], temporaryAllow: grants }, grant: updated }
}

// ---------------------------------------------------------------------------
// Who may decide (approve / deny / run `!access contact-requests …`)
// ---------------------------------------------------------------------------
export interface OwnerActionContext {
  /** LIVE ownerJids (freshly loaded access.json), never a send-time snapshot. */
  ownerJids: string[]
  senderId: string
  chatId: string
  /** Baileys `key.fromMe`. Anything the bot itself sent can never decide. */
  fromMe: boolean
  /** Sender resolves to the bot's own account (PN or LID form). */
  senderIsBot: boolean
  /** False until the connection captured the bot's own JID → fail closed. */
  botIdentityKnown: boolean
  /** ownerJids contains the bot's own account (self-chat setup) → fail closed:
   *  in that setup the agent's own reactions/messages are indistinguishable
   *  from the owner's, so WhatsApp-side approval is refused outright. */
  ownerListIncludesBot: boolean
}

export type OwnerActionRefusal =
  | 'from_me'
  | 'not_dm'
  | 'bot_identity_unknown'
  | 'sender_is_bot'
  | 'self_chat_owner'
  | 'not_owner'

export type OwnerActionVerdict = { ok: true } | { ok: false; reason: OwnerActionRefusal }

export function authorizeOwnerAction(ctx: OwnerActionContext): OwnerActionVerdict {
  if (ctx.fromMe) return { ok: false, reason: 'from_me' }
  // Strict 1:1 DM: the chat is a user JID and the sender IS that chat. Rejects
  // groups, status@broadcast, newsletters, and any participant-in-DM oddity.
  if (!isUserJid(ctx.chatId) || ctx.senderId !== ctx.chatId) return { ok: false, reason: 'not_dm' }
  if (!ctx.botIdentityKnown) return { ok: false, reason: 'bot_identity_unknown' }
  if (ctx.senderIsBot) return { ok: false, reason: 'sender_is_bot' }
  if (ctx.ownerListIncludesBot) return { ok: false, reason: 'self_chat_owner' }
  if (!ctx.ownerJids.includes(ctx.senderId)) return { ok: false, reason: 'not_owner' }
  return { ok: true }
}

export function ownerListIncludesBot(ownerJids: string[], isBot: (jid: string) => boolean): boolean {
  return ownerJids.some((j) => isBot(j))
}

/**
 * Owner chats that receive the prompt: 1:1 owner JIDs, never the bot's own
 * account, deduplicated across the @lid / @s.whatsapp.net split so the same
 * human gets one prompt.
 */
export function contactPromptTargets(
  ownerJids: string[],
  isBot: (jid: string) => boolean,
  pnLocalForLid: (lidJid: string) => string | null,
): string[] {
  const users = [...new Set(ownerJids)].filter((j) => isUserJid(j) && !isBot(j))
  const pnLocals = new Set(users.filter((j) => j.endsWith('@s.whatsapp.net')).map(jidLocal))
  return users.filter((j) => {
    if (!j.endsWith('@lid')) return true
    const pn = pnLocalForLid(j)
    return !(pn && pnLocals.has(pn))
  })
}

// ---------------------------------------------------------------------------
// Owner decisions: reactions and text replies
// ---------------------------------------------------------------------------
const APPROVE_EMOJI = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', '✅'])
const DENY_EMOJI = new Set(['👎', '👎🏻', '👎🏼', '👎🏽', '👎🏾', '👎🏿', '❌'])

export type Decision = 'approve' | 'deny'

export function classifyDecisionEmoji(emoji: string): Decision | null {
  if (APPROVE_EMOJI.has(emoji)) return 'approve'
  if (DENY_EMOJI.has(emoji)) return 'deny'
  return null
}

// 6 letters from a–z minus `l` — distinct from Claude Code's 5-letter
// permission ids, and the verbs differ from the relay's yes/no, so the two
// reply parsers can never claim each other's messages.
const REQUEST_ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'
export const REQUEST_ID_LEN = 6
const CONTACT_REPLY_RE = /^\s*(approve|aprobar|aprueba|deny|reject|rechazar|rechaza)\s+([a-km-z]{6})\s*$/i

export function generateRequestId(randomInt: (maxExclusive: number) => number): string {
  let id = ''
  for (let i = 0; i < REQUEST_ID_LEN; i++) id += REQUEST_ID_ALPHABET[randomInt(REQUEST_ID_ALPHABET.length)]
  return id
}

export function parseContactRequestReply(text: string): { requestId: string; decision: Decision } | null {
  const m = typeof text === 'string' ? text.match(CONTACT_REPLY_RE) : null
  if (!m) return null
  const verb = m[1].toLowerCase()
  const decision: Decision = verb === 'approve' || verb === 'aprobar' || verb === 'aprueba' ? 'approve' : 'deny'
  return { requestId: m[2].toLowerCase(), decision }
}

// ---------------------------------------------------------------------------
// Pending requests (in memory) + rate limiting
// ---------------------------------------------------------------------------
export interface PendingContactRequest {
  id: string
  digits: string
  /** E.164 with leading "+". */
  phone: string
  label: string
  reason: string
  days: number
  locale: Locale
  createdAt: number
  expiresAt: number
  promptMessageIds: string[]
  /** LID resolved when the request was filed (null = re-resolve on approval). */
  lidJid: string | null
}

export interface NewContactRequest {
  digits: string
  label: string
  reason: string
  days: number
  locale: Locale
  lidJid: string | null
}

export interface RegistryLimits {
  maxPending: number
  maxPerWindow: number
  windowMs: number
  ttlMs: number
}

export const DEFAULT_REGISTRY_LIMITS: RegistryLimits = {
  maxPending: MAX_PENDING_REQUESTS,
  maxPerWindow: MAX_REQUESTS_PER_WINDOW,
  windowMs: RATE_WINDOW_MS,
  ttlMs: REQUEST_TTL_MS,
}

export type CreateCheck =
  | { ok: true }
  | { ok: false; reason: 'too_many_pending' | 'rate_limited'; retryAfterMs: number }

export type ResolvedOutcome = 'approved' | 'denied' | 'expired' | 'cancelled' | 'refused' | 'already_allowed'

export interface ResolvedRequestInfo {
  requestId: string
  digits: string
  outcome: ResolvedOutcome
}

const RESOLVED_MEMORY_LIMIT = 200

/**
 * In-memory pending requests (lost on restart by design), the prompt-message-id
 * → request map used to match owner reactions, the rolling rate limit, and the
 * set of plugin-authored prompt ids the agent may not react to / edit / delete.
 * Time is always passed in, so the class is deterministic under test.
 */
export class ContactRequestRegistry {
  private readonly pending = new Map<string, PendingContactRequest>()
  private readonly byPromptId = new Map<string, string>()
  private readonly deciding = new Set<string>()
  private readonly createdTimes: number[] = []
  private readonly protectedOrder: string[] = []
  private readonly protectedSet = new Set<string>()
  /** Recently resolved requests, by request id and by prompt message id, so a
   *  late reaction/reply (e.g. 👍 changed to 👎 after approval) gets an
   *  explicit answer instead of silently doing nothing. Bounded. */
  private readonly resolvedById = new Map<string, ResolvedRequestInfo>()
  private readonly resolvedByPromptId = new Map<string, string>()
  private readonly limits: RegistryLimits

  constructor(limits: Partial<RegistryLimits> = {}) {
    this.limits = { ...DEFAULT_REGISTRY_LIMITS, ...limits }
  }

  private pruneWindow(nowMs: number): void {
    while (this.createdTimes.length > 0 && nowMs - this.createdTimes[0] >= this.limits.windowMs) {
      this.createdTimes.shift()
    }
  }

  list(nowMs: number): PendingContactRequest[] {
    return [...this.pending.values()].filter((r) => r.expiresAt > nowMs)
  }

  checkCanCreate(nowMs: number): CreateCheck {
    this.pruneWindow(nowMs)
    const live = this.list(nowMs)
    if (live.length >= this.limits.maxPending) {
      const soonest = Math.min(...live.map((r) => r.expiresAt))
      return { ok: false, reason: 'too_many_pending', retryAfterMs: Math.max(0, soonest - nowMs) }
    }
    if (this.createdTimes.length >= this.limits.maxPerWindow) {
      return { ok: false, reason: 'rate_limited', retryAfterMs: Math.max(0, this.createdTimes[0] + this.limits.windowMs - nowMs) }
    }
    return { ok: true }
  }

  findPendingByDigits(digits: string, nowMs: number): PendingContactRequest | undefined {
    return this.list(nowMs).find((r) => r.digits === digits)
  }

  create(input: NewContactRequest, nowMs: number, nextId: () => string): PendingContactRequest {
    const check = this.checkCanCreate(nowMs)
    if (check.ok === false) throw new Error(check.reason)
    let id = nextId()
    for (let i = 0; i < 20 && this.pending.has(id); i++) id = nextId()
    if (this.pending.has(id)) throw new Error('could not allocate a unique request id')
    const req: PendingContactRequest = {
      id,
      digits: input.digits,
      phone: `+${input.digits}`,
      label: input.label,
      reason: input.reason,
      days: input.days,
      locale: input.locale,
      createdAt: nowMs,
      expiresAt: nowMs + this.limits.ttlMs,
      promptMessageIds: [],
      lidJid: input.lidJid,
    }
    this.pending.set(id, req)
    this.createdTimes.push(nowMs)
    return req
  }

  /** Record a plugin-sent prompt message for this request. Only ids passed
   *  here (i.e. returned by the plugin's own sendMessage) can ever map a
   *  reaction to a request. */
  attachPrompt(id: string, messageId: string): void {
    const req = this.pending.get(id)
    if (!req || !messageId) return
    req.promptMessageIds.push(messageId)
    this.byPromptId.set(messageId, id)
    if (!this.protectedSet.has(messageId)) {
      this.protectedSet.add(messageId)
      this.protectedOrder.push(messageId)
      while (this.protectedOrder.length > PROTECTED_PROMPT_LIMIT) {
        const old = this.protectedOrder.shift()
        if (old !== undefined) this.protectedSet.delete(old)
      }
    }
  }

  /** True for any prompt the plugin sent (pending, resolved or expired). */
  isProtectedPromptId(messageId: unknown): boolean {
    return typeof messageId === 'string' && this.protectedSet.has(messageId)
  }

  /** Is this message id one of our prompts for a request still awaiting a decision? */
  isLivePromptId(messageId: string, nowMs: number): boolean {
    const id = this.byPromptId.get(messageId)
    return !!id && !!this.get(id, nowMs)
  }

  get(id: string, nowMs: number): PendingContactRequest | undefined {
    const r = this.pending.get(id)
    return r && r.expiresAt > nowMs ? r : undefined
  }

  getByPromptId(messageId: string, nowMs: number): PendingContactRequest | undefined {
    const id = this.byPromptId.get(messageId)
    return id ? this.get(id, nowMs) : undefined
  }

  /** Claim a request for a decision. Returns undefined if it is unknown,
   *  expired, or another decision is already in flight (first one wins). */
  beginDecision(id: string, nowMs: number): PendingContactRequest | undefined {
    const r = this.get(id, nowMs)
    if (!r || this.deciding.has(id)) return undefined
    this.deciding.add(id)
    return r
  }

  /** Release a claim without resolving (e.g. a write must be retried). */
  abortDecision(id: string): void {
    this.deciding.delete(id)
  }

  isDeciding(id: string): boolean {
    return this.deciding.has(id)
  }

  /** Remove a request (resolved / cancelled / revoked) and remember how it
   *  ended. Its prompt ids stay protected. */
  take(id: string, outcome?: ResolvedOutcome): PendingContactRequest | undefined {
    const r = this.pending.get(id)
    if (!r) return undefined
    this.pending.delete(id)
    this.deciding.delete(id)
    for (const mid of r.promptMessageIds) this.byPromptId.delete(mid)
    if (outcome) this.rememberResolved(r, outcome)
    return r
  }

  private rememberResolved(r: PendingContactRequest, outcome: ResolvedOutcome): void {
    this.resolvedById.set(r.id, { requestId: r.id, digits: r.digits, outcome })
    for (const mid of r.promptMessageIds) this.resolvedByPromptId.set(mid, r.id)
    while (this.resolvedById.size > RESOLVED_MEMORY_LIMIT) {
      const oldest = this.resolvedById.keys().next().value
      if (oldest === undefined) break
      this.resolvedById.delete(oldest)
    }
    while (this.resolvedByPromptId.size > RESOLVED_MEMORY_LIMIT * 4) {
      const oldest = this.resolvedByPromptId.keys().next().value
      if (oldest === undefined) break
      this.resolvedByPromptId.delete(oldest)
    }
  }

  resolvedInfo(requestId: string): ResolvedRequestInfo | undefined {
    return this.resolvedById.get(requestId)
  }

  resolvedInfoByPromptId(messageId: string): ResolvedRequestInfo | undefined {
    const id = this.resolvedByPromptId.get(messageId)
    return id ? this.resolvedById.get(id) : undefined
  }

  /** Undo a create whose prompt reached no owner; it does not count toward the rate limit. */
  discard(id: string): void {
    const r = this.take(id)
    if (!r) return
    const i = this.createdTimes.lastIndexOf(r.createdAt)
    if (i >= 0) this.createdTimes.splice(i, 1)
  }

  /** Remove and return every request past its 24 h validity. */
  sweepExpired(nowMs: number): PendingContactRequest[] {
    const out: PendingContactRequest[] = []
    for (const r of [...this.pending.values()]) {
      if (r.expiresAt <= nowMs && !this.deciding.has(r.id)) {
        this.take(r.id, 'expired')
        out.push(r)
      }
    }
    return out
  }

  takeAll(outcome?: ResolvedOutcome): PendingContactRequest[] {
    return [...this.pending.keys()].map((id) => this.take(id, outcome)).filter((r): r is PendingContactRequest => !!r)
  }
}

// ---------------------------------------------------------------------------
// Inbound routing: is this reaction / reply an authorized owner decision?
// ---------------------------------------------------------------------------
// server.ts calls these for every admitted 1:1 inbound (after the
// `if (msg.key.fromMe) continue` filter, with fromMe passed again for defense
// in depth) and executes the returned action. Only a `decide` action can ever
// lead to a grant, and it is produced only for an authorized owner acting on a
// prompt id that the plugin itself recorded via attachPrompt().

export type InboundRoute =
  /** Not a contact-request control message — continue normal processing. */
  | { kind: 'pass' }
  /** A control message we swallow without acting (unauthorized, in flight…). */
  | { kind: 'consume'; why: string }
  /** Swallow and tell the (authorized or config-refused) owner something. */
  | { kind: 'reply'; text: string; why: string }
  /** Claimed via beginDecision(): the caller MUST take() or abortDecision(). */
  | { kind: 'decide'; request: PendingContactRequest; decision: Decision }

export interface RouteContext extends OwnerActionContext {
  nowMs: number
  locale: Locale
}

/** Reply text for an owner-action refusal, or null to stay silent (never
 *  answer the bot itself, a non-DM chat, or a non-owner probing the flow). */
export function renderOwnerActionRefusal(locale: Locale, reason: OwnerActionRefusal): string | null {
  if (reason === 'self_chat_owner') return renderDecisionNotice(locale, 'self_chat_owner', '', '')
  if (reason === 'bot_identity_unknown') return renderDecisionNotice(locale, 'not_ready', '', '')
  return null
}

function refusalRoute(reason: OwnerActionRefusal, locale: Locale): InboundRoute {
  const text = renderOwnerActionRefusal(locale, reason)
  return text ? { kind: 'reply', text, why: reason } : { kind: 'consume', why: reason }
}

export function routeContactReaction(
  reg: ContactRequestRegistry,
  emoji: string,
  reactedToMessageId: string,
  ctx: RouteContext,
): InboundRoute {
  // Only reactions on a prompt the plugin itself sent are ours. The agent
  // cannot add ids to this set (attachPrompt is only fed sendMessage results).
  if (!reactedToMessageId || !reg.isProtectedPromptId(reactedToMessageId)) return { kind: 'pass' }
  const auth = authorizeOwnerAction(ctx)
  if (auth.ok === false) return refusalRoute(auth.reason, ctx.locale)
  const decision = classifyDecisionEmoji(emoji)
  if (!decision) return { kind: 'consume', why: 'not_a_decision_emoji' }
  const req = reg.getByPromptId(reactedToMessageId, ctx.nowMs)
  if (!req) {
    const info = reg.resolvedInfoByPromptId(reactedToMessageId)
    return info
      ? { kind: 'reply', text: renderAlreadyResolved(ctx.locale, info), why: 'already_resolved' }
      : { kind: 'consume', why: 'no_pending_request' }
  }
  const claimed = reg.beginDecision(req.id, ctx.nowMs)
  if (!claimed) return { kind: 'consume', why: 'decision_in_flight' }
  return { kind: 'decide', request: claimed, decision }
}

export function routeContactReplyText(reg: ContactRequestRegistry, text: string, ctx: RouteContext): InboundRoute {
  const parsed = parseContactRequestReply(text)
  if (!parsed) return { kind: 'pass' }
  const req = reg.get(parsed.requestId, ctx.nowMs)
  const resolved = req ? undefined : reg.resolvedInfo(parsed.requestId)
  // An id we never issued is just ordinary text for the agent.
  if (!req && !resolved) return { kind: 'pass' }
  const auth = authorizeOwnerAction(ctx)
  if (auth.ok === false) return refusalRoute(auth.reason, ctx.locale)
  if (!req) return { kind: 'reply', text: renderAlreadyResolved(ctx.locale, resolved!), why: 'already_resolved' }
  const claimed = reg.beginDecision(req.id, ctx.nowMs)
  if (!claimed) return { kind: 'consume', why: 'decision_in_flight' }
  return { kind: 'decide', request: claimed, decision: parsed.decision }
}

export type ApprovalPlan<T> =
  | { kind: 'apply'; access: T; grant: TemporaryGrant }
  | { kind: 'refuse'; notice: 'refused_owner' | 'refused_self' | 'refused_invalid'; detail: string }
  | { kind: 'already_allowed' }

/**
 * What approving `req` does to a FRESH access snapshot. Re-validates the target
 * (it may have become an owner or been allowlisted since the request), never
 * shortens an existing grant, and builds the grant via applyGrant().
 */
export function planApproval<T extends ContactAccessView>(
  access: T,
  req: PendingContactRequest,
  lidJid: string | null,
  isBot: (jid: string) => boolean,
  nowMs: number,
  approvedBy: string,
): ApprovalPlan<T> {
  const pn = pnJidForDigits(req.digits)
  const lidNorm = normalizeUserJid(lidJid)
  const lid = lidNorm && lidNorm.endsWith('@lid') ? lidNorm : null
  const verdict = evaluateRequestTarget(access, [pn, lid], req.digits, isBot, nowMs)
  switch (verdict.kind) {
    case 'invalid':
      return { kind: 'refuse', notice: 'refused_invalid', detail: 'no valid WhatsApp JID for this number' }
    case 'is_self':
      return { kind: 'refuse', notice: 'refused_self', detail: "the number is the bot's own account" }
    case 'is_owner':
      return { kind: 'refuse', notice: 'refused_owner', detail: 'the number belongs to an owner' }
    case 'already_allowed':
      return { kind: 'already_allowed' }
  }
  const base = computeGrantExpiry(nowMs, req.days)
  const current = verdict.activeGrant ? Date.parse(verdict.activeGrant.expiresAt) : NaN
  const expiresAtMs = Number.isFinite(current) ? Math.max(base, current) : base
  const applied = applyGrant(
    access,
    {
      jids: [pn, ...(lid ? [lid] : [])],
      phone: req.phone,
      label: sanitizeUntrustedText(req.label, LABEL_MAX_LEN),
      reason: sanitizeUntrustedText(req.reason, REASON_MAX_LEN),
      expiresAt: new Date(expiresAtMs).toISOString(),
      approvedAt: new Date(nowMs).toISOString(),
      requestId: req.id,
      approvedBy,
    },
    isBot,
  )
  if (applied.ok === false) return { kind: 'refuse', notice: 'refused_invalid', detail: 'no grantable JID for this number' }
  return { kind: 'apply', access: applied.access, grant: applied.grant }
}

// ---------------------------------------------------------------------------
// `!access contact-requests …` (owner DM) — parser
// ---------------------------------------------------------------------------
export type ContactRequestsCommand =
  | { kind: 'status' }
  | { kind: 'list' }
  | { kind: 'on'; locale?: Locale }
  | { kind: 'off' }
  | { kind: 'revoke'; digits: string }
  | { kind: 'revoke-all' }
  | { kind: 'invalid'; reason: string }

/** `!access contact-requests …` (any case; the singular `contact-request` is
 *  accepted so a typo doesn't fall through to the dm-mutations handler and
 *  suggest enabling that broader feature). Checked inside the reserved
 *  `!access` namespace, which is consumed regardless. */
export function isContactRequestsCommandText(text: string): boolean {
  const m = /^!access\s+(\S+)/.exec(typeof text === 'string' ? text : '')
  if (!m) return false
  const sub = m[1].toLowerCase()
  return sub === 'contact-requests' || sub === 'contact-request'
}

export function parseContactRequestsCommand(text: string): ContactRequestsCommand | null {
  if (!isContactRequestsCommandText(text)) return null
  if (text.length > MAX_COMMAND_LEN) return { kind: 'invalid', reason: 'Command too long.' }
  if (/[\r\n]/.test(text)) return { kind: 'invalid', reason: 'Command must be a single line.' }
  const parts = text.trim().split(/\s+/)
  const sub = (parts[2] ?? '').toLowerCase()
  const args = parts.slice(3)
  const noArgs = (cmd: ContactRequestsCommand): ContactRequestsCommand =>
    args.length ? { kind: 'invalid', reason: `${sub || 'status'} takes no arguments.` } : cmd

  switch (sub) {
    case '':
    case 'status':
      return noArgs({ kind: 'status' })
    case 'list':
      return noArgs({ kind: 'list' })
    case 'off':
      return noArgs({ kind: 'off' })
    case 'on': {
      if (args.length === 0) return { kind: 'on' }
      const l = args.length === 1 ? args[0].toLowerCase() : ''
      if (l === 'en' || l === 'es') return { kind: 'on', locale: l }
      return { kind: 'invalid', reason: 'on takes an optional language: en or es.' }
    }
    case 'revoke': {
      if (args.length === 0) return { kind: 'invalid', reason: 'revoke takes a phone number (or "all").' }
      if (args.length === 1 && args[0].toLowerCase() === 'all') return { kind: 'revoke-all' }
      const phone = normalizePhone(args.join(' '))
      if (phone.ok === false) return { kind: 'invalid', reason: phone.error }
      return { kind: 'revoke', digits: phone.digits }
    }
    default:
      return { kind: 'invalid', reason: `Unknown contact-requests subcommand: ${sub.slice(0, 32)}` }
  }
}

// ---------------------------------------------------------------------------
// Rendering (plugin-authored text only — agent text always re-sanitized)
// ---------------------------------------------------------------------------
const MONTHS: Record<Locale, string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
}

/** "21-nov 11:05" (host local time). */
export function formatShortDateTime(d: Date, locale: Locale): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()}-${MONTHS[locale][d.getMonth()]} ${hh}:${mm}`
}

function quoteLabel(label: string, locale: Locale): string {
  const safe = sanitizeUntrustedText(label, LABEL_MAX_LEN)
  return locale === 'es' ? `«${safe}»` : `"${safe}"`
}

function daysWord(days: number, locale: Locale): string {
  if (locale === 'es') return days === 1 ? '1 día' : `${days} días`
  return days === 1 ? '1 day' : `${days} days`
}

export interface PromptInput {
  digits: string
  label: string
  reason: string
  days: number
  requestId: string
  ttlHours: number
  /** Set when the person already holds an active grant (this would extend it). */
  currentExpiry?: Date | null
}

/** The owner-facing approval prompt. The phone shown is derived from the
 *  normalized digits; the label is quoted as context only. */
export function renderRequestPrompt(locale: Locale, p: PromptInput): string {
  const phone = formatPhoneDisplay(p.digits)
  const reason = sanitizeUntrustedText(p.reason, REASON_MAX_LEN)
  const label = quoteLabel(p.label, locale)
  if (locale === 'es') {
    return [
      '🔐 *Solicitud de acceso*',
      `Habilitar a *${phone}* (${label}) por ${daysWord(p.days, locale)}.`,
      ...(p.currentExpiry ? [`Ya tiene acceso temporal hasta ${formatShortDateTime(p.currentExpiry, locale)}.`] : []),
      `Motivo: ${reason}`,
      `Reacciona 👍 para aprobar o 👎 para rechazar. Vence en ${p.ttlHours} h.`,
      `O responde *aprobar ${p.requestId}* / *rechazar ${p.requestId}*.`,
    ].join('\n')
  }
  return [
    '🔐 *Access request*',
    `Allow *${phone}* (${label}) to message me for ${daysWord(p.days, locale)}.`,
    ...(p.currentExpiry ? [`Already has temporary access until ${formatShortDateTime(p.currentExpiry, locale)}.`] : []),
    `Reason: ${reason}`,
    `React 👍 to approve or 👎 to deny. Expires in ${p.ttlHours} h.`,
    `Or reply *approve ${p.requestId}* / *deny ${p.requestId}*.`,
  ].join('\n')
}

export function renderApprovedConfirmation(locale: Locale, digits: string, label: string, expiresAt: Date): string {
  const phone = formatPhoneDisplay(digits)
  return locale === 'es'
    ? `✅ Habilitado *${phone}* (${quoteLabel(label, locale)}) hasta ${formatShortDateTime(expiresAt, locale)}.`
    : `✅ Enabled *${phone}* (${quoteLabel(label, locale)}) until ${formatShortDateTime(expiresAt, locale)}.`
}

export function renderDeniedConfirmation(locale: Locale, digits: string, label: string): string {
  const phone = formatPhoneDisplay(digits)
  return locale === 'es'
    ? `❌ Rechazado: *${phone}* (${quoteLabel(label, locale)}) no fue habilitado.`
    : `❌ Denied: *${phone}* (${quoteLabel(label, locale)}) was not enabled.`
}

export type DecisionNotice =
  | 'already_allowed'
  | 'refused_owner'
  | 'refused_self'
  | 'refused_invalid'
  | 'disabled'
  | 'retry'
  | 'self_chat_owner'
  | 'not_ready'

export function renderDecisionNotice(locale: Locale, notice: DecisionNotice, digits: string, requestId: string): string {
  const phone = formatPhoneDisplay(digits)
  const es = locale === 'es'
  switch (notice) {
    case 'already_allowed':
      return es
        ? `ℹ️ *${phone}* ya tenía acceso permanente; no hice cambios (solicitud ${requestId}).`
        : `ℹ️ *${phone}* already had permanent access; nothing changed (request ${requestId}).`
    case 'refused_owner':
      return es
        ? `⚠️ No apliqué la solicitud ${requestId}: *${phone}* es un dueño.`
        : `⚠️ Request ${requestId} not applied: *${phone}* is an owner.`
    case 'refused_self':
      return es
        ? `⚠️ No apliqué la solicitud ${requestId}: *${phone}* es la cuenta del propio bot.`
        : `⚠️ Request ${requestId} not applied: *${phone}* is the bot's own account.`
    case 'refused_invalid':
      return es
        ? `⚠️ No apliqué la solicitud ${requestId}: no hay un JID válido para *${phone}*.`
        : `⚠️ Request ${requestId} not applied: no valid JID for *${phone}*.`
    case 'disabled':
      return es
        ? `🔒 Las solicitudes de contacto están desactivadas; descarté la solicitud ${requestId}.`
        : `🔒 Contact requests are turned off; request ${requestId} was discarded.`
    case 'retry':
      return es
        ? `⚠️ No pude guardar el cambio (había otro cambio en curso, p. ej. desde la terminal). Vuelve a reaccionar 👍 o responde *aprobar ${requestId}*.`
        : `⚠️ Couldn't save the change (another change was in progress, e.g. from the terminal). React 👍 again or reply *approve ${requestId}*.`
    case 'self_chat_owner':
      return es
        ? '🔒 No puedo aceptar decisiones de acceso por WhatsApp: la lista de dueños incluye la cuenta del propio bot (configuración de auto-chat), así que no puedo distinguir tus mensajes de los del agente. Usa un número de dueño distinto o la terminal.'
        : "🔒 I can't accept access decisions over WhatsApp: the owner list includes the bot's own account (self-chat setup), so your messages can't be told apart from the agent's. Use a separate owner number or the terminal."
    case 'not_ready':
      return es
        ? '⏳ Aún no termino de conectarme; vuelve a intentarlo en unos segundos.'
        : "⏳ I'm still connecting; try again in a few seconds."
  }
}

const OUTCOME_WORD: Record<Locale, Record<ResolvedOutcome, string>> = {
  en: { approved: 'approved', denied: 'denied', expired: 'expired', cancelled: 'cancelled', refused: 'not applied', already_allowed: 'not needed' },
  es: { approved: 'aprobada', denied: 'rechazada', expired: 'vencida', cancelled: 'cancelada', refused: 'no aplicada', already_allowed: 'innecesaria' },
}

/** Answer to a reaction/reply on a request that is no longer pending — so a
 *  👍 changed to 👎 after approval never looks like it revoked anything. */
export function renderAlreadyResolved(locale: Locale, info: ResolvedRequestInfo): string {
  const word = OUTCOME_WORD[locale][info.outcome]
  const revokeHint = info.outcome === 'approved'
    ? (locale === 'es'
        ? ` Para quitar el acceso: *!access contact-requests revoke +${info.digits}*`
        : ` To remove the access: *!access contact-requests revoke +${info.digits}*`)
    : ''
  return locale === 'es'
    ? `ℹ️ La solicitud ${info.requestId} ya estaba resuelta (${word}); no hice cambios.${revokeHint}`
    : `ℹ️ Request ${info.requestId} was already resolved (${word}); nothing changed.${revokeHint}`
}

const USAGE: Record<Locale, string> = {
  en: 'Usage: *!access contact-requests on [en|es]* | *off* | *status* | *list* | *revoke <phone|all>*',
  es: 'Uso: *!access contact-requests on [en|es]* | *off* | *status* | *list* | *revoke <número|all>*',
}

export function renderConcurrentChange(locale: Locale): string {
  return locale === 'es'
    ? '⚠️ Había otro cambio en curso (p. ej. desde la terminal); no apliqué nada para no pisarlo. Reenvía el comando.'
    : "⚠️ Another change was in progress (e.g. from the terminal); I didn't apply anything to avoid overwriting it. Please resend."
}

export function renderCommandInvalid(locale: Locale, reason: string): string {
  return `⚠️ ${sanitizeUntrustedText(reason, 200)}\n${USAGE[locale]}`
}

/** Sent (instead of silence) when a refused sender's server-asserted LID↔PN
 *  mapping shows it is an owner's OTHER JID form. Grants nothing: identity
 *  stays exact-JID; the owner adds this form from the terminal. */
export function renderOwnerAltFormHint(locale: Locale, senderId: string): string {
  return locale === 'es'
    ? `🔒 Este chat te identifica como ${senderId}, que no está en la lista de dueños (tu otra forma de JID sí lo está). Ejecuta */whatsapp:access set-owner ${senderId}* en la terminal y vuelve a intentarlo.`
    : `🔒 This chat identifies you as ${senderId}, which is not in the owner list (your other JID form is). Run */whatsapp:access set-owner ${senderId}* in the terminal and try again.`
}

export function renderNotOwner(locale: Locale, senderId: string): string {
  return locale === 'es'
    ? `🔒 Los comandos de acceso son solo para el dueño. Este chat (${senderId}) no está registrado como dueño.`
    : `🔒 Access commands are owner-only. This chat (${senderId}) is not registered as an owner.`
}

export function renderContactRequestsStatus(
  locale: Locale,
  cfg: ContactRequestsConfig,
  activeCount: number,
  pendingCount: number,
): string {
  if (locale === 'es') {
    return [
      `📋 *Solicitudes de contacto:* ${cfg.enabled ? 'ACTIVADAS' : 'DESACTIVADAS'} (${cfg.locale})`,
      `Duración: ${daysWord(cfg.defaultDays, 'es')} por defecto, máximo ${daysWord(cfg.maxDays, 'es')}`,
      `Accesos temporales vigentes: ${activeCount} · Pendientes: ${pendingCount}`,
    ].join('\n')
  }
  return [
    `📋 *Contact requests:* ${cfg.enabled ? 'ON' : 'OFF'} (${cfg.locale})`,
    `Duration: ${daysWord(cfg.defaultDays, 'en')} by default, max ${daysWord(cfg.maxDays, 'en')}`,
    `Active temporary grants: ${activeCount} · Pending: ${pendingCount}`,
  ].join('\n')
}

export function renderContactRequestsList(
  locale: Locale,
  grants: TemporaryGrant[],
  pending: PendingContactRequest[],
): string {
  const es = locale === 'es'
  const grantLine = (g: TemporaryGrant) => {
    const t = Date.parse(g.expiresAt)
    const until = Number.isFinite(t) ? formatShortDateTime(new Date(t), locale) : '?'
    return `• ${formatPhoneDisplay(phoneDigits(g.phone))} (${quoteLabel(g.label, locale)}) ${es ? 'hasta' : 'until'} ${until}`
  }
  const pendingLine = (r: PendingContactRequest) =>
    `• ${r.id} — ${formatPhoneDisplay(r.digits)} (${quoteLabel(r.label, locale)}), ${daysWord(r.days, locale)}`
  const none = es ? '(ninguno)' : '(none)'
  return [
    es ? '📋 *Accesos temporales*' : '📋 *Temporary grants*',
    ...(grants.length ? grants.map(grantLine) : [none]),
    es ? '*Pendientes*' : '*Pending*',
    ...(pending.length ? pending.map(pendingLine) : [none]),
  ].join('\n')
}

export function renderToggleReply(locale: Locale, enabled: boolean, cfgLocale: Locale, cancelled: number): string {
  if (enabled) {
    return locale === 'es'
      ? `✅ Solicitudes de contacto ACTIVADAS (${cfgLocale}). El agente puede pedir acceso temporal para un número; cada pedido te llega aquí para aprobar o rechazar.`
      : `✅ Contact requests ON (${cfgLocale}). The agent can ask for temporary access for a number; each request comes to you here to approve or deny.`
  }
  return locale === 'es'
    ? `⏸️ Solicitudes de contacto DESACTIVADAS. Cancelé ${cancelled} pendiente(s). Los accesos temporales vigentes siguen hasta que vencen; revócalos con *!access contact-requests revoke <número|all>*.`
    : `⏸️ Contact requests OFF. Cancelled ${cancelled} pending request(s). Active temporary grants stay until they expire; revoke them with *!access contact-requests revoke <phone|all>*.`
}

export function renderRevokeReply(locale: Locale, removed: TemporaryGrant[], digits: string | null, cancelledPending: number): string {
  const es = locale === 'es'
  if (digits !== null) {
    const phone = formatPhoneDisplay(digits)
    if (removed.length === 0 && cancelledPending === 0) {
      return es ? `ℹ️ No hay acceso temporal ni solicitud pendiente para *${phone}*.` : `ℹ️ No temporary grant or pending request for *${phone}*.`
    }
    return es
      ? `✅ Revocado: *${phone}*${removed.length ? ` (${quoteLabel(removed[0].label, locale)})` : ''}.${cancelledPending ? ' Solicitud pendiente cancelada.' : ''}`
      : `✅ Revoked: *${phone}*${removed.length ? ` (${quoteLabel(removed[0].label, locale)})` : ''}.${cancelledPending ? ' Pending request cancelled.' : ''}`
  }
  return es
    ? `✅ Revoqué ${removed.length} acceso(s) temporal(es) y cancelé ${cancelledPending} solicitud(es) pendiente(s).`
    : `✅ Revoked ${removed.length} temporary grant(s) and cancelled ${cancelledPending} pending request(s).`
}

// ---------------------------------------------------------------------------
// Agent-facing notification text (plugin-authored, source "system")
// ---------------------------------------------------------------------------
export type ContactRequestOutcome =
  | 'approved'
  | 'denied'
  | 'expired'
  | 'cancelled'
  | 'refused'
  | 'already_allowed'
  | 'grant_expired'
  | 'grant_revoked'

export interface AgentNoticeData {
  requestId: string
  phone: string
  label?: string
  expiresAt?: string
  detail?: string
}

export function renderAgentNotice(outcome: ContactRequestOutcome, d: AgentNoticeData): string {
  const who = `${d.phone}${d.label ? ` ("${sanitizeUntrustedText(d.label, LABEL_MAX_LEN)}")` : ''}`
  const tail = d.detail ? ` ${d.detail}` : ''
  switch (outcome) {
    case 'approved':
      return `Contact access request ${d.requestId} was APPROVED by the owner. ${who} can now message you in a 1:1 chat until ${d.expiresAt} (temporary; removed automatically when it expires). This does NOT make them an owner.${tail}`
    case 'denied':
      return `Contact access request ${d.requestId} was DENIED by the owner. ${who} was not granted access.${tail}`
    case 'expired':
      return `Contact access request ${d.requestId} EXPIRED after 24 h without an owner decision. ${who} was not granted access.${tail}`
    case 'cancelled':
      return `Contact access request ${d.requestId} was CANCELLED (contact requests were turned off, or the request was revoked). ${who} was not granted access.${tail}`
    case 'refused':
      return `Contact access request ${d.requestId} could not be applied: ${d.detail ?? 'the target is not grantable'}. ${who} was not granted access.`
    case 'already_allowed':
      return `Contact access request ${d.requestId}: ${who} already had permanent access; nothing was changed.${tail}`
    case 'grant_expired':
      return `Temporary access for ${who} (request ${d.requestId}) EXPIRED${d.expiresAt ? ` at ${d.expiresAt}` : ''} and was removed from the allowlist. You can no longer message them unless the owner approves a new request.${tail}`
    case 'grant_revoked':
      return `Temporary access for ${who} (request ${d.requestId}) was REVOKED by the owner and removed from the allowlist.${tail}`
  }
}
