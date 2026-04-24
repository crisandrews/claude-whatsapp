// Tests for the SQLite-backed helpers added in v1.13.0+ (list_chats,
// get_message_context, search_contact, get_chat_analytics, get_raw_message,
// list_group_senders). Pure DB-level tests against a temp SQLite file —
// no Baileys, no network. Each test sets up its own DB and tears it down
// so they can be re-ordered freely.

import test from 'node:test'
import assert from 'node:assert'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  initDb,
  closeDb,
  indexMessage,
  listChats,
  getMessageContext,
  searchContacts,
  getChatAnalytics,
  getRawMessage,
  getChatSenders,
  searchMessages,
  getMessages,
  formatExport,
} from './db.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

async function setupTempDb(): Promise<string> {
  const tmpDb = path.join(os.tmpdir(), `whatsapp-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}.db`)
  await initDb(tmpDb)
  return tmpDb
}

function teardown(tmpDb: string) {
  closeDb()
  try { fs.unlinkSync(tmpDb) } catch {}
  try { fs.unlinkSync(tmpDb + '-wal') } catch {}
  try { fs.unlinkSync(tmpDb + '-shm') } catch {}
}

// ---------------------------------------------------------------------------
// listChats
// ---------------------------------------------------------------------------

test('listChats — orders by last_ts DESC and aggregates per chat', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'a1', chat_id: 'a@s.whatsapp.net', sender_id: 'a@s.whatsapp.net', push_name: 'Ada', ts: 1000, direction: 'in', text: 'hi from ada' })
    indexMessage({ id: 'a2', chat_id: 'a@s.whatsapp.net', sender_id: null, push_name: 'Claude', ts: 1100, direction: 'out', text: 'hi back' })
    indexMessage({ id: 'b1', chat_id: 'b@s.whatsapp.net', sender_id: 'b@s.whatsapp.net', push_name: 'Bruno', ts: 2000, direction: 'in', text: 'hi from bruno' })

    const result = listChats(['a@s.whatsapp.net', 'b@s.whatsapp.net'])
    assert.equal(result.length, 2)
    assert.equal(result[0].chat_id, 'b@s.whatsapp.net') // most recent first
    assert.equal(result[0].last_text, 'hi from bruno')
    assert.equal(result[0].last_direction, 'in')
    assert.equal(result[0].last_push_name, 'Bruno')
    assert.equal(result[0].msg_count, 1)
    assert.equal(result[1].chat_id, 'a@s.whatsapp.net')
    assert.equal(result[1].msg_count, 2)
    assert.equal(result[1].last_text, 'hi back')
    assert.equal(result[1].last_direction, 'out')
  } finally { teardown(db) }
})

test('listChats — filters out chats not in allowedChatIds', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'a1', chat_id: 'allowed@s.whatsapp.net', ts: 1000, direction: 'in', text: 'visible' })
    indexMessage({ id: 'b1', chat_id: 'denied@s.whatsapp.net', ts: 2000, direction: 'in', text: 'hidden' })

    const result = listChats(['allowed@s.whatsapp.net'])
    assert.equal(result.length, 1)
    assert.equal(result[0].chat_id, 'allowed@s.whatsapp.net')
  } finally { teardown(db) }
})

test('listChats — empty allowed list returns empty', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'a1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'hi' })
    const result = listChats([])
    assert.equal(result.length, 0)
  } finally { teardown(db) }
})

test('listChats — kind reflects DM vs group from JID suffix', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'g1', chat_id: '120363x@g.us', ts: 1000, direction: 'in', text: 'group msg' })
    indexMessage({ id: 'd1', chat_id: '5491155556666@s.whatsapp.net', ts: 2000, direction: 'in', text: 'dm msg' })
    const result = listChats(['120363x@g.us', '5491155556666@s.whatsapp.net'])
    const group = result.find((r) => r.chat_id === '120363x@g.us')
    const dm = result.find((r) => r.chat_id === '5491155556666@s.whatsapp.net')
    assert.equal(group?.kind, 'group')
    assert.equal(dm?.kind, 'dm')
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// getMessageContext
// ---------------------------------------------------------------------------

