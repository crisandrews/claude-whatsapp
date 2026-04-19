import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  splitJid,
  matchesBot,
  parsePermissionReply,
  acquireLock,
  tryCreateLockFile,
  unlinkIfExists,
} from './lib.js'

// ---------------------------------------------------------------------------
// splitJid
// ---------------------------------------------------------------------------
test('splitJid — phone JID without device suffix', () => {
  assert.deepEqual(splitJid('15551234567@s.whatsapp.net'), {
    local: '15551234567',
    namespace: 's.whatsapp.net',
  })
})

test('splitJid — phone JID with device suffix', () => {
  assert.deepEqual(splitJid('15551234567:5@s.whatsapp.net'), {
    local: '15551234567',
    namespace: 's.whatsapp.net',
  })
})

test('splitJid — LID', () => {
  assert.deepEqual(splitJid('12345678901234@lid'), {
    local: '12345678901234',
    namespace: 'lid',
  })
})

test('splitJid — group JID', () => {
  assert.deepEqual(splitJid('120363xxxxxxxxx@g.us'), {
    local: '120363xxxxxxxxx',
    namespace: 'g.us',
  })
})

test('splitJid — null/undefined/empty/no-at returns null', () => {
  assert.equal(splitJid(null), null)
  assert.equal(splitJid(undefined), null)
  assert.equal(splitJid(''), null)
  assert.equal(splitJid('justastring'), null)
  assert.equal(splitJid('@nolocal'), null)
  assert.equal(splitJid('nolocal@'), null)
})

// ---------------------------------------------------------------------------
// matchesBot
// ---------------------------------------------------------------------------
test('matchesBot — same namespace + local', () => {
  assert.equal(matchesBot('15551234567@s.whatsapp.net', '15551234567', 's.whatsapp.net'), true)
})

test('matchesBot — strips device suffix on input', () => {
  assert.equal(matchesBot('15551234567:7@s.whatsapp.net', '15551234567', 's.whatsapp.net'), true)
})

test('matchesBot — different namespaces do NOT match (no LID↔phone bridging)', () => {
  // Same number in @lid vs @s.whatsapp.net is treated as distinct — Sprint 0
  // is conservative; a LID↔phone resolver could come later.
  assert.equal(matchesBot('15551234567@lid', '15551234567', 's.whatsapp.net'), false)
})

test('matchesBot — different local does not match', () => {
  assert.equal(matchesBot('99999999999@s.whatsapp.net', '15551234567', 's.whatsapp.net'), false)
})

test('matchesBot — null bot identity returns false', () => {
  assert.equal(matchesBot('15551234567@s.whatsapp.net', null, 's.whatsapp.net'), false)
  assert.equal(matchesBot('15551234567@s.whatsapp.net', '15551234567', null), false)
})

test('matchesBot — null jid returns false', () => {
  assert.equal(matchesBot(null, '15551234567', 's.whatsapp.net'), false)
})

// ---------------------------------------------------------------------------
// parsePermissionReply
// Spec: /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i — 5 letters, no `l`,
// case-insensitive (mobile autocaps), result lowercased so map lookup
// matches CC's lowercase request_id.
// ---------------------------------------------------------------------------
test('parsePermissionReply — yes', () => {
  assert.deepEqual(parsePermissionReply('yes tbxkq'), { requestId: 'tbxkq', behavior: 'allow' })
})

test('parsePermissionReply — no', () => {
  assert.deepEqual(parsePermissionReply('no tbxkq'), { requestId: 'tbxkq', behavior: 'deny' })
})

test('parsePermissionReply — short forms y/n', () => {
  assert.deepEqual(parsePermissionReply('y tbxkq'), { requestId: 'tbxkq', behavior: 'allow' })
  assert.deepEqual(parsePermissionReply('n tbxkq'), { requestId: 'tbxkq', behavior: 'deny' })
})

test('parsePermissionReply — autocaps lowered', () => {
  assert.deepEqual(parsePermissionReply('YES TBXKQ'), { requestId: 'tbxkq', behavior: 'allow' })
  assert.deepEqual(parsePermissionReply('No Tbxkq'), { requestId: 'tbxkq', behavior: 'deny' })
})

test('parsePermissionReply — leading/trailing whitespace ok', () => {
  assert.deepEqual(parsePermissionReply('  yes tbxkq  '), { requestId: 'tbxkq', behavior: 'allow' })
})

