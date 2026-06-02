// ---------------------------------------------------------------------------
// Channel notification meta — single authoritative builder
// ---------------------------------------------------------------------------
// Every `notifications/claude/channel` notification carries identity in its
// `meta`. Identity is JID-based and authoritative: `is_owner` is derived from
// the access snapshot's `ownerJids`, NEVER from a display name. The push name
// is surfaced only as `display_name_unverified` (and a legacy `user` field,
// kept for back-compat) — it is user-controlled and spoofable, so the agent
// must treat it as a hint, not proof. This builder is the one place that
// decides those fields so no emitter can drift, and it is a pure function so
// the identity logic can be unit-tested without standing up the server.

/** Minimal structural view of access.json needed for the owner verdict. */
export interface OwnerView {
  ownerJids: string[]
}

/** Identity keys a caller must never override via `extra` (defense against a
 *  content/meta field accidentally — or maliciously — shadowing the truth). */
export const RESERVED_META_KEYS = new Set<string>([
  'chat_id', 'message_id', 'user', 'user_id', 'is_group', 'is_owner',
  'display_name_unverified', 'ts', 'requestEnvelopeToken', 'source',
])

export interface BuildChannelMetaOptions {
  chatId: string
  messageId: string
  senderId: string
  ts: string
  pushName?: string
  isGroup?: boolean
  /** Access snapshot used to admit this inbound. Owner verdict comes from here. */
  access?: OwnerView | null
  envelopeToken?: string
  /** `'system'` = plugin-authored message (no human sender) → is_owner:false. */
  source?: 'user' | 'system'
  extra?: Record<string, unknown>
}

export function buildChannelMeta(opts: BuildChannelMetaOptions): Record<string, string> {
  const source = opts.source ?? 'user'
  const isGroup = opts.isGroup ?? opts.chatId.endsWith('@g.us')
  const isOwner =
    source === 'system'
      ? false
      : !!opts.access && opts.access.ownerJids.includes(opts.senderId)

  // The host validates params.meta as Record<string,string> (Zod). ANY non-string
  // value (boolean, number, null, object) makes the host reject the ENTIRE
  // notification with a ZodError and silently drop the inbound — the message
  // never reaches the agent. So every value emitted here MUST be a string, and
  // we coerce defensively so no current or future field can re-break delivery.
  const toMetaString = (value: unknown): string | undefined => {
    if (value == null) return undefined
    if (typeof value === 'object' || typeof value === 'function') return undefined
    return String(value)
  }

  // Merge extra FIRST, with reserved identity keys stripped, so the
  // authoritative fields below always win. Coerce every extra value to a string
  // (drop null/undefined/objects) — attachment metadata must not smuggle a
  // non-string value into the notification.
  const safeExtra: Record<string, string> = {}
  if (opts.extra) {
    for (const [k, v] of Object.entries(opts.extra)) {
      if (RESERVED_META_KEYS.has(k)) continue
      const coerced = toMetaString(v)
      if (coerced !== undefined) safeExtra[k] = coerced
    }
  }

  const meta: Record<string, string> = {
    ...safeExtra,
    chat_id: opts.chatId,
    message_id: opts.messageId,
    user_id: opts.senderId, // authoritative JID
    // Legacy field, kept for back-compat. UNVERIFIED display name — not identity.
    user: source === 'system' ? opts.senderId : (opts.pushName ?? opts.senderId),
    // Emitted as the STRINGS "true"/"false": the host's Record<string,string>
    // validator rejects raw booleans. The agent reads these as text attributes
    // (is_owner="true"), so string form is semantically correct.
    is_group: String(isGroup),
    is_owner: String(isOwner), // authoritative — exact JID match against ownerJids
    ts: opts.ts,
    source,
  }
  if (source !== 'system') {
    meta.display_name_unverified = opts.pushName ?? ''
  }
  if (opts.envelopeToken) meta.requestEnvelopeToken = opts.envelopeToken
  return meta
}
