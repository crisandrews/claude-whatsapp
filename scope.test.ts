import test from 'node:test'
import assert from 'node:assert'
import {
  resolveScope,
  scopedAllowedChats,
  assertReadableScope,
  type InboundContext,
  type ScopeAccessView,
} from './scope.js'

const OWNER = '56912345678@s.whatsapp.net'
const OWNER_LID = '12345678901234@lid'
const USER_B = '56987654321@s.whatsapp.net'
const GROUP_A = '120363000000000001@g.us'
const GROUP_B = '120363000000000002@g.us'

function baseAccess(patch: Partial<ScopeAccessView> = {}): ScopeAccessView {
  return {
    ownerJids: [OWNER, OWNER_LID],
    allowFrom: [OWNER, OWNER_LID, USER_B],
    groups: { [GROUP_A]: {}, [GROUP_B]: {} },
    dms: {},
    ...patch,
  }
}

function ctx(chatId: string, senderId: string): InboundContext {
  return { chatId, senderId, ts: Date.now() }
}

// ---------------------------------------------------------------------------
// resolveScope
// ---------------------------------------------------------------------------

test('resolveScope — null ctx + no owner → bootstrap all', () => {
  const access = baseAccess({ ownerJids: [] })
  assert.equal(resolveScope(null, access), 'all')
})

test('resolveScope — null ctx + owner set → denied (fail-closed)', () => {
  const access = baseAccess()
  assert.equal(resolveScope(null, access), 'denied')
})

test('resolveScope — null ctx + owner set + ownerBypass → all', () => {
  const access = baseAccess()
  assert.equal(resolveScope(null, access, { ownerBypass: true }), 'all')
})

test('resolveScope — owner senderId → all, regardless of chat', () => {
  const access = baseAccess()
  assert.equal(resolveScope(ctx(GROUP_A, OWNER), access), 'all')
  assert.equal(resolveScope(ctx(USER_B, OWNER), access), 'all')
})

test('resolveScope — owner under alternate JID (@lid) also recognized', () => {
  const access = baseAccess()
  assert.equal(resolveScope(ctx(GROUP_A, OWNER_LID), access), 'all')
})

test('resolveScope — non-owner group defaults to own', () => {
  const access = baseAccess()
  const r = resolveScope(ctx(GROUP_A, USER_B), access)
  assert.notEqual(r, 'all')
  assert.notEqual(r, 'denied')
  if (typeof r !== 'string') {
    assert.deepEqual([...r.allowed], [GROUP_A])
  }
})

test('resolveScope — group historyScope "all" grants cross-chat read', () => {
  const access = baseAccess({
    groups: { [GROUP_A]: { historyScope: 'all' }, [GROUP_B]: {} },
  })
  assert.equal(resolveScope(ctx(GROUP_A, USER_B), access), 'all')
})

test('resolveScope — group historyScope as CSV extends own with extras', () => {
  const access = baseAccess({
    groups: { [GROUP_A]: { historyScope: [GROUP_B] }, [GROUP_B]: {} },
  })
  const r = resolveScope(ctx(GROUP_A, USER_B), access)
  if (typeof r !== 'string') {
    assert.deepEqual(new Set(r.allowed), new Set([GROUP_A, GROUP_B]))
  } else {
    assert.fail(`expected Set, got ${r}`)
  }
})

test('resolveScope — DM defaults to own', () => {
  const access = baseAccess()
  const r = resolveScope(ctx(USER_B, USER_B), access)
  if (typeof r !== 'string') {
    assert.deepEqual([...r.allowed], [USER_B])
  } else {
    assert.fail(`expected Set, got ${r}`)
  }
})

test('resolveScope — DM historyScope "all" grants cross-chat read', () => {
  const access = baseAccess({ dms: { [USER_B]: { historyScope: 'all' } } })
  assert.equal(resolveScope(ctx(USER_B, USER_B), access), 'all')
})

// ---------------------------------------------------------------------------
// scopedAllowedChats
// ---------------------------------------------------------------------------

test('scopedAllowedChats — null for unrestricted (owner)', () => {
  const access = baseAccess()
  assert.equal(scopedAllowedChats(ctx(GROUP_A, OWNER), access), null)
})

test('scopedAllowedChats — null for bootstrap (no owner, no ctx)', () => {
  const access = baseAccess({ ownerJids: [] })
  assert.equal(scopedAllowedChats(null, access), null)
})

test('scopedAllowedChats — [] for denied (owner set, no ctx)', () => {
  const access = baseAccess()
  assert.deepEqual(scopedAllowedChats(null, access), [])
})

test('scopedAllowedChats — intersects restricted scope with universe', () => {
  // GROUP_A has historyScope ['c@g.us'], but c@g.us is not in universe.
  const access = baseAccess({
    groups: {
      [GROUP_A]: { historyScope: ['c@g.us'] },
      [GROUP_B]: {},
    },
  })
  const out = scopedAllowedChats(ctx(GROUP_A, USER_B), access)
  // Only GROUP_A is in the universe; c@g.us is dropped as phantom.
  assert.deepEqual(out, [GROUP_A])
})

// ---------------------------------------------------------------------------
// assertReadableScope
// ---------------------------------------------------------------------------

test('assertReadableScope — throws for out-of-scope chat', () => {
  const access = baseAccess()
  assert.throws(
    () => assertReadableScope(ctx(GROUP_A, USER_B), access, GROUP_B),
    /history scope: chat_id/,
  )
})

test('assertReadableScope — no-op when chat is owned', () => {
  const access = baseAccess()
  assert.doesNotThrow(() =>
    assertReadableScope(ctx(GROUP_A, OWNER), access, GROUP_B),
  )
})

test('assertReadableScope — throws on denied fallback (owner set, no ctx)', () => {
  const access = baseAccess()
  assert.throws(
    () => assertReadableScope(null, access, GROUP_A),
    /history scope: no inbound context/,
  )
})

test('assertReadableScope — bootstrap (no owner, no ctx) is permissive', () => {
  const access = baseAccess({ ownerJids: [] })
  assert.doesNotThrow(() => assertReadableScope(null, access, GROUP_A))
})

test('assertReadableScope — ownerBypass unlocks denied fallback', () => {
  const access = baseAccess()
  assert.doesNotThrow(() =>
    assertReadableScope(null, access, GROUP_A, { ownerBypass: true }),
  )
})
