// Unit tests for owner-approved, time-limited contact access requests.
// Imports PURE modules only — never server.ts / bootstrap.mjs (starting the
// server would take over the live WhatsApp session).
//
// Run: node_modules/.bin/tsx --test tests/contact-requests.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizePhone,
  formatPhoneDisplay,
  isUserJid,
  normalizeUserJid,
  sanitizeUntrustedText,
  validateLabel,
  validateReason,
  resolveContactRequestsConfig,
  withContactRequestsEnabled,
  resolveRequestedDays,
  authorizeOwnerAction,
  ownerListIncludesBot,
  contactPromptTargets,
  evaluateRequestTarget,
  applyGrant,
  removeExpiredGrants,
  revokeGrantsForPhone,
  revokeAllGrants,
  withoutExpiredGrantJids,
  hasExpiredGrant,
  bindAltJidToGrant,
  normalizeTemporaryAllow,
  isGrantExpired,
  computeGrantExpiry,
  ContactRequestRegistry,
  classifyDecisionEmoji,
  parseContactRequestReply,
  generateRequestId,
  isContactRequestsCommandText,
  parseContactRequestsCommand,
  routeContactReaction,
  routeContactReplyText,
  planApproval,
  renderRequestPrompt,
  renderApprovedConfirmation,
  renderDeniedConfirmation,
  renderAlreadyResolved,
  renderAgentNotice,
  renderContactRequestsList,
  formatShortDateTime,
  HARD_MAX_DAYS,
  type OwnerActionContext,
  type RouteContext,
  type TemporaryGrant,
  type ContactAccessView,
  type PendingContactRequest,
} from '../contact-requests.ts'
import { parsePermissionReply } from '../lib.ts'
import { parseOwnerDmCommand, isOwnerDmCommandText } from '../access-helpers.ts'
import { buildChannelMeta } from '../channel-meta.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const OWNER_PN = '56911111111@s.whatsapp.net'
const OWNER_LID = '111111111111111@lid'
const BOT_PN = '56900000000@s.whatsapp.net'
const BOT_LID = '900000000000000@lid'
const FRIEND_PN = '56922222222@s.whatsapp.net' // permanently allowlisted, not owner
const DIEGO_DIGITS = '56933333333'
const DIEGO_PN = '56933333333@s.whatsapp.net'
const DIEGO_LID = '333333333333333@lid'
const GROUP = '120363000000000001@g.us'
const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0)

const isBot = (j: string) => j === BOT_PN || j === BOT_LID

function access(patch: Partial<ContactAccessView> = {}): ContactAccessView {
  return {
    dmPolicy: 'allowlist',
    allowFrom: [OWNER_PN, OWNER_LID, FRIEND_PN],
    ownerJids: [OWNER_PN, OWNER_LID],
    temporaryAllow: [],
    ...patch,
  }
}

function ownerCtx(patch: Partial<OwnerActionContext> = {}): OwnerActionContext {
  return {
    ownerJids: [OWNER_PN, OWNER_LID],
    senderId: OWNER_PN,
    chatId: OWNER_PN,
    fromMe: false,
    senderIsBot: false,
    botIdentityKnown: true,
    ownerListIncludesBot: false,
    ...patch,
  }
}

function routeCtx(patch: Partial<RouteContext> = {}): RouteContext {
  return { ...ownerCtx(), nowMs: T0, locale: 'es', ...patch }
}

function grant(patch: Partial<TemporaryGrant> = {}): TemporaryGrant {
  return {
    jids: [DIEGO_PN, DIEGO_LID],
    phone: `+${DIEGO_DIGITS}`,
    label: 'Diego',
    reason: 'test',
    expiresAt: new Date(T0 + 7 * DAY).toISOString(),
    approvedAt: new Date(T0).toISOString(),
    requestId: 'kxqzbt',
    ...patch,
  }
}

let idCounter = 0
const seqId = () => {
  idCounter++
  // deterministic 6-letter ids from the request-id alphabet
  return generateRequestId((n) => (idCounter * 7 + 3) % n).slice(0, 5) + 'abcdefghijk'[idCounter % 11]
}

function newRequest(reg: ContactRequestRegistry, nowMs = T0, digits = DIEGO_DIGITS): PendingContactRequest {
  return reg.create({ digits, label: 'Diego', reason: 'test', days: 7, locale: 'es', lidJid: null }, nowMs, seqId)
}

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------
test('normalizePhone — accepts E.164 and common separators', () => {
  for (const input of ['+56933333333', '56933333333', '+56 9 3333 3333', '+56 9 3333-3333', '(+56) 9 3333 3333', '+56.9.3333.3333', 56933333333]) {
    const r = normalizePhone(input)
    assert.ok(r.ok, `expected ok for ${input}`)
    if (r.ok) {
      assert.equal(r.digits, DIEGO_DIGITS)
      assert.equal(r.e164, `+${DIEGO_DIGITS}`)
    }
  }
})

test('normalizePhone — fullwidth digits/plus are NFKC-normalized', () => {
  const r = normalizePhone('＋５６９３３３３３３３３')
  assert.ok(r.ok && r.digits === DIEGO_DIGITS)
})

test('normalizePhone — rejects JIDs, groups, letters, embedded plus, newlines', () => {
  for (const bad of [
    `${DIEGO_DIGITS}@s.whatsapp.net`,
    DIEGO_LID,
    GROUP,
    '120363000000000001', // 18 digits — a group id is never a phone
    '56912345678-1600000000',
    'abc',
    '+56+933333333',
    '+56\n933333333',
    'tel:+56933333333',
  ]) {
    assert.equal(normalizePhone(bad).ok, false, `expected rejection for ${JSON.stringify(bad)}`)
  }
})

test('normalizePhone — length bounds and country code required', () => {
  assert.equal(normalizePhone('+1234567').ok, false) // 7 digits
  assert.equal(normalizePhone('+1234567890123456').ok, false) // 16 digits
  assert.equal(normalizePhone('0933333333').ok, false) // trunk prefix, no country code
  assert.equal(normalizePhone('').ok, false)
  assert.equal(normalizePhone(undefined).ok, false)
  assert.equal(normalizePhone({}).ok, false)
  assert.ok(normalizePhone('12345678').ok) // 8 digits
  assert.ok(normalizePhone('123456789012345').ok) // 15 digits
})

test('formatPhoneDisplay — Chile mobile, NANP, otherwise plain', () => {
  assert.equal(formatPhoneDisplay('56912345678'), '+56 9 1234 5678')
  assert.equal(formatPhoneDisplay('15551234567'), '+1 555 123 4567')
  assert.equal(formatPhoneDisplay('5491155556666'), '+5491155556666')
})