test('getMessageContext — returns N before + anchor + N after in chronological order', async () => {
  const db = await setupTempDb()
  try {
    for (let i = 0; i < 10; i++) {
      indexMessage({ id: `m${i}`, chat_id: 'a@s.whatsapp.net', ts: 1000 + i, direction: 'in', text: `msg ${i}` })
    }
    const ctx = getMessageContext('m5', 2, 3)
    assert.ok(ctx.anchor)
    assert.equal(ctx.anchor!.id, 'm5')
    assert.equal(ctx.before.length, 2)
    assert.equal(ctx.before[0].id, 'm3')
    assert.equal(ctx.before[1].id, 'm4')
    assert.equal(ctx.after.length, 3)
    assert.equal(ctx.after[0].id, 'm6')
    assert.equal(ctx.after[2].id, 'm8')
  } finally { teardown(db) }
})

test('getMessageContext — anchor not found returns null anchor', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'only one' })
    const ctx = getMessageContext('does-not-exist')
    assert.equal(ctx.anchor, null)
    assert.equal(ctx.before.length, 0)
    assert.equal(ctx.after.length, 0)
  } finally { teardown(db) }
})

test('getMessageContext — handles edge of history (fewer messages than requested)', async () => {
  const db = await setupTempDb()
  try {
    for (let i = 0; i < 3; i++) {
      indexMessage({ id: `m${i}`, chat_id: 'a@s.whatsapp.net', ts: 1000 + i, direction: 'in', text: `msg ${i}` })
    }
    const ctx = getMessageContext('m0', 5, 5)
    assert.equal(ctx.anchor!.id, 'm0')
    assert.equal(ctx.before.length, 0) // nothing before m0
    assert.equal(ctx.after.length, 2) // only m1 and m2 after
  } finally { teardown(db) }
})

test('getMessageContext — before=0 + after=0 returns just the anchor', async () => {
  const db = await setupTempDb()
  try {
    for (let i = 0; i < 5; i++) {
      indexMessage({ id: `m${i}`, chat_id: 'a@s.whatsapp.net', ts: 1000 + i, direction: 'in', text: `msg ${i}` })
    }
    const ctx = getMessageContext('m2', 0, 0)
    assert.equal(ctx.anchor!.id, 'm2')
    assert.equal(ctx.before.length, 0)
    assert.equal(ctx.after.length, 0)
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// searchContacts
// ---------------------------------------------------------------------------

test('searchContacts — matches push_name substring case-insensitively', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan Pérez', ts: 1000, direction: 'in', text: 'hi' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', sender_id: 'maria@s.whatsapp.net', push_name: 'María González', ts: 1100, direction: 'in', text: 'hello' })

    const result = searchContacts('juan', 20, ['a@s.whatsapp.net'])
    assert.equal(result.length, 1)
    assert.equal(result[0].sender_id, 'juan@s.whatsapp.net')
    assert.equal(result[0].push_name, 'Juan Pérez')
  } finally { teardown(db) }
})

test('searchContacts — matches sender_id substring (e.g. phone prefix)', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', sender_id: '5491155556666@s.whatsapp.net', push_name: null, ts: 1000, direction: 'in', text: 'hi' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', sender_id: '5491177778888@s.whatsapp.net', push_name: null, ts: 1100, direction: 'in', text: 'hello' })

    const result = searchContacts('549115', 20, ['a@s.whatsapp.net'])
    assert.equal(result.length, 1)
    assert.equal(result[0].sender_id, '5491155556666@s.whatsapp.net')
  } finally { teardown(db) }
})

test('searchContacts — respects allowedChatIds filter', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'allowed@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan', ts: 1000, direction: 'in', text: 'hi' })
    indexMessage({ id: 'm2', chat_id: 'denied@s.whatsapp.net', sender_id: 'pedro@s.whatsapp.net', push_name: 'Pedro', ts: 1100, direction: 'in', text: 'hi' })

    const result = searchContacts('e', 20, ['allowed@s.whatsapp.net']) // matches both push names but only allowed chat
    const senders = result.map((r) => r.sender_id)
    assert.ok(senders.includes('juan@s.whatsapp.net'))
    assert.ok(!senders.includes('pedro@s.whatsapp.net'))
  } finally { teardown(db) }
})

