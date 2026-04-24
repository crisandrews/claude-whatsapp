// Chat scope governance — pure helpers for deciding which chat histories
// the current MCP tool call is allowed to read.
//
// The stateful bits (currentInboundContext, setInboundContext, getInboundContext)
// live in server.ts. These functions are pure so they can be unit-tested
// without spinning up a Baileys socket or MCP transport.
//
// Security model (option C):
//   - Context present, sender is owner → full access across all chats.
//   - Context present, non-owner       → sandboxed to ctx.chatId by default,
//                                         configurable via historyScope.
//   - No context, ownerJids empty      → full access (bootstrap mode; the
//                                         operator hasn't designated an owner
//                                         yet, so we can't enforce anything).
//   - No context, ownerJids set        → FAIL CLOSED. The operator must either
//                                         have the owner send an inbound first,
//                                         or set WHATSAPP_OWNER_BYPASS=1 in the
//                                         environment. Prevents the TTL bypass
//                                         where a slow WA turn lands after the
//                                         context expired and inherits 'all'.

export type HistoryScope = 'own' | 'all' | string[]

export interface InboundContext {
  chatId: string
  senderId: string
  ts: number
}

// Minimal shape needed by resolveScope. The real AccessState in server.ts has
// more fields; this interface captures only what scope resolution cares about.
export interface ScopeAccessView {
  ownerJids: string[]
  allowFrom: string[]
  groups: Record<string, { historyScope?: HistoryScope }>
  dms: Record<string, { historyScope?: HistoryScope }>
}

export type ResolvedScope = 'all' | 'denied' | { allowed: Set<string> }

export interface ResolveScopeOptions {
  ownerBypass?: boolean
}

export function resolveScope(
  ctx: InboundContext | null,
  access: ScopeAccessView,
  opts: ResolveScopeOptions = {},
): ResolvedScope {
  if (opts.ownerBypass) return 'all'
  if (!ctx) {
    if (access.ownerJids.length === 0) return 'all'
    return 'denied'
  }
  if (access.ownerJids.includes(ctx.senderId)) return 'all'
  const isGroup = ctx.chatId.endsWith('@g.us')
  const raw = isGroup
    ? access.groups[ctx.chatId]?.historyScope
    : access.dms[ctx.chatId]?.historyScope
  const scope = raw ?? 'own'
  if (scope === 'all') return 'all'
  if (scope === 'own') return { allowed: new Set([ctx.chatId]) }
  return { allowed: new Set([ctx.chatId, ...scope]) }
}

// Intersection of the current scope with the universe of allowlisted chats,
// for tools like list_chats / search_contact that enumerate a set up front.
// Returns null when scope is 'all' (caller uses the full universe). Returns
// [] for denied/empty scope (caller should return empty results, not throw —
// list_chats with [] is a normal empty response, not an error).
export function scopedAllowedChats(
  ctx: InboundContext | null,
  access: ScopeAccessView,
  opts: ResolveScopeOptions = {},
): string[] | null {
  const scope = resolveScope(ctx, access, opts)
  if (scope === 'all') return null
  if (scope === 'denied') return []
  const universe = new Set([...access.allowFrom, ...Object.keys(access.groups)])
  return [...scope.allowed].filter((id) => universe.has(id))
}

// Throws if chatId is not readable under the current scope. Used by handlers
// that already have a chat_id argument to gate.
export function assertReadableScope(
  ctx: InboundContext | null,
  access: ScopeAccessView,
  chatId: string,
  opts: ResolveScopeOptions = {},
): void {
  const scope = resolveScope(ctx, access, opts)
  if (scope === 'all') return
  if (scope === 'denied') {
    throw new Error(
      `history scope: no inbound context and owner is set. Start from a WhatsApp message or set WHATSAPP_OWNER_BYPASS=1`,
    )
  }
  if (!scope.allowed.has(chatId)) {
    throw new Error(
      `history scope: chat_id ${chatId} not accessible from this session`,
    )
  }
}