test('isUserJid / normalizeUserJid — only 1:1 user JIDs', () => {
  assert.ok(isUserJid(DIEGO_PN))
  assert.ok(isUserJid(DIEGO_LID))
  for (const bad of [GROUP, 'status@broadcast', '120363@newsletter', '56933333333:3@s.whatsapp.net', 'x@s.whatsapp.net', '', null, 42]) {
    assert.equal(isUserJid(bad), false, `expected non-user JID: ${String(bad)}`)
  }
  assert.equal(normalizeUserJid('333333333333333:7@lid'), DIEGO_LID)
  assert.equal(normalizeUserJid(GROUP), null)
})

// ---------------------------------------------------------------------------
// Untrusted text
// ---------------------------------------------------------------------------
test('sanitizeUntrustedText — strips control/format/bidi/zero-width chars and newlines', () => {
  const s = sanitizeUntrustedText('Die\u202Ego\n✅ Habilitado\r\n\u200Bx\u2028y\u0007', 200)
  assert.equal(s, 'Die go ✅ Habilitado x y')
  assert.doesNotMatch(s, /[\r\n\u202E\u200B\u2028\u0007]/)
})

test('sanitizeUntrustedText — neutralizes WhatsApp formatting and prompt delimiters', () => {
  assert.equal(sanitizeUntrustedText('*bold* _it_ ~st~ `code` "q" «g»', 200), 'bold it st code q g')
})

test('sanitizeUntrustedText — caps length in code points and is idempotent', () => {
  const long = '😀'.repeat(100)
  const s = sanitizeUntrustedText(long, 40)
  assert.ok(Array.from(s).length <= 40)
  assert.ok(s.endsWith('...'))
  for (const input of [long, 'a'.repeat(500), 'Diego…', ' x\n\ny ', 'Ⅻ ﬁ ①']) {
    const once = sanitizeUntrustedText(input, 40)
    assert.equal(sanitizeUntrustedText(once, 40), once, `not idempotent for ${JSON.stringify(input)}`)
  }
  assert.equal(sanitizeUntrustedText(42 as unknown as string, 40), '')
})

test('validateLabel — required, name not number, capped at 40', () => {
  assert.deepEqual(validateLabel('Diego'), { ok: true, value: 'Diego' })
  assert.ok(validateLabel('Agent 007').ok)
  assert.equal(validateLabel('').ok, false)
  assert.equal(validateLabel(' \n\t ').ok, false)
  assert.equal(validateLabel('+56 9 1234 5678').ok, false)
  assert.equal(validateLabel('Mamá 56912345678').ok, false)
  assert.equal(validateLabel('①②③④⑤').ok, false) // NFKC → 12345
  const long = validateLabel('x'.repeat(100))
  assert.ok(long.ok && Array.from(long.value).length <= 40)
})

test('validateReason — required and capped at 200', () => {
  assert.equal(validateReason('').ok, false)
  const r = validateReason('y'.repeat(1000))
  assert.ok(r.ok && Array.from(r.value).length <= 200)
})

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
test('resolveContactRequestsConfig — default OFF, strict enable, caps', () => {
  assert.deepEqual(resolveContactRequestsConfig(undefined), { enabled: false, locale: 'en', defaultDays: 7, maxDays: 14 })
  assert.equal(resolveContactRequestsConfig({ enabled: 'true' }).enabled, false)
  assert.equal(resolveContactRequestsConfig({ enabled: 1 }).enabled, false)
  assert.equal(resolveContactRequestsConfig([true]).enabled, false)
  assert.deepEqual(resolveContactRequestsConfig({ enabled: true, locale: 'es' }), { enabled: true, locale: 'es', defaultDays: 7, maxDays: 14 })
  assert.equal(resolveContactRequestsConfig({ locale: 'fr' }).locale, 'en')
  assert.equal(resolveContactRequestsConfig({ maxDays: 90 }).maxDays, HARD_MAX_DAYS)
  assert.equal(resolveContactRequestsConfig({ maxDays: 5 }).defaultDays, 5)
  assert.equal(resolveContactRequestsConfig({ defaultDays: 20, maxDays: 14 }).defaultDays, 14)
  assert.equal(resolveContactRequestsConfig({ defaultDays: 0 }).defaultDays, 7)
  assert.equal(resolveContactRequestsConfig({ maxDays: -3 }).maxDays, 14)
  assert.equal(resolveContactRequestsConfig({ maxDays: 'x' }).maxDays, 14)
})

test('withContactRequestsEnabled — toggles and preserves other keys', () => {
  assert.deepEqual(withContactRequestsEnabled({ enabled: false, maxDays: 10 }, true, 'es'), { enabled: true, maxDays: 10, locale: 'es' })
  assert.deepEqual(withContactRequestsEnabled(undefined, true), { enabled: true })
  assert.deepEqual(withContactRequestsEnabled({ enabled: true, locale: 'es' }, false), { enabled: false, locale: 'es' })
})

test('resolveRequestedDays — default, clamp to maxDays, reject < 1', () => {
  const cfg = resolveContactRequestsConfig({ enabled: true })
  assert.deepEqual(resolveRequestedDays(undefined, cfg), { ok: true, days: 7, clamped: false })
  assert.deepEqual(resolveRequestedDays(3, cfg), { ok: true, days: 3, clamped: false })
  assert.deepEqual(resolveRequestedDays('5', cfg), { ok: true, days: 5, clamped: false })
  assert.deepEqual(resolveRequestedDays(2.7, cfg), { ok: true, days: 2, clamped: false })
  assert.deepEqual(resolveRequestedDays(100, cfg), { ok: true, days: 14, clamped: true })
  const capped = resolveContactRequestsConfig({ maxDays: 999 })
  assert.deepEqual(resolveRequestedDays(365, capped), { ok: true, days: HARD_MAX_DAYS, clamped: true })
  for (const bad of [0, -1, 0.5, 'abc', NaN, Infinity, {}]) {
    assert.equal(resolveRequestedDays(bad, cfg).ok, false, `expected rejection for ${String(bad)}`)
  }
})

// ---------------------------------------------------------------------------
// Owner-action authorization — who can approve / run commands
// ---------------------------------------------------------------------------
test('authorizeOwnerAction — owner in a 1:1 DM (either JID form) is allowed', () => {
  assert.deepEqual(authorizeOwnerAction(ownerCtx()), { ok: true })
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ senderId: OWNER_LID, chatId: OWNER_LID })), { ok: true })
})

test('authorizeOwnerAction — anything fromMe (the bot/agent) is refused first', () => {
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ fromMe: true })), { ok: false, reason: 'from_me' })
})

test('authorizeOwnerAction — non-owner allowlisted contact is refused', () => {
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ senderId: FRIEND_PN, chatId: FRIEND_PN })), { ok: false, reason: 'not_owner' })
})

test('authorizeOwnerAction — groups, status broadcast, newsletters, participant-in-DM are refused', () => {
  // Owner speaking inside a group: still not a 1:1 DM.
  assert.equal(authorizeOwnerAction(ownerCtx({ chatId: GROUP })).ok, false)
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ chatId: GROUP })), { ok: false, reason: 'not_dm' })
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ chatId: 'status@broadcast' })), { ok: false, reason: 'not_dm' })
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ chatId: '1203@newsletter' })), { ok: false, reason: 'not_dm' })
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ chatId: FRIEND_PN })), { ok: false, reason: 'not_dm' })
})