test('searchContacts — excludes outbound (Claude) messages', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'in1', chat_id: 'a@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan', ts: 1000, direction: 'in', text: 'hi' })
    indexMessage({ id: 'out1', chat_id: 'a@s.whatsapp.net', sender_id: 'claude@s.whatsapp.net', push_name: 'Claude', ts: 1100, direction: 'out', text: 'reply' })

    const result = searchContacts('e', 20, ['a@s.whatsapp.net']) // matches both names
    const senders = result.map((r) => r.sender_id)
    assert.ok(!senders.includes('claude@s.whatsapp.net'))
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// getChatAnalytics
// ---------------------------------------------------------------------------

test('getChatAnalytics — totals split inbound vs outbound', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'i1', chat_id: 'a@s.whatsapp.net', sender_id: 'x@s.whatsapp.net', push_name: 'Ada', ts: 1000, direction: 'in', text: 'a' })
    indexMessage({ id: 'i2', chat_id: 'a@s.whatsapp.net', sender_id: 'x@s.whatsapp.net', push_name: 'Ada', ts: 1100, direction: 'in', text: 'b' })
    indexMessage({ id: 'o1', chat_id: 'a@s.whatsapp.net', ts: 1200, direction: 'out', text: 'reply' })

    const r = getChatAnalytics('a@s.whatsapp.net')
    assert.ok(r)
    assert.equal(r!.total_messages, 3)
    assert.equal(r!.inbound_count, 2)
    assert.equal(r!.outbound_count, 1)
    assert.equal(r!.unique_senders, 1)
    assert.equal(r!.first_message_ts, 1000)
    assert.equal(r!.last_message_ts, 1200)
  } finally { teardown(db) }
})

test('getChatAnalytics — empty chat returns zeroed structure', async () => {
  const db = await setupTempDb()
  try {
    const r = getChatAnalytics('nonexistent@s.whatsapp.net')
    assert.ok(r)
    assert.equal(r!.total_messages, 0)
    assert.equal(r!.unique_senders, 0)
    assert.equal(r!.first_message_ts, null)
    assert.equal(r!.hourly_distribution.length, 24)
    assert.equal(r!.daily_distribution.length, 7)
  } finally { teardown(db) }
})

test('getChatAnalytics — since_ts filter applied', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'old', chat_id: 'a@s.whatsapp.net', sender_id: 'x@s.whatsapp.net', ts: 1000, direction: 'in', text: 'old' })
    indexMessage({ id: 'new', chat_id: 'a@s.whatsapp.net', sender_id: 'x@s.whatsapp.net', ts: 5000, direction: 'in', text: 'new' })

    const r = getChatAnalytics('a@s.whatsapp.net', 3000)
    assert.equal(r!.total_messages, 1)
    assert.equal(r!.first_message_ts, 5000)
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// getRawMessage
// ---------------------------------------------------------------------------

test('getRawMessage — round-trips raw_message JSON', async () => {
  const db = await setupTempDb()
  try {
    const raw = { key: { remoteJid: 'a@s.whatsapp.net', id: 'm1', fromMe: false }, message: { conversation: 'hi' } }
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'hi', raw_message: raw })

    const got = getRawMessage('m1')
    assert.deepEqual(got?.key, raw.key)
    assert.equal(got?.message?.conversation, 'hi')
  } finally { teardown(db) }
})

test('getRawMessage — returns null for missing or uncached message', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'no-raw', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'no raw stored' })
    assert.equal(getRawMessage('no-raw'), null)
    assert.equal(getRawMessage('does-not-exist'), null)
  } finally { teardown(db) }
})

test('getRawMessage — preserved across re-indexing without raw_message (UPSERT COALESCE)', async () => {
  const db = await setupTempDb()
  try {
    const raw = { key: { remoteJid: 'a@s.whatsapp.net', id: 'm1', fromMe: false }, message: { conversation: 'original' } }
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'original', raw_message: raw })
    // simulate an edit — re-index same id without raw_message
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1100, direction: 'in', text: 'edited', meta: { edited: '1' } })

    const got = getRawMessage('m1')
    assert.ok(got, 'raw_message should be preserved by UPSERT COALESCE')
    assert.equal(got?.message?.conversation, 'original')
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// getChatSenders
// ---------------------------------------------------------------------------

