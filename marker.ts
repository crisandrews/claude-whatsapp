// Inbound-context marker file — published for peer plugins (e.g. OpenCLAUDE)
// that run in a separate MCP server process and cannot read the in-memory
// `currentInboundContext`. The marker mirrors that state on disk.
//
// Contract (consumed by peers):
//   - Path: `<channel-dir>/.last-inbound.json`
//   - Shape: `{ "version": 1, "chatId": "<jid>", "senderId": "<jid>", "ts": <epoch_ms> }`
//   - Atomic write-temp+rename, perms 0o600.
//   - TTL = `INBOUND_CONTEXT_TTL_MS` (60 s) — same as the in-memory context.
//   - No explicit clear: rely on TTL. A reader MUST treat
//     `Date.now() - ts > TTL` as "no context" and fail closed where applicable.
//   - Race semantics match the in-memory model: rapid back-to-back inbounds
//     from different chats overwrite. Concurrent inbounds are not queued.
//
// Privacy: same access controls as `access.json` (sibling file, 0o600). Anyone
// who can read the channel directory can read the marker.

import fs from 'fs'
import path from 'path'

export const MARKER_FILENAME = '.last-inbound.json'
export const MARKER_VERSION = 1
export const MARKER_TTL_MS = 60_000

export interface InboundMarkerPayload {
  version: number
  chatId: string
  senderId: string
  ts: number
}

/**
 * Write the marker atomically. Failures are silent — never throw out of a
 * messaging hot path. The on-disk marker is a peer-plugin convenience, not a
 * load-bearing primitive for this plugin itself.
 */
export function writeInboundMarker(
  channelDir: string,
  chatId: string,
  senderId: string,
  ts: number,
): void {
  if (!chatId || chatId === 'system') return
  const payload: InboundMarkerPayload = {
    version: MARKER_VERSION,
    chatId,
    senderId,
    ts,
  }
  const target = path.join(channelDir, MARKER_FILENAME)
  const tmp = target + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, target)
  } catch {
    // Best-effort; if the FS is read-only or permissions block us, the
    // marker just isn't published this turn. Peer plugins fall back to
    // their own ceiling.
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/**
 * Parse + validate a marker payload. Returns null on missing keys, wrong
 * version, malformed types, or TTL expiry. Pure (no fs access) so peer
 * implementations can share semantics by reading + parsing themselves.
 */
export function parseInboundMarker(
  raw: string,
  now: number = Date.now(),
): InboundMarkerPayload | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (o.version !== MARKER_VERSION) return null
  if (typeof o.chatId !== 'string' || !o.chatId) return null
  if (typeof o.senderId !== 'string' || !o.senderId) return null
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null
  if (now - o.ts > MARKER_TTL_MS) return null
  return {
    version: o.version,
    chatId: o.chatId,
    senderId: o.senderId,
    ts: o.ts,
  }
}