test('authorizeOwnerAction — fail closed until the bot identity is known', () => {
  assert.deepEqual(authorizeOwnerAction(ownerCtx({ botIdentityKnown: false })), { ok: false, reason: 'bot_identity_unknown' })
})

test('authorizeOwnerAction — echo of the bot account (fromMe=false) is refused even if listed as owner', () => {
  // Self-chat / receipt-echo scenario: the bot's own JID arrives with fromMe
  // false and the operator has (mis)configured it as an owner.
  const ctx = ownerCtx({ ownerJids: [BOT_PN], senderId: BOT_PN, chatId: BOT_PN, senderIsBot: true, ownerListIncludesBot: true })
  assert.deepEqual(authorizeOwnerAction(ctx), { ok: false, reason: 'sender_is_bot' })
})

test('authorizeOwnerAction — self-chat owner list refuses even a separate owner JID', () => {
  // ownerJids contains the bot account → the agent's own outbound would look
  // like the owner's; WhatsApp-side approval is refused outright.
  const ctx = ownerCtx({ ownerJids: [OWNER_PN, BOT_LID], ownerListIncludesBot: true })
  assert.deepEqual(authorizeOwnerAction(ctx), { ok: false, reason: 'self_chat_owner' })
  assert.ok(ownerListIncludesBot([OWNER_PN, BOT_LID], isBot))
  assert.equal(ownerListIncludesBot([OWNER_PN, OWNER_LID], isBot), false)
})

test('contactPromptTargets — 1:1 owners only, never the bot, LID deduped against PN', () => {
  const pnForLid = (lid: string) => (lid === OWNER_LID ? '56911111111' : null)
  assert.deepEqual(contactPromptTargets([OWNER_PN, OWNER_LID, GROUP, BOT_PN], isBot, pnForLid), [OWNER_PN])
  // Unresolvable LID is kept (it may be a different human).
  assert.deepEqual(contactPromptTargets([OWNER_PN, OWNER_LID], isBot, () => null), [OWNER_PN, OWNER_LID])
  assert.deepEqual(contactPromptTargets([BOT_PN, BOT_LID], isBot, () => null), [])
})

// ---------------------------------------------------------------------------
// Request targets
// ---------------------------------------------------------------------------
test('evaluateRequestTarget — fresh number is ok', () => {
  assert.deepEqual(evaluateRequestTarget(access(), [DIEGO_PN, DIEGO_LID], DIEGO_DIGITS, isBot, T0), { kind: 'ok', activeGrant: null })
})

test('evaluateRequestTarget — bot, owner (either form), permanent entry, bad JID', () => {
  assert.equal(evaluateRequestTarget(access(), [BOT_PN], '56900000000', isBot, T0).kind, 'is_self')
  assert.equal(evaluateRequestTarget(access(), [OWNER_PN], '56911111111', isBot, T0).kind, 'is_owner')
  // Owner known only by LID: the PN looks new, but the resolved LID is an owner.
  const lidOnlyOwner = access({ ownerJids: [DIEGO_LID] })
  assert.equal(evaluateRequestTarget(lidOnlyOwner, [DIEGO_PN, DIEGO_LID], DIEGO_DIGITS, isBot, T0).kind, 'is_owner')
  assert.deepEqual(evaluateRequestTarget(access(), [FRIEND_PN], '56922222222', isBot, T0), { kind: 'already_allowed', jid: FRIEND_PN })
  assert.equal(evaluateRequestTarget(access(), [GROUP], '120363000000000001', isBot, T0).kind, 'invalid')
  assert.equal(evaluateRequestTarget(access(), [], DIEGO_DIGITS, isBot, T0).kind, 'invalid')
})

test('evaluateRequestTarget — existing temporary grant is an extension, not "already allowed"', () => {
  const g = grant()
  const a = access({ allowFrom: [OWNER_PN, OWNER_LID, DIEGO_PN, DIEGO_LID], temporaryAllow: [g] })
  const v = evaluateRequestTarget(a, [DIEGO_PN], DIEGO_DIGITS, isBot, T0)
  assert.equal(v.kind, 'ok')
  assert.equal(v.kind === 'ok' && v.activeGrant?.requestId, 'kxqzbt')
  // Expired-but-unswept grant: still temporary, and no longer "active".
  const v2 = evaluateRequestTarget(a, [DIEGO_PN], DIEGO_DIGITS, isBot, T0 + 30 * DAY)
  assert.deepEqual(v2, { kind: 'ok', activeGrant: null })
})

// ---------------------------------------------------------------------------
// Grants: apply / expire / revoke / bind
// ---------------------------------------------------------------------------
test('applyGrant — adds PN + LID to allowFrom and records the grant (pure)', () => {
  const before = access()
  const snapshot = JSON.stringify(before)
  const r = applyGrant(before, grant(), isBot)
  assert.ok(r.ok)
  if (!r.ok) return
  assert.deepEqual(r.added, [DIEGO_PN, DIEGO_LID])
  assert.ok(r.access.allowFrom.includes(DIEGO_PN) && r.access.allowFrom.includes(DIEGO_LID))
  assert.equal(r.access.temporaryAllow?.length, 1)
  assert.equal(JSON.stringify(before), snapshot, 'input must not be mutated')
})

test('applyGrant — never grants owners, the bot, groups or permanent entries', () => {
  const r = applyGrant(access(), grant({ jids: [OWNER_PN, BOT_PN, GROUP, FRIEND_PN, 'status@broadcast'] }), isBot)
  assert.deepEqual(r, { ok: false, reason: 'no_grantable_jids' })
  const mixed = applyGrant(access(), grant({ jids: [DIEGO_PN, OWNER_LID, GROUP] }), isBot)
  assert.ok(mixed.ok)
  if (mixed.ok) {
    assert.deepEqual(mixed.grant.jids, [DIEGO_PN])
    assert.ok(!mixed.access.allowFrom.includes(GROUP))
  }
})

test('applyGrant — re-approval for the same phone replaces the grant, no duplicates', () => {
  const first = applyGrant(access(), grant({ jids: [DIEGO_PN] }), isBot)
  assert.ok(first.ok)
  if (!first.ok) return
  const second = applyGrant(first.access, grant({ jids: [DIEGO_PN, DIEGO_LID], requestId: 'pqrstu' }), isBot)
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(second.access.temporaryAllow?.length, 1)
  assert.equal(second.grant.requestId, 'pqrstu')
  assert.deepEqual([...second.grant.jids].sort(), [DIEGO_LID, DIEGO_PN].sort())
  assert.equal(second.access.allowFrom.filter((j) => j === DIEGO_PN).length, 1)
})

