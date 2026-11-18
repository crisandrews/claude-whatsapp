// ---------------------------------------------------------------------------
// Inbound media download — self-contained, retrying, and fully awaitable.
//
// Why this exists instead of Baileys' `downloadMediaMessage`: Baileys builds
// the decrypted stream as `fetched.pipe(decryptTransform)`. `.pipe()` does not
// forward errors, so when the HTTP body dies mid-download (undici raises
// `TypeError: terminated`) the error is emitted on the inner `fetched` stream,
// which has no listener. Node turns that into an uncaughtException, and the
// transform the caller is iterating never ends nor errors — the `for await`
// (or Baileys' own 'buffer' loop) hangs forever. The inbound handler never
// returns, so the message is neither stored nor delivered.
//
// Here the encrypted body is read through the fetch reader, so every failure
// (socket close, stall, truncation, HTTP error) surfaces as a rejected promise
// that a plain try/catch sees. Integrity is verified before decrypting, so a
// short read is retried instead of being saved as a corrupt file.
//
// No Baileys import: key derivation and re-upload are injected, which keeps
// this module loadable before deps are installed and testable offline.
// ---------------------------------------------------------------------------
import crypto from 'node:crypto'

export const MEDIA_HOST = 'mmg.whatsapp.net'
const MEDIA_ORIGIN = 'https://web.whatsapp.com'
const MAC_LENGTH = 10
const AES_BLOCK = 16
const REUPLOAD_STATUS = [404, 410]

/** Appended to the inbound placeholder when the media could not be fetched. */
export const DOWNLOAD_FAILED_HINT = 'download failed; use download_attachment to retry'

export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

export interface MediaKeys {
  iv: Uint8Array
  cipherKey: Uint8Array
  macKey?: Uint8Array
}

export interface DownloadDeps {
  /** Baileys' `getMediaKeys` (HKDF expansion of the media key). */
  getMediaKeys: (mediaKey: Buffer, type: MediaType) => Promise<MediaKeys> | MediaKeys
  /** Asks the sender's device to re-upload expired media; resolves to the refreshed media node. */
  reupload?: () => Promise<any>
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface DownloadOptions {
  /** Total tries, including the first one. Default 3. */
  attempts?: number
  /** Delay before retry N (last value repeats). Default [500, 1500]. */
  backoffMs?: number[]
  /** Abort an attempt when no bytes arrive for this long. Default 30 s. */
  idleTimeoutMs?: number
  /** Reject (without retrying) media larger than this. */
  maxBytes?: number
}

export class MediaDownloadError extends Error {
  status?: number
  retryable: boolean
  tooLarge: boolean
  attempts: number
  constructor(message: string, opts: { status?: number; retryable?: boolean; tooLarge?: boolean; attempts?: number; cause?: unknown } = {}) {
    super(message)
    this.name = 'MediaDownloadError'
    this.status = opts.status
    this.retryable = opts.retryable ?? true
    this.tooLarge = opts.tooLarge ?? false
    this.attempts = opts.attempts ?? 1
    if (opts.cause !== undefined) (this as any).cause = opts.cause
  }
}

/** Coerce a bytes field (live proto, or one that went through JSON) to a Buffer. */
export function toBytes(v: unknown): Buffer | null {
  if (v == null) return null
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength)
  if (typeof v === 'string') {
    // proto toJSON() serialises bytes as base64.
    const buf = Buffer.from(v.replace('data:;base64,', ''), 'base64')
    return buf.length > 0 ? buf : null
  }
  if (typeof v === 'object') {
    const o = v as any
    if (o.type === 'Buffer' && Array.isArray(o.data)) return Buffer.from(o.data)
    if (o.type === 'Buffer' && typeof o.data === 'string') return Buffer.from(o.data, 'base64')
    // A Uint8Array that went through JSON.stringify: {"0":1,"1":2,...}
    const keys = Object.keys(o)
    if (keys.length > 0 && keys.every((k, i) => k === String(i))) return Buffer.from(keys.map((k) => o[k] as number))
  }
  return null
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
] as const

