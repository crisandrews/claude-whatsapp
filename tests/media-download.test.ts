import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  downloadMedia,
  decryptMedia,
  findMediaNode,
  reviveStoredMessage,
  toBytes,
  forEachIsolated,
  downloadFailedSuffix,
  MediaDownloadError,
  DOWNLOAD_FAILED_HINT,
} from '../media-download.ts'
import { initDb, closeDb, indexMessage, getRawMessage, searchMessages } from '../db.ts'

// --- helpers ---------------------------------------------------------------

// Deterministic stand-in for Baileys' HKDF expansion (same shape, no deps).
function fakeKeys(mediaKey: Buffer) {
  const k = crypto.createHash('sha512').update(mediaKey).digest()
  const k2 = crypto.createHash('sha512').update(k).digest()
  return { iv: k.subarray(0, 16), cipherKey: k.subarray(16, 48), macKey: k2.subarray(0, 32) }
}

// WhatsApp media framing: AES-256-CBC ciphertext + first 10 bytes of HMAC-SHA256(iv || ciphertext).
function encrypt(plain: Buffer, mediaKey: Buffer): Buffer {
  const { iv, cipherKey, macKey } = fakeKeys(mediaKey)
  const aes = crypto.createCipheriv('aes-256-cbc', cipherKey, iv)
  const body = Buffer.concat([aes.update(plain), aes.final()])
  const mac = crypto.createHmac('sha256', macKey).update(iv).update(body).digest().subarray(0, 10)
  return Buffer.concat([body, mac])
}

function voiceNote(size = 70_000) {
  const mediaKey = crypto.randomBytes(32)
  const plain = crypto.randomBytes(size)
  const enc = encrypt(plain, mediaKey)
  const node = {
    mediaKey,
    directPath: '/v/t62.7117-24/synthetic.enc?ccb=1',
    url: 'https://mmg.whatsapp.net/v/t62.7117-24/synthetic.enc?ccb=1',
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
    fileEncSha256: crypto.createHash('sha256').update(enc).digest(),
  }
  return { mediaKey, plain, enc, node }
}

const okResponse = (enc: Buffer) => new Response(enc, { status: 200 })

// A body that delivers part of the file and then dies, exactly like undici
// does when the socket closes mid-download: the error is raised asynchronously
// by the stream, after fetch() itself already resolved.
function terminatedResponse(enc: Buffer) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.subarray(0, Math.floor(enc.length / 2)))
      setTimeout(() => controller.error(new TypeError('terminated')), 5)
    },
  })
  return new Response(body, { status: 200 })
}