test('removeExpiredGrants — removes only expired grants and their JIDs', () => {
  const g = grant()
  const other = grant({ jids: ['56944444444@s.whatsapp.net'], phone: '+56944444444', requestId: 'zzzzzz', expiresAt: new Date(T0 + 20 * DAY).toISOString() })
  const a = access({ allowFrom: [OWNER_PN, OWNER_LID, FRIEND_PN, DIEGO_PN, DIEGO_LID, '56944444444@s.whatsapp.net'], temporaryAllow: [g, other] })
  const before = removeExpiredGrants(a, T0 + DAY)
  assert.equal(before.removed.length, 0)
  assert.equal(before.access, a, 'nothing expired → same object')
  const after = removeExpiredGrants(a, T0 + 7 * DAY) // exactly at expiry → expired
  assert.deepEqual(after.removed.map((x) => x.requestId), ['kxqzbt'])
  assert.deepEqual(after.access.allowFrom, [OWNER_PN, OWNER_LID, FRIEND_PN, '56944444444@s.whatsapp.net'])
  assert.deepEqual(after.access.temporaryAllow?.map((x) => x.requestId), ['zzzzzz'])
})

test('removeExpiredGrants — never removes owners, permanent or non-user JIDs listed in a (tampered) grant', () => {
  const tampered = grant({ jids: [DIEGO_PN, OWNER_PN, GROUP], expiresAt: new Date(T0 - 1).toISOString() })
  const a = access({ allowFrom: [OWNER_PN, OWNER_LID, FRIEND_PN, DIEGO_PN, GROUP], temporaryAllow: [tampered] })
  const r = removeExpiredGrants(a, T0)
  assert.deepEqual(r.access.allowFrom, [OWNER_PN, OWNER_LID, FRIEND_PN, GROUP])
})

test('removeExpiredGrants — unparseable expiry is treated as expired (fail closed)', () => {
  const g = grant({ expiresAt: 'not-a-date' })
  assert.ok(isGrantExpired(g, T0))
  const a = access({ allowFrom: [OWNER_PN, DIEGO_PN], temporaryAllow: [g] })
  assert.deepEqual(removeExpiredGrants(a, T0).access.allowFrom, [OWNER_PN])
})

test('removeExpiredGrants — JID still covered by an active grant is kept', () => {
  const expired = grant({ expiresAt: new Date(T0 - 1).toISOString(), requestId: 'old111' })
  const active = grant({ jids: [DIEGO_LID], phone: '+56955555555', requestId: 'new222' })
  const a = access({ allowFrom: [OWNER_PN, DIEGO_PN, DIEGO_LID], temporaryAllow: [expired, active] })
  const r = removeExpiredGrants(a, T0)
  assert.deepEqual(r.access.allowFrom, [OWNER_PN, DIEGO_LID])
})

test('withoutExpiredGrantJids / hasExpiredGrant — exact expiry for admit decisions', () => {
  const a = access({ allowFrom: [OWNER_PN, DIEGO_PN], temporaryAllow: [grant({ jids: [DIEGO_PN] })] })
  assert.equal(withoutExpiredGrantJids(a, T0), a)
  assert.equal(hasExpiredGrant(a, T0), false)
  const later = T0 + 7 * DAY + 1
  assert.ok(hasExpiredGrant(a, later))
  assert.ok(!withoutExpiredGrantJids(a, later).allowFrom.includes(DIEGO_PN))
  assert.equal(computeGrantExpiry(T0, 7), T0 + 7 * DAY)
})

test('revokeGrantsForPhone / revokeAllGrants — only temporary entries', () => {
  const a = access({ allowFrom: [OWNER_PN, FRIEND_PN, DIEGO_PN, DIEGO_LID], temporaryAllow: [grant()] })
  const r = revokeGrantsForPhone(a, DIEGO_DIGITS)
  assert.deepEqual(r.access.allowFrom, [OWNER_PN, FRIEND_PN])
  assert.equal(revokeGrantsForPhone(a, '56922222222').removed.length, 0, 'permanent FRIEND is not a grant')
  const all = revokeAllGrants(a)
  assert.deepEqual(all.access.allowFrom, [OWNER_PN, FRIEND_PN])
  assert.deepEqual(all.access.temporaryAllow, [])
})

test('normalizeTemporaryAllow — keeps malformed records (so their JIDs still expire)', () => {
  assert.deepEqual(normalizeTemporaryAllow('nope'), [])
  const out = normalizeTemporaryAllow([null, 5, { jids: [DIEGO_PN, 7], phone: 1 }])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].jids, [DIEGO_PN])
  assert.ok(isGrantExpired(out[0], T0))
})

test('bindAltJidToGrant — LID sender bound when its server-asserted PN alt is granted', () => {
  const a = access({ allowFrom: [OWNER_PN, DIEGO_PN], temporaryAllow: [grant({ jids: [DIEGO_PN] })] })
  const r = bindAltJidToGrant(a, { senderId: DIEGO_LID, chatId: DIEGO_LID, altJid: `${DIEGO_DIGITS}:0@s.whatsapp.net`, senderIsBot: false, nowMs: T0 })
  assert.ok(r.grant)
  assert.ok(r.access.allowFrom.includes(DIEGO_LID))
  assert.deepEqual(r.grant?.jids, [DIEGO_PN, DIEGO_LID])
})

test('bindAltJidToGrant — refuses expired grants, groups, owners, bot, same namespace, already allowed', () => {
  const a = access({ allowFrom: [OWNER_PN, DIEGO_PN], temporaryAllow: [grant({ jids: [DIEGO_PN] })] })
  const base = { senderId: DIEGO_LID, chatId: DIEGO_LID, altJid: DIEGO_PN, senderIsBot: false, nowMs: T0 }
  assert.equal(bindAltJidToGrant(a, { ...base, nowMs: T0 + 8 * DAY }).grant, null)
  assert.equal(bindAltJidToGrant(a, { ...base, chatId: GROUP }).grant, null)
  assert.equal(bindAltJidToGrant(a, { ...base, senderIsBot: true }).grant, null)
  assert.equal(bindAltJidToGrant(a, { ...base, altJid: '56999999999@s.whatsapp.net' }).grant, null)
  assert.equal(bindAltJidToGrant(a, { ...base, senderId: '444444444444444@s.whatsapp.net', chatId: '444444444444444@s.whatsapp.net' }).grant, null)
  const ownerLid = access({ allowFrom: [OWNER_PN], ownerJids: [OWNER_PN, DIEGO_LID], temporaryAllow: [grant({ jids: [DIEGO_PN] })] })
  assert.equal(bindAltJidToGrant(ownerLid, base).grant, null)
  const already = access({ allowFrom: [OWNER_PN, DIEGO_PN, DIEGO_LID], temporaryAllow: [grant({ jids: [DIEGO_PN] })] })
  assert.equal(bindAltJidToGrant(already, base).grant, null)
  assert.equal(bindAltJidToGrant(a, { ...base, altJid: null }).grant, null)
})