const MEDIA_FIELDS: Array<[string, MediaType]> = [
  ['imageMessage', 'image'],
  ['videoMessage', 'video'],
  ['ptvMessage', 'video'],
  ['audioMessage', 'audio'],
  ['documentMessage', 'document'],
  ['stickerMessage', 'sticker'],
]

/** Locate the downloadable media node inside a message body (unwrapping ephemeral / view-once). */
export function findMediaNode(message: any): { type: MediaType; field: string; node: any } | null {
  let m = message
  for (let depth = 0; m && depth < 5; depth++) {
    const wrapper = WRAPPERS.find((w) => m[w]?.message)
    if (!wrapper) break
    m = m[wrapper].message
  }
  if (!m || typeof m !== 'object') return null
  for (const [field, type] of MEDIA_FIELDS) {
    if (m[field] && typeof m[field] === 'object') return { type, field, node: m[field] }
  }
  return null
}

/**
 * Restore the binary fields of a message read back from messages.db. The
 * cached raw message went through JSON, so `mediaKey` & co. are base64 strings
 * (or Buffer-JSON); Baileys' re-upload request needs real bytes. Mutates and
 * returns `raw`.
 */
export function reviveStoredMessage(raw: any): any {
  const found = findMediaNode(raw?.message)
  if (!found) return raw
  for (const f of ['mediaKey', 'fileSha256', 'fileEncSha256']) {
    const bytes = toBytes(found.node[f])
    if (bytes) found.node[f] = bytes
  }
  return raw
}

function mediaUrl(node: any): string | null {
  if (typeof node?.url === 'string' && node.url.startsWith(`https://${MEDIA_HOST}/`)) return node.url
  if (typeof node?.directPath === 'string' && node.directPath.startsWith('/')) return `https://${MEDIA_HOST}${node.directPath}`
  return null
}

function tooLarge(maxBytes: number): MediaDownloadError {
  return new MediaDownloadError(`File too large (over ${maxBytes} bytes)`, { retryable: false, tooLarge: true })
}

/**
 * Read the whole encrypted body. Every failure mode — including an error
 * raised by the body stream after the headers arrived — rejects this promise.
 */