function deps(responses: Array<() => Response | Promise<Response>>, extra: Record<string, unknown> = {}) {
  const calls: string[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  let i = 0
  return {
    calls, sleeps, logs,
    deps: {
      getMediaKeys: (k: Buffer) => fakeKeys(k),
      fetchImpl: (async (url: any) => {
        calls.push(String(url))
        const next = responses[Math.min(i++, responses.length - 1)]
        return next()
      }) as typeof fetch,
      sleep: async (ms: number) => { sleeps.push(ms) },
      log: (l: string) => { logs.push(l) },
      ...extra,
    },
  }
}

// Fails the test if anything escapes as an uncaught exception / unhandled rejection.
async function withNoEscapedErrors(fn: () => Promise<void>) {
  const escaped: unknown[] = []
  const onErr = (e: unknown) => { escaped.push(e) }
  process.on('uncaughtException', onErr)
  process.on('unhandledRejection', onErr)
  try {
    await fn()
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    process.off('uncaughtException', onErr)
    process.off('unhandledRejection', onErr)
  }
  assert.deepEqual(escaped, [], 'no error may escape the download promise')
}

// --- retry behaviour -------------------------------------------------------

test('transient failure then success: the download is retried and returns the media', async () => {
  const v = voiceNote()
  const d = deps([() => terminatedResponse(v.enc), () => okResponse(v.enc)])
  await withNoEscapedErrors(async () => {
    const out = await downloadMedia(v.node, 'audio', d.deps)
    assert.ok(out.equals(v.plain))
  })
  assert.equal(d.calls.length, 2)
  assert.deepEqual(d.sleeps, [500])
  assert.match(d.logs.join('\n'), /attempt 1\/3 failed: TypeError: terminated; retrying/)
})

test('async stream error: "terminated" raised mid-body rejects the promise instead of escaping', async () => {
  const v = voiceNote()
  const d = deps([() => terminatedResponse(v.enc)])
  await withNoEscapedErrors(async () => {
    await assert.rejects(
      downloadMedia(v.node, 'audio', d.deps),
      (err: any) => {
        assert.ok(err instanceof MediaDownloadError)
        assert.match(err.message, /terminated/)
        assert.equal(err.attempts, 3)
        return true
      },
    )
  })
  assert.equal(d.calls.length, 3, 'three attempts')
  assert.deepEqual(d.sleeps, [500, 1500], 'short backoff between attempts')
})

test('fetch() rejecting outright is retried too', async () => {
  const v = voiceNote(1000)
  const d = deps([() => { throw new TypeError('fetch failed') }, () => okResponse(v.enc)])
  assert.ok((await downloadMedia(v.node, 'audio', d.deps)).equals(v.plain))
  assert.equal(d.calls.length, 2)
})

test('a body that ends early without an error fails the integrity check and is retried', async () => {
  const v = voiceNote()
  const short = v.enc.subarray(0, 32_000 + 10) // still block-aligned + "mac"
  const d = deps([() => okResponse(short), () => okResponse(v.enc)])
  assert.ok((await downloadMedia(v.node, 'audio', d.deps)).equals(v.plain))
  assert.match(d.logs[0], /integrity check failed/)
})

test('without fileEncSha256 the trailing MAC catches a truncated body', async () => {
  const v = voiceNote()
  const node = { ...v.node, fileEncSha256: undefined }
  const d = deps([() => okResponse(v.enc.subarray(0, 32_000 + 10)), () => okResponse(v.enc)])
  assert.ok((await downloadMedia(node, 'audio', d.deps)).equals(v.plain))
  assert.match(d.logs[0], /MAC check failed/)
})

test('a stalled download is aborted by the idle timeout and retried', async () => {
  const v = voiceNote(1000)
  const hang = () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(v.enc.subarray(0, 16)) } }), { status: 200 })
  const d = deps([hang, () => okResponse(v.enc)])
  await withNoEscapedErrors(async () => {
    const out = await downloadMedia(v.node, 'audio', d.deps, { idleTimeoutMs: 40 })
    assert.ok(out.equals(v.plain))
  })
  assert.match(d.logs[0], /stalled/)
})

test('expired media (HTTP 410/404) triggers a re-upload request and uses the refreshed path', async () => {
  for (const status of [410, 404]) {
    const v = voiceNote(1000)
    let reuploads = 0
    const d = deps([() => new Response('gone', { status }), () => okResponse(v.enc)], {
      reupload: async () => {
        reuploads++
        return { ...v.node, url: undefined, directPath: '/v/fresh.enc' }
      },
    })
    assert.ok((await downloadMedia(v.node, 'audio', d.deps)).equals(v.plain))
    assert.equal(reuploads, 1)
    assert.equal(d.calls[1], 'https://mmg.whatsapp.net/v/fresh.enc')
  }
})

test('a failing re-upload request does not abort the remaining attempts', async () => {
  const v = voiceNote(1000)
  const d = deps([() => new Response('gone', { status: 410 }), () => okResponse(v.enc)], {
    reupload: async () => { throw new Error('device offline') },
  })
  assert.ok((await downloadMedia(v.node, 'audio', d.deps)).equals(v.plain))
  assert.match(d.logs.join('\n'), /re-upload request failed: Error: device offline/)
})