// ---------------------------------------------------------------------------
// Registry: pending requests, prompt ids, rate limits
// ---------------------------------------------------------------------------
test('registry — only prompt ids the plugin attached map to a request', () => {
  const reg = new ContactRequestRegistry()
  const req = newRequest(reg)
  reg.attachPrompt(req.id, 'PROMPT-1')
  assert.equal(reg.getByPromptId('PROMPT-1', T0)?.id, req.id)
  assert.equal(reg.getByPromptId('AGENT-MADE-UP', T0), undefined)
  assert.ok(reg.isProtectedPromptId('PROMPT-1'))
  assert.equal(reg.isProtectedPromptId('AGENT-MADE-UP'), false)
})

test('registry — max 3 pending, then refused', () => {
  const reg = new ContactRequestRegistry()
  newRequest(reg, T0, '56900000001')
  newRequest(reg, T0, '56900000002')
  newRequest(reg, T0, '56900000003')
  const check = reg.checkCanCreate(T0)
  assert.equal(check.ok, false)
  assert.equal(!check.ok && check.reason, 'too_many_pending')
  assert.throws(() => newRequest(reg, T0, '56900000004'), /too_many_pending/)
})

test('registry — max 10 per rolling 24 h; window slides; discard does not count', () => {
  const reg = new ContactRequestRegistry()
  for (let i = 0; i < 10; i++) {
    const r = newRequest(reg, T0 + i * 1000, `5690000001${i}`)
    reg.take(r.id, 'denied')
  }
  const blocked = reg.checkCanCreate(T0 + 60_000)
  assert.equal(blocked.ok, false)
  assert.equal(!blocked.ok && blocked.reason, 'rate_limited')
  assert.ok(!blocked.ok && blocked.retryAfterMs > 0)
  assert.ok(reg.checkCanCreate(T0 + DAY + 1).ok, 'oldest entry left the window')

  const reg2 = new ContactRequestRegistry()
  for (let i = 0; i < 9; i++) reg2.take(newRequest(reg2, T0, `5690000002${i}`).id)
  const failed = newRequest(reg2, T0, '56900000099')
  reg2.discard(failed.id)
  assert.ok(reg2.checkCanCreate(T0).ok, 'a request whose prompt reached nobody does not count')
})

test('registry — requests expire after 24 h; sweep reports them; prompt stays protected', () => {
  const reg = new ContactRequestRegistry()
  const req = newRequest(reg)
  reg.attachPrompt(req.id, 'PROMPT-2')
  assert.ok(reg.get(req.id, T0 + DAY - 1))
  assert.equal(reg.get(req.id, T0 + DAY), undefined)
  assert.equal(reg.getByPromptId('PROMPT-2', T0 + DAY), undefined)
  const swept = reg.sweepExpired(T0 + DAY)
  assert.deepEqual(swept.map((r) => r.id), [req.id])
  assert.equal(reg.resolvedInfoByPromptId('PROMPT-2')?.outcome, 'expired')
  assert.ok(reg.isProtectedPromptId('PROMPT-2'))
})

test('registry — first decision wins (claim), abort releases', () => {
  const reg = new ContactRequestRegistry()
  const req = newRequest(reg)
  assert.ok(reg.beginDecision(req.id, T0))
  assert.equal(reg.beginDecision(req.id, T0), undefined, 'second concurrent decision refused')
  reg.abortDecision(req.id)
  assert.ok(reg.beginDecision(req.id, T0))
  reg.take(req.id, 'approved')
  assert.equal(reg.beginDecision(req.id, T0), undefined)
  assert.equal(reg.resolvedInfo(req.id)?.outcome, 'approved')
  assert.equal(reg.sweepExpired(T0 + 2 * DAY).length, 0)
})

test('registry — sweep never expires a request mid-decision', () => {
  const reg = new ContactRequestRegistry()
  const req = newRequest(reg)
  reg.beginDecision(req.id, T0)
  assert.equal(reg.sweepExpired(T0 + 2 * DAY).length, 0)
})

test('registry — findPendingByDigits and takeAll', () => {
  const reg = new ContactRequestRegistry()
  const a = newRequest(reg, T0, '56900000001')
  newRequest(reg, T0, '56900000002')
  assert.equal(reg.findPendingByDigits('56900000001', T0)?.id, a.id)
  assert.equal(reg.findPendingByDigits('56900000001', T0 + DAY), undefined)
  assert.equal(reg.takeAll('cancelled').length, 2)
  assert.equal(reg.list(T0).length, 0)
  assert.equal(reg.resolvedInfo(a.id)?.outcome, 'cancelled')
})

// ---------------------------------------------------------------------------
// Decision parsing
// ---------------------------------------------------------------------------
test('classifyDecisionEmoji — 👍/✅ approve, 👎/❌ deny (skin tones), others null', () => {
  for (const e of ['👍', '👍🏽', '✅']) assert.equal(classifyDecisionEmoji(e), 'approve')
  for (const e of ['👎', '👎🏿', '❌']) assert.equal(classifyDecisionEmoji(e), 'deny')
  for (const e of ['❤️', '😂', '', '👍👍']) assert.equal(classifyDecisionEmoji(e), null)
})

test('generateRequestId — 6 letters, never "l"', () => {
  let i = 0
  const id = generateRequestId(() => (i++ * 11) % 25)
  assert.match(id, /^[a-km-z]{6}$/)
  assert.equal(generateRequestId(() => 11), 'mmmmmm') // index 11 skips "l"
})