test('getChatSenders — aggregates per sender, latest push_name + count + last_seen', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'p1', chat_id: '120363x@g.us', sender_id: 'pedro@s.whatsapp.net', push_name: 'Pedro', ts: 1000, direction: 'in', text: 'a' })
    indexMessage({ id: 'p2', chat_id: '120363x@g.us', sender_id: 'pedro@s.whatsapp.net', push_name: 'Pedro R.', ts: 1500, direction: 'in', text: 'b' }) // changed name
    indexMessage({ id: 'c1', chat_id: '120363x@g.us', sender_id: 'carlos@s.whatsapp.net', push_name: 'Carlos', ts: 1200, direction: 'in', text: 'c' })

    const senders = getChatSenders('120363x@g.us')
    assert.equal(senders.length, 2)
    const pedro = senders.find((s) => s.sender_id === 'pedro@s.whatsapp.net')
    assert.equal(pedro?.push_name, 'Pedro R.') // latest name
    assert.equal(pedro?.message_count, 2)
    assert.equal(pedro?.last_seen_ts, 1500)
  } finally { teardown(db) }
})

test('getChatSenders — excludes outbound (Claude) and respects since_ts', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'old', chat_id: '120363x@g.us', sender_id: 'pedro@s.whatsapp.net', push_name: 'Pedro', ts: 1000, direction: 'in', text: 'a' })
    indexMessage({ id: 'new', chat_id: '120363x@g.us', sender_id: 'carlos@s.whatsapp.net', push_name: 'Carlos', ts: 5000, direction: 'in', text: 'b' })
    indexMessage({ id: 'out', chat_id: '120363x@g.us', sender_id: 'claude@s.whatsapp.net', push_name: 'Claude', ts: 6000, direction: 'out', text: 'reply' })

    const senders = getChatSenders('120363x@g.us', 3000)
    assert.equal(senders.length, 1)
    assert.equal(senders[0].sender_id, 'carlos@s.whatsapp.net')
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// searchMessages (FTS5)
// ---------------------------------------------------------------------------

test('searchMessages — single term match returns hits', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'meeting tomorrow at 10am' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', ts: 1100, direction: 'in', text: 'lunch plans' })

    const hits = searchMessages({ query: 'meeting' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, 'm1')
  } finally { teardown(db) }
})

test('searchMessages — chat_id filter scopes results', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'meeting' })
    indexMessage({ id: 'm2', chat_id: 'b@s.whatsapp.net', ts: 1100, direction: 'in', text: 'meeting' })

    const hits = searchMessages({ query: 'meeting', chat_id: 'a@s.whatsapp.net' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].chat_id, 'a@s.whatsapp.net')
  } finally { teardown(db) }
})

test('searchMessages — limit parameter caps results', async () => {
  const db = await setupTempDb()
  try {
    for (let i = 0; i < 10; i++) {
      indexMessage({ id: `m${i}`, chat_id: 'a@s.whatsapp.net', ts: 1000 + i, direction: 'in', text: 'meeting agenda' })
    }
    const hits = searchMessages({ query: 'meeting', limit: 3 })
    assert.equal(hits.length, 3)
  } finally { teardown(db) }
})

test('searchMessages — no matches returns empty array', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'lunch tomorrow' })
    const hits = searchMessages({ query: 'pizza' })
    assert.equal(hits.length, 0)
  } finally { teardown(db) }
})

test('searchMessages — orders by ts DESC (most recent first)', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'old', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'meeting old' })
    indexMessage({ id: 'new', chat_id: 'a@s.whatsapp.net', ts: 5000, direction: 'in', text: 'meeting new' })

    const hits = searchMessages({ query: 'meeting' })
    assert.equal(hits.length, 2)
    assert.equal(hits[0].id, 'new')
    assert.equal(hits[1].id, 'old')
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

test('getMessages — returns chat messages ordered DESC, capped by limit', async () => {
  const db = await setupTempDb()
  try {
    for (let i = 0; i < 5; i++) {
      indexMessage({ id: `m${i}`, chat_id: 'a@s.whatsapp.net', ts: 1000 + i, direction: 'in', text: `msg ${i}` })
    }
    const rows = getMessages({ chat_id: 'a@s.whatsapp.net', limit: 3 })
    assert.equal(rows.length, 3)
    assert.equal(rows[0].id, 'm4') // most recent first
    assert.equal(rows[1].id, 'm3')
    assert.equal(rows[2].id, 'm2')
  } finally { teardown(db) }
})

