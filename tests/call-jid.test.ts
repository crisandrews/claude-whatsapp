// Unit tests for the caller identity of an incoming call offer.
// Imports PURE modules only — never server.ts / bootstrap.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripJidDevice } from '../lib.ts'
import { buildChannelMeta } from '../channel-meta.ts'

const serverSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.ts'),
  'utf8',
)

test('stripJidDevice — drops the :device part, keeps the namespace', () => {
  assert.equal(stripJidDevice('12345678901234:33@lid'), '12345678901234@lid')
  assert.equal(stripJidDevice('56912345678:7@s.whatsapp.net'), '56912345678@s.whatsapp.net')
})

test('stripJidDevice — a JID without a device part is unchanged', () => {
  assert.equal(stripJidDevice('12345678901234@lid'), '12345678901234@lid')
  assert.equal(stripJidDevice('56912345678@s.whatsapp.net'), '56912345678@s.whatsapp.net')
  assert.equal(stripJidDevice('120363000000000001@g.us'), '120363000000000001@g.us')
})

test('stripJidDevice — input that is not a JID is returned as is', () => {
  assert.equal(stripJidDevice('not-a-jid'), 'not-a-jid')
  assert.equal(stripJidDevice(''), '')
})

test('call offer from a device JID is attributed to the allowlisted user', () => {
  const raw = '12345678901234:33@lid'
  const caller = stripJidDevice(raw)
  const access: any = { ownerJids: ['12345678901234@lid'], allowFrom: ['12345678901234@lid'] }
  assert.ok(access.allowFrom.includes(caller))
  assert.ok(!access.allowFrom.includes(raw))
  const meta = buildChannelMeta({
    chatId: caller,
    messageId: 'call-ABC',
    senderId: caller,
    ts: new Date(0).toISOString(),
    access,
    extra: { kind: 'call_offer', call_id: 'ABC', call_from: raw, is_video: 'false' },
  } as any)
  assert.equal(meta.chat_id, '12345678901234@lid')
  assert.equal(meta.user_id, '12345678901234@lid')
  assert.equal(meta.is_owner, 'true')
  // reject_call needs the device JID exactly as Baileys reported it.
  assert.equal(meta.call_from, raw)
})

test('tripwire — the call handler normalizes the caller but keeps call_from raw', () => {
  const i = serverSrc.indexOf("sock.ev.on('call'")
  const j = serverSrc.indexOf("sock.ev.on('messages.upsert'", i)
  assert.ok(i >= 0 && j > i)
  const handler = serverSrc.slice(i, j)
  assert.match(handler, /const callerJid = stripJidDevice\(String\(c\.from\)\)/)
  assert.match(handler, /setInboundContext\(callerJid, callerJid\)/)
  assert.match(handler, /chatId: callerJid,/)
  assert.match(handler, /senderId: callerJid,/)
  assert.match(handler, /call_from: c\.from,/)
})