test('oversized media is rejected once, without retries', async () => {
  const v = voiceNote(5000)
  const d = deps([() => okResponse(v.enc)])
  await assert.rejects(downloadMedia(v.node, 'audio', d.deps, { maxBytes: 1000 }), (err: any) => err.tooLarge === true && err.retryable === false)
  assert.equal(d.calls.length, 1)
})

test('missing media key or URL fails fast', async () => {
  const d = deps([() => okResponse(Buffer.alloc(26))])
  await assert.rejects(downloadMedia({ directPath: '/x' }, 'audio', d.deps), /no media key/)
  await assert.rejects(downloadMedia({ mediaKey: crypto.randomBytes(32), url: 'https://example.com/x' }, 'audio', d.deps), /no valid media URL/)
  assert.equal(d.calls.length, 0)
})

// --- persistent failure: message is still stored, marked, and retryable -----

test('persistent failure: the message is still stored with the failure marker and can be retried from the stored raw message', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-test-'))
  try {
    assert.equal(await initDb(path.join(dir, 'messages.db')), true)
    const v = voiceNote()
    const msg = {
      key: { remoteJid: '56912345678@s.whatsapp.net', id: 'SYNTHETICVOICE01', fromMe: false },
      messageTimestamp: 1795000000,
      pushName: 'Ada',
      message: { audioMessage: v.node },
    }

    // What extractMessage() does for a voice note whose download keeps failing.
    const meta: Record<string, string> = { attachment_kind: 'voice', attachment_mimetype: 'audio/ogg' }
    let failed = false
    const dead = deps([() => terminatedResponse(v.enc)])
    await withNoEscapedErrors(async () => {
      try {
        await downloadMedia(findMediaNode(msg.message)!.node, 'audio', dead.deps)
      } catch (err) {
        assert.ok(err instanceof MediaDownloadError)
        meta.attachment_download_failed = 'true'
        failed = true
      }
    })
    assert.equal(failed, true)
    assert.equal(dead.calls.length, 3)
    const text = `[Voice message received${downloadFailedSuffix(failed)}]`
    assert.equal(text, '[Voice message received — download failed; use download_attachment to retry]')

    // ...and it is indexed regardless, exactly as handleInbound() does.
    indexMessage({ id: msg.key.id, chat_id: msg.key.remoteJid, sender_id: msg.key.remoteJid, push_name: 'Ada', ts: msg.messageTimestamp, direction: 'in', text, meta, raw_message: msg })
    const hit = searchMessages({ query: 'download failed', chat_id: msg.key.remoteJid })
    assert.equal(hit.length, 1)
    assert.equal(hit[0].id, 'SYNTHETICVOICE01')
    assert.equal((hit[0].meta as any).attachment_download_failed, 'true')

    // download_attachment(message_id): the raw message went through JSON, so
    // its binary fields must be revived before the retry can work.
    const raw = getRawMessage('SYNTHETICVOICE01', [msg.key.remoteJid])
    assert.ok(raw, 'raw message is stored')
    assert.equal(Buffer.isBuffer(raw.message.audioMessage.mediaKey), false)
    const media = findMediaNode(reviveStoredMessage(raw).message)!
    assert.ok(Buffer.isBuffer(media.node.mediaKey))
    const alive = deps([() => okResponse(v.enc)])
    assert.ok((await downloadMedia(media.node, media.type, alive.deps)).equals(v.plain))
  } finally {
    closeDb()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// --- isolation --------------------------------------------------------------

test('one failing message never stops the rest of the batch', async () => {
  const handled: number[] = []
  const errors: Array<[string, number]> = []
  await forEachIsolated([1, 2, 3, 4], async (n) => {
    if (n === 2) throw new TypeError('terminated')
    if (n === 3) return Promise.reject(new Error('boom'))
    handled.push(n)
  }, (err, n) => { errors.push([(err as Error).message, n]) })
  assert.deepEqual(handled, [1, 4])
  assert.deepEqual(errors, [['terminated', 2], ['boom', 3]])
  // A throwing error reporter is contained as well.
  await forEachIsolated([1, 2], async (n) => { if (n === 1) throw new Error('x'); handled.push(n) }, () => { throw new Error('reporter') })
  assert.deepEqual(handled, [1, 4, 2])
})

// --- small helpers ----------------------------------------------------------

test('findMediaNode unwraps ephemeral / view-once / document-with-caption wrappers', () => {
  const a = { mediaKey: 'x' }
  assert.deepEqual(findMediaNode({ audioMessage: a }), { type: 'audio', field: 'audioMessage', node: a })
  assert.equal(findMediaNode({ ephemeralMessage: { message: { imageMessage: a } } })?.type, 'image')
  assert.equal(findMediaNode({ viewOnceMessageV2: { message: { videoMessage: a } } })?.type, 'video')
  assert.equal(findMediaNode({ documentWithCaptionMessage: { message: { documentMessage: a } } })?.type, 'document')
  assert.equal(findMediaNode({ stickerMessage: a })?.type, 'sticker')
  assert.equal(findMediaNode({ conversation: 'hi' }), null)
  assert.equal(findMediaNode(undefined), null)
})

test('toBytes accepts every shape a bytes field takes after a JSON round trip', () => {
  const b = Buffer.from([1, 2, 3, 250])
  assert.ok(toBytes(b)!.equals(b))
  assert.ok(toBytes(new Uint8Array(b))!.equals(b))
  assert.ok(toBytes(b.toString('base64'))!.equals(b))
  assert.ok(toBytes(JSON.parse(JSON.stringify(b)))!.equals(b))
  assert.ok(toBytes(JSON.parse(JSON.stringify(new Uint8Array(b))))!.equals(b))
  assert.equal(toBytes(undefined), null)
  assert.equal(toBytes({ foo: 1 }), null)
})

test('failure marker text', () => {
  assert.equal(downloadFailedSuffix(false), '')
  assert.equal(downloadFailedSuffix(true), ` — ${DOWNLOAD_FAILED_HINT}`)
})

// --- compatibility with the real Baileys media format -----------------------

test('decrypts media produced by Baileys itself (key derivation, MAC and fileEncSha256 framing)', async (t) => {
  let baileys: any
  try { baileys = await import('@whiskeysockets/baileys') } catch { return t.skip('Baileys not installed') }
  if (!baileys.encryptedStream || !baileys.getMediaKeys) return t.skip('Baileys media helpers not exported')
  const plain = crypto.randomBytes(40_003)
  const r = await baileys.encryptedStream(plain, 'audio')
  const enc = fs.readFileSync(r.encFilePath)
  fs.rmSync(r.encFilePath, { force: true })
  const real = { getMediaKeys: baileys.getMediaKeys, fetchImpl: (async () => okResponse(enc)) as typeof fetch }

  // Verified through fileEncSha256.
  const node = { mediaKey: r.mediaKey, directPath: '/v/synthetic.enc', fileEncSha256: r.fileEncSha256 }
  assert.ok((await downloadMedia(node, 'audio', real)).equals(plain))
  // Verified through the trailing MAC, with the key as stored in messages.db (base64).
  const stored = { mediaKey: Buffer.from(r.mediaKey).toString('base64'), directPath: '/v/synthetic.enc' }
  assert.ok((await downloadMedia(stored, 'audio', real)).equals(plain))
  // The MAC check really is checking something.
  const keys = await baileys.getMediaKeys(r.mediaKey, 'audio')
  const tampered = Buffer.from(enc)
  tampered[100] ^= 0xff
  assert.throws(() => decryptMedia(tampered, keys), /MAC check failed/)
})
