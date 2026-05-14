// Phase 6.1 — envelope-bound context resolution for claude-whatsapp's
// own internal MCP tools.
//
// Background: server.ts:694 holds `currentInboundContext` as a process-
// global singleton, overwritten by every inbound. Concurrent inbounds
// from chats A and B within the 60 s TTL → A's tool call can race
// against the global being rewritten to B's context, causing scope
// decisions to use the wrong context.
//
// Fix: when the agent forwards `meta.requestEnvelopeToken` from the
// notification (Phase 6 contract), the wrapper loads the matching
// envelope file and binds THAT context to THIS tool call. The global
// is then only used as fallback when no token is forwarded.
//
// Codex Phase 6.1 amendment D (CRITICAL correctness): distinguish
// "token absent" (use global, backwards-compat) from "token present
// but invalid/empty/forged" (fail-closed, throw). A truthiness check
// would allow `requestEnvelopeToken: ""` to silently fall back to the
// global — reopening the race.

import { InboundContext } from './scope.js'
import {
  ENVELOPE_TOKEN_REGEX,
  loadRequestEnvelope,
} from './envelope.js'

export type ResolvedContextResult =
  | { kind: 'global'; ctx: InboundContext | null }
  | { kind: 'envelope'; ctx: InboundContext }
  | { kind: 'invalid' }

/**
 * Resolve the InboundContext for a tool call.
 *
 * - `envelopeToken === undefined` → caller did NOT forward a token →
 *   use the process-global `getGlobalCtx()` (preserves pre-Phase-6.1
 *   behavior; still race-prone under concurrent inbounds, but the
 *   alternative is forcing every legacy caller to break).
 * - `envelopeToken` present and valid → load envelope file → bind.
 * - `envelopeToken` present and invalid/expired/missing → return
 *   `{ kind: 'invalid' }`. Caller fails-closed.
 */
export function resolveContextForCall(
  envelopeToken: string | undefined,
  channelDir: string,
  getGlobalCtx: () => InboundContext | null,
  now: number = Date.now(),
): ResolvedContextResult {
  if (envelopeToken === undefined) {
    return { kind: 'global', ctx: getGlobalCtx() }
  }
  const env = loadRequestEnvelope(channelDir, envelopeToken, now)
  if (!env) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'envelope',
    ctx: { chatId: env.chatId, senderId: env.senderId, ts: env.ts },
  }
}

/**
 * Extract `requestEnvelopeToken` from MCP tool args. Returns:
 *
 *   - `undefined` if the property is NOT present (use own-property
 *     check, not truthiness — `{ requestEnvelopeToken: "" }` is
 *     "present-but-empty", a different case).
 *   - the validated token string if present and well-formed.
 *
 * THROWS a history-scope error if the property is present but
 * malformed (non-string / empty / fails regex). This is the Codex
 * amendment D fail-closed semantics: a positive assertion of the
 * token that's actually garbage must NOT silently fall back to the
 * global context — that would reopen the race.
 */
export function extractEnvelopeToken(
  args: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!args || !Object.prototype.hasOwnProperty.call(args, 'requestEnvelopeToken')) {
    return undefined
  }
  const raw = (args as Record<string, unknown>).requestEnvelopeToken
  if (typeof raw !== 'string') {
    throw new Error(
      'history scope: requestEnvelopeToken must be a string when present',
    )
  }
  if (raw === '') {
    throw new Error(
      'history scope: requestEnvelopeToken cannot be empty when present',
    )
  }
  if (!ENVELOPE_TOKEN_REGEX.test(raw)) {
    throw new Error(
      'history scope: requestEnvelopeToken format invalid (expected 43-char base64url)',
    )
  }
  return raw
}