async function fetchEncrypted(url: string, fetchImpl: typeof fetch, idleTimeoutMs: number, maxEncBytes: number, maxBytes: number): Promise<Buffer> {
  const ac = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onStall: (err: Error) => void = () => {}
  const stalled = new Promise<never>((_, reject) => { onStall = reject })
  stalled.catch(() => {})
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      onStall(new MediaDownloadError(`download stalled: no data for ${idleTimeoutMs} ms`))
      ac.abort()
    }, idleTimeoutMs)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  arm()
  try {
    const res = await Promise.race([
      fetchImpl(url, { method: 'GET', headers: { Origin: MEDIA_ORIGIN }, signal: ac.signal }),
      stalled,
    ])
    if (!res.ok) {
      res.body?.cancel().catch(() => {})
      throw new MediaDownloadError(`HTTP ${res.status} fetching media`, { status: res.status })
    }
    if (!res.body) throw new MediaDownloadError('media response has no body')
    if (Number(res.headers.get('content-length') || 0) > maxEncBytes) {
      res.body.cancel().catch(() => {})
      throw tooLarge(maxBytes)
    }
    reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), stalled])
      if (done) break
      if (!value) continue
      arm()
      total += value.byteLength
      if (total > maxEncBytes) throw tooLarge(maxBytes)
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } catch (err) {
    reader?.cancel().catch(() => {})
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Verify and decrypt a WhatsApp media blob: AES-256-CBC ciphertext followed by a 10-byte HMAC. */
export function decryptMedia(enc: Buffer, keys: MediaKeys, node: any = {}): Buffer {
  const expectedSha = toBytes(node.fileEncSha256)
  if (expectedSha && expectedSha.length === 32) {
    const actual = crypto.createHash('sha256').update(enc).digest()
    if (!actual.equals(expectedSha)) {
      throw new MediaDownloadError(`media integrity check failed (${enc.length} bytes received — truncated or corrupt)`)
    }
  } else if (keys.macKey && enc.length > MAC_LENGTH) {
    const body = enc.subarray(0, enc.length - MAC_LENGTH)
    const mac = crypto.createHmac('sha256', keys.macKey).update(keys.iv).update(body).digest().subarray(0, MAC_LENGTH)
    if (!mac.equals(enc.subarray(enc.length - MAC_LENGTH))) {
      throw new MediaDownloadError(`media MAC check failed (${enc.length} bytes received — truncated or corrupt)`)
    }
  }
  // Same framing as Baileys: decrypt whole AES blocks, the trailing MAC is left over.
  const cipherLen = enc.length - (enc.length % AES_BLOCK)
  if (cipherLen === 0) throw new MediaDownloadError('empty media body')
  try {
    const aes = crypto.createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv)
    return Buffer.concat([aes.update(enc.subarray(0, cipherLen)), aes.final()])
  } catch (err) {
    throw new MediaDownloadError(`media decryption failed: ${(err as Error)?.message ?? err}`, { cause: err })
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Download and decrypt one media node, retrying transient failures.
 * Rejects with MediaDownloadError once the attempts are exhausted (or
 * immediately for non-retryable conditions such as an oversized file).
 */
export async function downloadMedia(media: any, type: MediaType, deps: DownloadDeps, opts: DownloadOptions = {}): Promise<Buffer> {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : [500, 1500]
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000
  const maxBytes = opts.maxBytes ?? Number.MAX_SAFE_INTEGER
  // Ciphertext = plaintext padded to the next block + MAC.
  const maxEncBytes = maxBytes === Number.MAX_SAFE_INTEGER ? maxBytes : maxBytes + AES_BLOCK + MAC_LENGTH
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const log = deps.log ?? (() => {})

  let node = media
  let reuploaded = false
  let lastErr: unknown
  let tries = 0
  for (let attempt = 1; attempt <= attempts; attempt++) {
    tries = attempt
    try {
      const mediaKey = toBytes(node?.mediaKey)
      if (!mediaKey) throw new MediaDownloadError('message has no media key', { retryable: false })
      const url = mediaUrl(node)
      if (!url) throw new MediaDownloadError('message has no valid media URL or directPath', { retryable: false })
      const keys = await deps.getMediaKeys(mediaKey, type)
      const enc = await fetchEncrypted(url, fetchImpl, idleTimeoutMs, maxEncBytes, maxBytes)
      const plain = decryptMedia(enc, keys, node)
      if (plain.length === 0) throw new MediaDownloadError('empty media after decryption')
      if (plain.length > maxBytes) throw tooLarge(maxBytes)
      return plain
    } catch (err) {
      lastErr = err
      if (err instanceof MediaDownloadError && !err.retryable) break
      if (attempt === attempts) break
      const status = err instanceof MediaDownloadError ? err.status : undefined
      if (status !== undefined && REUPLOAD_STATUS.includes(status) && deps.reupload && !reuploaded) {
        // Media expired on WhatsApp's CDN — ask the sender's device to re-upload it.
        reuploaded = true
        try {
          const fresh = await deps.reupload()
          if (fresh) node = fresh
          log(`media expired (HTTP ${status}); re-upload requested`)
        } catch (reErr) {
          log(`media re-upload request failed: ${reErr}`)
        }
      }
      log(`media download attempt ${attempt}/${attempts} failed: ${err}; retrying`)
      await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)])
    }
  }
  if (lastErr instanceof MediaDownloadError) {
    lastErr.attempts = tries
    throw lastErr
  }
  const e = lastErr as any
  throw new MediaDownloadError(`${e?.name ? `${e.name}: ` : ''}${e?.message ?? e}`, { attempts: tries, cause: lastErr })
}

/** Suffix for an inbound placeholder: '' on success, ' — download failed; …' on failure. */
export function downloadFailedSuffix(failed: boolean): string {
  return failed ? ` — ${DOWNLOAD_FAILED_HINT}` : ''
}

/**
 * Run `fn` for each item in order; a throw (or rejection) from one item is
 * reported and never prevents the following items from being processed.
 */
export async function forEachIsolated<T>(items: Iterable<T>, fn: (item: T) => Promise<void> | void, onError: (err: unknown, item: T) => void): Promise<void> {
  for (const item of items) {
    try {
      await fn(item)
    } catch (err) {
      try { onError(err, item) } catch {}
    }
  }
}