test('parsePermissionReply — extra text rejected', () => {
  assert.equal(parsePermissionReply('yes tbxkq extra'), null)
  assert.equal(parsePermissionReply('please yes tbxkq'), null)
})

test('parsePermissionReply — random text returns null', () => {
  assert.equal(parsePermissionReply('hello world'), null)
  assert.equal(parsePermissionReply(''), null)
  assert.equal(parsePermissionReply('yes'), null) // no id
  assert.equal(parsePermissionReply('tbxkq'), null) // no behavior word
})

test('parsePermissionReply — letter `l` rejected (looks like 1/I)', () => {
  assert.equal(parsePermissionReply('yes abcdl'), null)
  assert.equal(parsePermissionReply('YES ABCDL'), null)
})

test('parsePermissionReply — digits rejected (CC ID alphabet is letters only)', () => {
  assert.equal(parsePermissionReply('yes abc12'), null)
  assert.equal(parsePermissionReply('yes 12345'), null)
})

test('parsePermissionReply — wrong length rejected', () => {
  assert.equal(parsePermissionReply('yes abcd'), null) // 4 chars
  assert.equal(parsePermissionReply('yes abcdef'), null) // 6 chars
  assert.equal(parsePermissionReply('yes abc'), null) // 3 chars
})

// ---------------------------------------------------------------------------
// acquireLock — uses real filesystem in a tmp dir
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wachan-test-'))
}

function makeFakePid(): number {
  // Pick a PID that almost certainly doesn't exist on this machine — high range.
  return 999_999_999
}

test('acquireLock — fresh lock file', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    const result = acquireLock({ lockPath, ownerPid: process.pid })
    assert.equal(result.kind, 'acquired')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — contended by live PID', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.writeFileSync(lockPath, '12345')
    const result = acquireLock({
      lockPath,
      ownerPid: process.pid,
      isAlive: (pid) => pid === 12345,
    })
    assert.equal(result.kind, 'contended')
    if (result.kind === 'contended') assert.equal(result.existingPid, 12345)
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — stale PID gets reclaimed', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.writeFileSync(lockPath, String(makeFakePid()))
    const result = acquireLock({
      lockPath,
      ownerPid: process.pid,
      isAlive: () => false,
    })
    assert.equal(result.kind, 'acquired')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — corrupt PID file gets reclaimed', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.writeFileSync(lockPath, 'abc-not-a-number')
    const logs: string[] = []
    const result = acquireLock({
      lockPath,
      ownerPid: process.pid,
      isAlive: () => false,
      log: (m) => logs.push(m),
    })
    assert.equal(result.kind, 'acquired')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid))
    assert.ok(logs.some((m) => m.includes('corrupt')))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — empty PID file gets reclaimed', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.writeFileSync(lockPath, '')
    const result = acquireLock({
      lockPath,
      ownerPid: process.pid,
      isAlive: () => false,
    })
    assert.equal(result.kind, 'acquired')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — same-PID stale entry gets reclaimed', () => {
  // E.g. our own process crashed in a prior cleanup; the lock still has our PID.
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.writeFileSync(lockPath, String(process.pid))
    const result = acquireLock({ lockPath, ownerPid: process.pid })
    assert.equal(result.kind, 'acquired')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('acquireLock — filesystem error surfaces (read-only directory)', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    fs.chmodSync(dir, 0o500) // r-x, no write
    const result = acquireLock({ lockPath, ownerPid: process.pid })
    assert.equal(result.kind, 'error')
    if (result.kind === 'error') assert.match(result.error, /EACCES|permission|denied/i)
  } finally {
    try { fs.chmodSync(dir, 0o700) } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('tryCreateLockFile — second call to same path returns exists', () => {
  const dir = makeTmpDir()
  const lockPath = path.join(dir, 'lock')
  try {
    assert.equal(tryCreateLockFile(lockPath, process.pid).kind, 'acquired')
    assert.equal(tryCreateLockFile(lockPath, process.pid).kind, 'exists')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('unlinkIfExists — missing file returns ok', () => {
  const dir = makeTmpDir()
  try {
    const result = unlinkIfExists(path.join(dir, 'no-such-file'))
    assert.equal(result.kind, 'ok')
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
