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
  chunk,
  tryExtractJsonField,
  summarizePermissionInput,
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

test('matchesBot — LID and PN locals do not coincidentally collide', () => {
  // Baileys can deliver the owner's own JID under either namespace; the
  // server captures both `sock.user.id` (PN) and `sock.user.lid` and checks
  // them independently. Confirm distinct values don't cross-match on the
  // pure helper, which is what the server's closure layers on top of.
  assert.equal(matchesBot('12345678901234@lid', '15551234567', 's.whatsapp.net'), false)
  assert.equal(matchesBot('12345678901234@lid', '12345678901234', 'lid'), true)
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
// tryExtractJsonField
// ---------------------------------------------------------------------------
test('tryExtractJsonField — well-formed JSON', () => {
  assert.equal(tryExtractJsonField('{"command":"ls -la"}', 'command'), 'ls -la')
  assert.equal(tryExtractJsonField('{"file_path":"/tmp/x.ts","old_string":"a"}', 'file_path'), '/tmp/x.ts')
})

test('tryExtractJsonField — missing field returns null', () => {
  assert.equal(tryExtractJsonField('{"command":"ls"}', 'file_path'), null)
})

test('tryExtractJsonField — non-string field returns null', () => {
  assert.equal(tryExtractJsonField('{"count":3}', 'count'), null)
})

test('tryExtractJsonField — truncated JSON falls back to regex', () => {
  // Simulates CC's input_preview truncated to 200 chars + '…'
  const truncated = '{"file_path":"/Users/me/project/src/long-file.ts","old_string":"const x = 1\\nconst y = 2","new_string":"const x = 42\\nconst…'
  assert.equal(tryExtractJsonField(truncated, 'file_path'), '/Users/me/project/src/long-file.ts')
})

test('tryExtractJsonField — regex handles escaped quotes', () => {
  const truncated = '{"command":"echo \\"hello\\""'
  assert.equal(tryExtractJsonField(truncated, 'command'), 'echo "hello"')
})

test('tryExtractJsonField — empty/null inputs return null', () => {
  assert.equal(tryExtractJsonField('', 'x'), null)
  assert.equal(tryExtractJsonField('not json at all', 'x'), null)
})

// ---------------------------------------------------------------------------
// summarizePermissionInput
// ---------------------------------------------------------------------------
test('summarizePermissionInput — Bash extracts command', () => {
  const out = summarizePermissionInput('Bash', '{"command":"ls -la"}')
  assert.equal(out.codeBlock, 'ls -la')
  assert.equal(out.highlight, undefined)
})

test('summarizePermissionInput — Edit highlights file_path + keeps preview', () => {
  const out = summarizePermissionInput('Edit', '{"file_path":"/tmp/x.ts","old_string":"a"}')
  assert.equal(out.highlight, '📄 /tmp/x.ts')
  assert.ok(out.codeBlock?.includes('file_path'))
})

test('summarizePermissionInput — Read highlights file with no code block', () => {
  const out = summarizePermissionInput('Read', '{"file_path":"/tmp/x.ts"}')
  assert.equal(out.highlight, '👁 /tmp/x.ts')
  assert.equal(out.codeBlock, undefined)
})

test('summarizePermissionInput — WebFetch highlights URL', () => {
  const out = summarizePermissionInput('WebFetch', '{"url":"https://example.com/page"}')
  assert.equal(out.highlight, '🌐 https://example.com/page')
})

test('summarizePermissionInput — WebSearch highlights query', () => {
  const out = summarizePermissionInput('WebSearch', '{"query":"baileys docs"}')
  assert.equal(out.highlight, '🔍 baileys docs')
})

test('summarizePermissionInput — unknown tool falls back to code block', () => {
  const out = summarizePermissionInput('SomeNewTool', '{"x":1}')
  assert.equal(out.codeBlock, '{"x":1}')
  assert.equal(out.highlight, undefined)
})

test('summarizePermissionInput — empty preview returns empty', () => {
  assert.deepEqual(summarizePermissionInput('Bash', ''), {})
})

// ---------------------------------------------------------------------------
// chunk
// ---------------------------------------------------------------------------
test('chunk — empty string returns empty array', () => {
  assert.deepEqual(chunk('', 100, 'length'), [])
  assert.deepEqual(chunk('', 100, 'newline'), [])
})

test('chunk — text shorter than limit returns single piece', () => {
  assert.deepEqual(chunk('hello', 100, 'length'), ['hello'])
  assert.deepEqual(chunk('hello', 100, 'newline'), ['hello'])
})

test('chunk — length mode hard-cuts at exact limit', () => {
  const text = 'abcdefghij' // 10 chars
  assert.deepEqual(chunk(text, 4, 'length'), ['abcd', 'efgh', 'ij'])
})

test('chunk — newline mode prefers paragraph break past midpoint', () => {
  const text = 'first paragraph here\n\nsecond paragraph that is somewhat long'
  // limit 30: \n\n at position 20, midpoint=15 → 20 >= 15 ✓ honors it
  const out = chunk(text, 30, 'newline')
  assert.equal(out[0], 'first paragraph here')
  assert.ok(out[1].startsWith('second paragraph'))
})

test('chunk — newline mode falls back to line break when no paragraph past midpoint', () => {
  const text = 'short\nmedium length line that we want broken at the line break'
  // limit 25, midpoint=12: \n at position 5 (< 12), falls past
  // \n is the only newline; 5 < 12, so it goes to space
  const out = chunk(text, 25, 'newline')
  // should not break in the middle of a word — must be at last space ≤ 25
  assert.ok(!out[0].endsWith('len'))
  assert.ok(out[0].length <= 25)
})

test('chunk — newline mode falls back to space when no break is past midpoint', () => {
  const text = 'this is just words with no line breaks at all in the entire string'
  const out = chunk(text, 25, 'newline')
  // each chunk should end at a word boundary, not mid-word
  for (let i = 0; i < out.length - 1; i++) {
    assert.ok(out[i].length <= 25, `chunk ${i} too long: ${out[i].length}`)
    assert.ok(!/[a-z]$/i.test(out[i]) || out[i].endsWith(out[i].split(' ').pop() || ''),
      `chunk ${i} doesn't end on word boundary: "${out[i]}"`)
  }
})

test('chunk — newline mode hard-cuts when no soft break available at all', () => {
  const text = 'a'.repeat(50) // no spaces or newlines
  const out = chunk(text, 20, 'newline')
  assert.deepEqual(out, ['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(10)])
})

test('chunk — strips leading newlines from continuation chunks', () => {
  const text = 'first chunk content\n\n\n\nsecond chunk content'
  const out = chunk(text, 20, 'newline')
  // Continuation should not start with \n
  for (let i = 1; i < out.length; i++) {
    assert.ok(!out[i].startsWith('\n'), `chunk ${i} starts with newline: "${out[i].slice(0, 5)}"`)
  }
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