test('getMessages — before_ts filter excludes newer messages', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'old' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', ts: 5000, direction: 'in', text: 'new' })

    const rows = getMessages({ chat_id: 'a@s.whatsapp.net', before_ts: 3000 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'm1')
  } finally { teardown(db) }
})

test('getMessages — after_ts filter excludes older messages', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'old' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', ts: 5000, direction: 'in', text: 'new' })

    const rows = getMessages({ chat_id: 'a@s.whatsapp.net', after_ts: 3000 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'm2')
  } finally { teardown(db) }
})

test('getMessages — empty chat returns empty array', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'other@s.whatsapp.net', ts: 1000, direction: 'in', text: 'hi' })
    const rows = getMessages({ chat_id: 'nonexistent@s.whatsapp.net' })
    assert.equal(rows.length, 0)
  } finally { teardown(db) }
})

// ---------------------------------------------------------------------------
// formatExport (pure formatter — no DB needed but uses MessageRow shape)
// ---------------------------------------------------------------------------

test('formatExport — markdown emits sender header + body', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan', ts: 1000, direction: 'in', text: 'hello' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', ts: 1100, direction: 'out', text: 'hi back' })

    const rows = getMessages({ chat_id: 'a@s.whatsapp.net' })
    const md = formatExport(rows, 'markdown')
    assert.match(md, /\*\*Juan\*\*/)
    assert.match(md, /hello/)
    assert.match(md, /\*\*Claude\*\*/)
    assert.match(md, /hi back/)
  } finally { teardown(db) }
})

test('formatExport — jsonl emits one JSON object per line', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan', ts: 1000, direction: 'in', text: 'a' })
    indexMessage({ id: 'm2', chat_id: 'a@s.whatsapp.net', ts: 1100, direction: 'out', text: 'b' })

    const rows = getMessages({ chat_id: 'a@s.whatsapp.net' })
    const jsonl = formatExport(rows, 'jsonl')
    const lines = jsonl.trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0])
    assert.equal(first.id, 'm1') // chronological order in export
    assert.equal(first.text, 'a')
  } finally { teardown(db) }
})

test('formatExport — csv has header row + escapes quotes/commas', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'm1', chat_id: 'a@s.whatsapp.net', sender_id: 'juan@s.whatsapp.net', push_name: 'Juan, "el grande"', ts: 1000, direction: 'in', text: 'hi, "comma" here' })

    const rows = getMessages({ chat_id: 'a@s.whatsapp.net' })
    const csv = formatExport(rows, 'csv')
    const lines = csv.trim().split('\n')
    assert.match(lines[0], /^ts_iso,direction,sender_id,push_name,chat_id,id,text$/)
    // commas + quotes inside fields must be escaped
    assert.match(lines[1], /"Juan, ""el grande"""/)
    assert.match(lines[1], /"hi, ""comma"" here"/)
  } finally { teardown(db) }
})

test('formatExport — empty rows returns empty string for jsonl/csv', async () => {
  const md = formatExport([], 'markdown')
  const jsonl = formatExport([], 'jsonl')
  const csv = formatExport([], 'csv')
  assert.equal(md, '')
  assert.equal(jsonl, '')
  // CSV still has header row
  assert.match(csv, /^ts_iso,direction/)
})

test('formatExport — sorts by ts ASC even if input is DESC', async () => {
  const db = await setupTempDb()
  try {
    indexMessage({ id: 'newer', chat_id: 'a@s.whatsapp.net', ts: 5000, direction: 'in', text: 'newer' })
    indexMessage({ id: 'older', chat_id: 'a@s.whatsapp.net', ts: 1000, direction: 'in', text: 'older' })
    // getMessages returns DESC; formatExport should re-sort to ASC for chronological export
    const rows = getMessages({ chat_id: 'a@s.whatsapp.net' })
    assert.equal(rows[0].id, 'newer') // confirm DESC input

    const jsonl = formatExport(rows, 'jsonl')
    const lines = jsonl.trim().split('\n')
    assert.equal(JSON.parse(lines[0]).id, 'older')
    assert.equal(JSON.parse(lines[1]).id, 'newer')
  } finally { teardown(db) }
})