test('parseContactRequestReply — approve/deny verbs (en/es), 6-letter id, strict', () => {
  assert.deepEqual(parseContactRequestReply('approve kxqzbt'), { requestId: 'kxqzbt', decision: 'approve' })
  assert.deepEqual(parseContactRequestReply('  APROBAR KXQZBT '), { requestId: 'kxqzbt', decision: 'approve' })
  assert.deepEqual(parseContactRequestReply('aprueba kxqzbt'), { requestId: 'kxqzbt', decision: 'approve' })
  for (const d of ['deny kxqzbt', 'reject kxqzbt', 'rechazar kxqzbt', 'Rechaza kxqzbt']) {
    assert.equal(parseContactRequestReply(d)?.decision, 'deny')
  }
  for (const bad of ['yes kxqzbt', 'approve abcde', 'approve kxqzbl', 'approve kxqzbt please', 'please approve kxqzbt', 'approve\nkxqzbt x']) {
    assert.equal(parseContactRequestReply(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('reply parsers never claim each other’s messages (permission relay vs contact requests)', () => {
  assert.equal(parsePermissionReply('approve kxqzbt'), null)
  assert.equal(parsePermissionReply('aprobar kxqzbt'), null)
  assert.equal(parseContactRequestReply('yes abcde'), null)
  assert.equal(parseContactRequestReply('no abcde'), null)
})

// ---------------------------------------------------------------------------
// `!access contact-requests …`
// ---------------------------------------------------------------------------
test('isContactRequestsCommandText — only the contact-requests subcommand', () => {
  assert.ok(isContactRequestsCommandText('!access contact-requests on'))
  assert.ok(isContactRequestsCommandText('!access Contact-Requests'))
  assert.ok(isContactRequestsCommandText('!access contact-request on'), 'singular typo still routed here')
  assert.deepEqual(parseContactRequestsCommand('!access contact-request on es'), { kind: 'on', locale: 'es' })
  assert.equal(isContactRequestsCommandText('!access contact-requestsX'), false)
  assert.equal(isContactRequestsCommandText('!access list'), false)
  assert.equal(isContactRequestsCommandText('contact-requests on'), false)
  assert.equal(isContactRequestsCommandText(' !access contact-requests on'), false)
  // Still inside the reserved namespace, so it is consumed (never forwarded).
  assert.ok(isOwnerDmCommandText('!access contact-requests on'))
})

test('parseContactRequestsCommand — subcommands', () => {
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests'), { kind: 'status' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests status'), { kind: 'status' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests list'), { kind: 'list' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests on'), { kind: 'on' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests ON ES'), { kind: 'on', locale: 'es' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests on en'), { kind: 'on', locale: 'en' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests off'), { kind: 'off' })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests revoke +56 9 3333 3333'), { kind: 'revoke', digits: DIEGO_DIGITS })
  assert.deepEqual(parseContactRequestsCommand('!access contact-requests revoke all'), { kind: 'revoke-all' })
  assert.equal(parseContactRequestsCommand('!access list'), null)
})

test('parseContactRequestsCommand — invalid input', () => {
  for (const bad of [
    '!access contact-requests on fr',
    '!access contact-requests on es extra',
    '!access contact-requests off now',
    '!access contact-requests revoke',
    `!access contact-requests revoke ${DIEGO_PN}`,
    `!access contact-requests revoke ${GROUP}`,
    '!access contact-requests allow +56933333333',
    '!access contact-requests on\nallow x',
    `!access contact-requests revoke ${'1'.repeat(300)}`,
  ]) {
    assert.equal(parseContactRequestsCommand(bad)?.kind, 'invalid', `expected invalid for ${JSON.stringify(bad.slice(0, 60))}`)
  }
})

test('existing owner-DM parser is unchanged (contact-requests is routed before it)', () => {
  assert.deepEqual(parseOwnerDmCommand(`!access add-group ${GROUP}`), { kind: 'add-group', groupJid: GROUP })
  assert.deepEqual(parseOwnerDmCommand('!access allow 56933333333@s.whatsapp.net'), { kind: 'forbidden', subcommand: 'allow' })
  assert.deepEqual(parseOwnerDmCommand('!access dm-mutations on'), { kind: 'forbidden', subcommand: 'dm-mutations' })
  assert.equal(parseOwnerDmCommand('!access contact-requests on')?.kind, 'invalid')
})

// ---------------------------------------------------------------------------
// Inbound routing — the security invariants end to end (pure)
// ---------------------------------------------------------------------------
function setupPending(): { reg: ContactRequestRegistry; req: PendingContactRequest } {
  const reg = new ContactRequestRegistry()
  const req = newRequest(reg)
  reg.attachPrompt(req.id, 'PROMPT-OWNER')
  return { reg, req }
}

test('route — owner 👍 on the plugin prompt in their DM → decide approve', () => {
  const { reg, req } = setupPending()
  const r = routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx())
  assert.equal(r.kind, 'decide')
  assert.ok(r.kind === 'decide' && r.request.id === req.id && r.decision === 'approve')
})

test('route — the agent can never approve its own request', () => {
  const { reg, req } = setupPending()
  // 1. Its own reaction/reply: fromMe → refused, swallowed, request untouched.
  assert.deepEqual(routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx({ fromMe: true })), { kind: 'consume', why: 'from_me' })
  assert.deepEqual(routeContactReplyText(reg, `approve ${req.id}`, routeCtx({ fromMe: true })), { kind: 'consume', why: 'from_me' })
  // 2. A cross-device / receipt echo of the bot account with fromMe=false,
  //    even when the bot JID was put in ownerJids (self-chat).
  const echo = routeCtx({ ownerJids: [BOT_PN], senderId: BOT_PN, chatId: BOT_PN, senderIsBot: true, ownerListIncludesBot: true })
  assert.equal(routeContactReaction(reg, '👍', 'PROMPT-OWNER', echo).kind, 'consume')
  assert.equal(routeContactReplyText(reg, `approve ${req.id}`, echo).kind, 'consume')
  // 3. Reacting to a message id it made up (or its own message): not ours.
  assert.deepEqual(routeContactReaction(reg, '👍', 'AGENT-MESSAGE', routeCtx()), { kind: 'pass' })
  // 4. Bot identity not captured yet → fail closed.
  assert.equal(routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx({ botIdentityKnown: false })).kind, 'reply')
  // The request is still pending and unclaimed after all of the above.
  assert.ok(reg.get(req.id, T0))
  assert.equal(reg.isDeciding(req.id), false)
})

test('route — non-owner allowlisted contacts and group participants cannot approve', () => {
  const { reg, req } = setupPending()
  const friend = routeCtx({ senderId: FRIEND_PN, chatId: FRIEND_PN })
  assert.deepEqual(routeContactReaction(reg, '👍', 'PROMPT-OWNER', friend), { kind: 'consume', why: 'not_owner' })
  assert.deepEqual(routeContactReplyText(reg, `approve ${req.id}`, friend), { kind: 'consume', why: 'not_owner' })
  // The owner (or anyone) inside a group.
  const inGroup = routeCtx({ chatId: GROUP })
  assert.deepEqual(routeContactReaction(reg, '👍', 'PROMPT-OWNER', inGroup), { kind: 'consume', why: 'not_dm' })
  assert.deepEqual(routeContactReplyText(reg, `approve ${req.id}`, inGroup), { kind: 'consume', why: 'not_dm' })
  // Status broadcast is not a DM either.
  assert.equal(routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx({ chatId: 'status@broadcast' })).kind, 'consume')
  assert.ok(reg.get(req.id, T0))
})

test('route — self-chat owner list: owner gets an explanation, nothing is decided', () => {
  const { reg } = setupPending()
  const r = routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx({ ownerListIncludesBot: true }))
  assert.equal(r.kind, 'reply')
  assert.ok(r.kind === 'reply' && /auto-chat|propio bot/.test(r.text))
})

test('route — text reply by owner decides; unknown id passes through to the agent', () => {
  const { reg, req } = setupPending()
  assert.deepEqual(routeContactReplyText(reg, 'approve zzzzzz', routeCtx()), { kind: 'pass' })
  assert.deepEqual(routeContactReplyText(reg, 'hola', routeCtx()), { kind: 'pass' })
  const r = routeContactReplyText(reg, `rechazar ${req.id}`, routeCtx())
  assert.ok(r.kind === 'decide' && r.decision === 'deny')
})

test('route — non-decision emoji on the prompt is swallowed; in-flight decision is swallowed', () => {
  const { reg, req } = setupPending()
  assert.equal(routeContactReaction(reg, '❤️', 'PROMPT-OWNER', routeCtx()).kind, 'consume')
  reg.beginDecision(req.id, T0)
  assert.deepEqual(routeContactReaction(reg, '👎', 'PROMPT-OWNER', routeCtx()), { kind: 'consume', why: 'decision_in_flight' })
})

test('route — late 👎 after approval answers "already resolved" with a revoke hint', () => {
  const { reg, req } = setupPending()
  reg.take(req.id, 'approved')
  const r = routeContactReaction(reg, '👎', 'PROMPT-OWNER', routeCtx())
  assert.equal(r.kind, 'reply')
  assert.ok(r.kind === 'reply' && r.text.includes('revoke +56933333333'))
  const t = routeContactReplyText(reg, `deny ${req.id}`, routeCtx({ locale: 'en' }))
  assert.ok(t.kind === 'reply' && /already resolved \(approved\)/.test(t.text))
  // ...but a non-owner learns nothing.
  assert.equal(routeContactReaction(reg, '👎', 'PROMPT-OWNER', routeCtx({ senderId: FRIEND_PN, chatId: FRIEND_PN })).kind, 'consume')
})

test('route — expired request cannot be approved', () => {
  const { reg } = setupPending()
  const r = routeContactReaction(reg, '👍', 'PROMPT-OWNER', routeCtx({ nowMs: T0 + DAY }))
  assert.notEqual(r.kind, 'decide')
})

// ---------------------------------------------------------------------------
// Approval planning (re-validation against a fresh access.json)
// ---------------------------------------------------------------------------
test('planApproval — grants PN + LID for days from approval time', () => {
  const { req } = setupPending()
  const p = planApproval(access(), req, `${DIEGO_LID.replace('@', ':4@')}`, isBot, T0 + 1000, OWNER_PN)
  assert.equal(p.kind, 'apply')
  if (p.kind !== 'apply') return
  assert.deepEqual(p.grant.jids, [DIEGO_PN, DIEGO_LID])
  assert.equal(p.grant.expiresAt, new Date(T0 + 1000 + 7 * DAY).toISOString())
  assert.equal(p.grant.approvedBy, OWNER_PN)
  assert.ok(p.access.allowFrom.includes(DIEGO_PN) && p.access.allowFrom.includes(DIEGO_LID))
})

test('planApproval — target became owner / is the bot / was permanently allowed meanwhile', () => {
  const { req } = setupPending()
  assert.equal(planApproval(access({ ownerJids: [OWNER_PN, DIEGO_PN] }), req, null, isBot, T0, OWNER_PN).kind, 'refuse')
  assert.equal(planApproval(access({ ownerJids: [OWNER_PN, DIEGO_LID] }), req, DIEGO_LID, isBot, T0, OWNER_PN).kind, 'refuse')
  const botReq = { ...req, digits: '56900000000', phone: '+56900000000' }
  const bot = planApproval(access(), botReq, null, isBot, T0, OWNER_PN)
  assert.ok(bot.kind === 'refuse' && bot.notice === 'refused_self')
  assert.equal(planApproval(access({ allowFrom: [OWNER_PN, DIEGO_PN] }), req, null, isBot, T0, OWNER_PN).kind, 'already_allowed')
})

test('planApproval — never shortens an existing grant; ignores a non-LID "lid"', () => {
  const { req } = setupPending()
  const long = grant({ jids: [DIEGO_PN], expiresAt: new Date(T0 + 20 * DAY).toISOString() })
  const p = planApproval(access({ allowFrom: [OWNER_PN, DIEGO_PN], temporaryAllow: [long] }), req, GROUP, isBot, T0, OWNER_PN)
  assert.equal(p.kind, 'apply')
  if (p.kind !== 'apply') return
  assert.equal(p.grant.expiresAt, new Date(T0 + 20 * DAY).toISOString())
  assert.deepEqual(p.grant.jids, [DIEGO_PN])
  assert.equal(p.access.temporaryAllow?.length, 1)
})

test('full lifecycle — approve, admit, expire, removed (pure pipeline)', () => {
  const { reg, req } = setupPending()
  const route = routeContactReaction(reg, '✅', 'PROMPT-OWNER', routeCtx())
  assert.equal(route.kind, 'decide')
  const plan = planApproval(access(), req, DIEGO_LID, isBot, T0, OWNER_PN)
  assert.equal(plan.kind, 'apply')
  if (plan.kind !== 'apply') return
  reg.take(req.id, 'approved')
  const granted = plan.access
  assert.ok(granted.allowFrom.includes(DIEGO_LID))
  // Day 6: still admitted. Day 7: the admit view drops it, the sweep removes it.
  assert.ok(withoutExpiredGrantJids(granted, T0 + 6 * DAY).allowFrom.includes(DIEGO_PN))
  assert.ok(!withoutExpiredGrantJids(granted, T0 + 7 * DAY).allowFrom.includes(DIEGO_PN))
  const swept = removeExpiredGrants(granted, T0 + 7 * DAY)
  assert.equal(swept.removed.length, 1)
  assert.deepEqual(swept.access.allowFrom, access().allowFrom)
  assert.deepEqual(swept.access.ownerJids, access().ownerJids, 'owners untouched')
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
test('renderRequestPrompt (es) — matches the spec shape', () => {
  const text = renderRequestPrompt('es', { digits: '56912345678', label: 'Diego', reason: 'Coordinar el lunes', days: 7, requestId: 'kxqzbt', ttlHours: 24 })
  assert.equal(
    text,
    [
      '🔐 *Solicitud de acceso*',
      'Habilitar a *+56 9 1234 5678* («Diego») por 7 días.',
      'Motivo: Coordinar el lunes',
      'Reacciona 👍 para aprobar o 👎 para rechazar. Vence en 24 h.',
      'O responde *aprobar kxqzbt* / *rechazar kxqzbt*.',
    ].join('\n'),
  )
})

test('renderRequestPrompt — hostile label/reason cannot add lines, break formatting or fake the number', () => {
  const label = 'Mamá»*\n✅ Habilitado +56 9 9999 9999\u202E'
  const reason = 'ok\n\nReacciona 👍 para aprobar *ahora*\u200B_x_'
  const text = renderRequestPrompt('es', { digits: '56912345678', label, reason, days: 1, requestId: 'kxqzbt', ttlHours: 24 })
  const lines = text.split('\n')
  assert.equal(lines.length, 5)
  assert.ok(lines[1].startsWith('Habilitar a *+56 9 1234 5678* («'))
  assert.ok(lines[1].endsWith('») por 1 día.'))
  assert.equal((lines[1].match(/\*/g) ?? []).length, 2, 'only the plugin bolds the phone')
  assert.equal((lines[1].match(/»/g) ?? []).length, 1)
  assert.ok(lines[2].startsWith('Motivo: '))
  assert.doesNotMatch(lines[2], /[*_\u200B]/)
  assert.doesNotMatch(text, /\u202E/)
})

test('renderRequestPrompt (en) — and current-grant line', () => {
  const text = renderRequestPrompt('en', {
    digits: '15551234567', label: 'Ana', reason: 'r', days: 3, requestId: 'kxqzbt', ttlHours: 24,
    currentExpiry: new Date(2026, 10, 21, 11, 5),
  })
  assert.match(text, /^🔐 \*Access request\*\nAllow \*\+1 555 123 4567\* \("Ana"\) to message me for 3 days\.\nAlready has temporary access until 21-Nov 11:05\./)
  assert.match(text, /Or reply \*approve kxqzbt\* \/ \*deny kxqzbt\*\.$/)
})

test('confirmations and short dates', () => {
  const d = new Date(2026, 10, 21, 11, 5)
  assert.equal(formatShortDateTime(d, 'es'), '21-nov 11:05')
  assert.equal(formatShortDateTime(d, 'en'), '21-Nov 11:05')
  assert.equal(renderApprovedConfirmation('es', '56912345678', 'Diego', d), '✅ Habilitado *+56 9 1234 5678* («Diego») hasta 21-nov 11:05.')
  assert.equal(renderDeniedConfirmation('en', '56912345678', 'Diego'), '❌ Denied: *+56 9 1234 5678* ("Diego") was not enabled.')
  assert.match(renderAlreadyResolved('es', { requestId: 'kxqzbt', digits: '569', outcome: 'denied' }), /ya estaba resuelta \(rechazada\)/)
})

test('renderContactRequestsList — grants and pending', () => {
  const { reg } = setupPending()
  const text = renderContactRequestsList('en', [grant({ expiresAt: new Date(2026, 10, 21, 11, 5).toISOString() })], reg.list(T0))
  assert.match(text, /• \+56 9 3333 3333 \("Diego"\) until 21-Nov 11:05/)
  assert.match(text, /\*Pending\*\n• [a-km-z]{6} — \+56 9 3333 3333 \("Diego"\), 7 days/)
  assert.match(renderContactRequestsList('es', [], []), /\(ninguno\)\n\*Pendientes\*\n\(ninguno\)/)
})

test('renderAgentNotice — plugin-authored outcome text', () => {
  const t = renderAgentNotice('approved', { requestId: 'kxqzbt', phone: '+56933333333', label: 'Diego', expiresAt: '2026-11-21T14:05:00.000Z' })
  assert.match(t, /kxqzbt was APPROVED by the owner/)
  assert.match(t, /until 2026-11-21T14:05:00.000Z/)
  assert.match(t, /does NOT make them an owner/)
  assert.match(renderAgentNotice('grant_expired', { requestId: 'kxqzbt', phone: '+569' }), /EXPIRED/)
})

test('agent notifications are source=system and can never claim is_owner', () => {
  const meta = buildChannelMeta({
    chatId: 'system', messageId: 'contact-request-approved-x', senderId: 'system', ts: new Date(T0).toISOString(), source: 'system',
    access: { ownerJids: ['system'] },
    extra: { kind: 'contact_request', outcome: 'approved', is_owner: 'true', user_id: OWNER_PN, source: 'user' },
  })
  assert.equal(meta.is_owner, 'false')
  assert.equal(meta.source, 'system')
  assert.equal(meta.user_id, 'system')
  assert.equal(meta.kind, 'contact_request')
  for (const v of Object.values(meta)) assert.equal(typeof v, 'string')
})

// ---------------------------------------------------------------------------
// Source tripwires — read server.ts as TEXT (never import it) and pin the
// wiring that the pure tests above rely on.
// ---------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url))
const serverSrc = fs.readFileSync(path.join(here, '..', 'server.ts'), 'utf8')

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  assert.ok(i >= 0, `marker not found: ${start}`)
  const j = src.indexOf(end, i + start.length)
  assert.ok(j > i, `end marker not found after ${start}: ${end}`)
  return src.slice(i, j)
}

test('tripwire — inbound loop drops non-notify and fromMe before handleInbound', () => {
  const loop = sliceBetween(serverSrc, "sock.ev.on('messages.upsert'", 'await handleInbound(msg)')
  assert.match(loop, /if \(type !== 'notify'\) return/)
  // The batch runs through forEachIsolated, so the per-message skip is a `return`
  // from the callback rather than a `continue`.
  assert.match(loop, /if \(msg\.key\.fromMe\) return/)
})

test('tripwire — agent tools cannot enable the feature, approve, or write permanent entries', () => {
  // The MCP cases only delegate to these two functions…
  const requestCase = sliceBetween(serverSrc, "case 'request_contact_access': {", '\n    }\n')
  const revokeCase = sliceBetween(serverSrc, "case 'revoke_contact_access': {", '\n    }\n')
  assert.match(requestCase, /return await requestContactAccessTool\(/)
  assert.match(revokeCase, /return revokeContactAccessTool\(/)
  // …whose bodies never reach the grant / toggle / decision machinery.
  const requestTool = sliceBetween(serverSrc, 'async function requestContactAccessTool(', '\n}\n')
  const revokeTool = sliceBetween(serverSrc, 'function revokeContactAccessTool(', '\n}\n')
  for (const block of [requestCase, revokeCase, requestTool, revokeTool]) {
    for (const forbidden of ['applyGrant(', 'planApproval(', 'withContactRequestsEnabled(', 'beginDecision(', 'executeContactDecision(', 'bindAltJidToGrant(', 'ownerJids.push', 'allowFrom.push', 'contactRequests:']) {
      assert.ok(!block.includes(forbidden), `agent tool must not reach ${forbidden}`)
    }
  }
  assert.ok(!requestTool.includes('saveAccess('), 'request_contact_access must not write access.json')
  // revoke only ever writes the result of a narrowing helper.
  assert.match(revokeTool, /const res = revokeGrantsForPhone\(fresh, phone\.digits\)/)
  assert.match(revokeTool, /saveAccess\(res\.access\)/)
  assert.equal(revokeTool.split('saveAccess(').length - 1, 1)
})

test('tripwire — grants are only written by the owner-decision executor', () => {
  const calls = serverSrc.split('planApproval(').length - 1
  assert.equal(calls, 1, 'planApproval must have exactly one call site')
  const exec = sliceBetween(serverSrc, 'async function executeContactDecision(', '\n}\n')
  assert.ok(exec.includes('planApproval('))
  assert.equal(serverSrc.split('withContactRequestsEnabled(').length - 1, 1, 'only the owner command toggles the feature')
  const cmd = sliceBetween(serverSrc, 'async function handleContactRequestsDmCommand(', '\n}\n')
  assert.ok(cmd.includes('withContactRequestsEnabled('))
  assert.ok(cmd.includes('authorizeContactOwnerAction('))
})

test('tripwire — prompts are protected from agent react/edit/delete', () => {
  for (const tool of ['react', 'edit_message', 'delete_message']) {
    const block = sliceBetween(serverSrc, `case '${tool}': {`, '\n    }\n')
    assert.match(block, /assertNotContactPrompt\(/, `${tool} must refuse plugin prompts`)
  }
})
