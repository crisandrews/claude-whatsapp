// Local message store backed by SQLite + FTS5. Indexes every inbound and
// outbound message so the search/export/history tools can serve queries
// without re-fetching from WhatsApp. Loaded lazily so the bootstrap path
// (which may run before native deps install) never blocks on require.

import fs from 'fs'
import path from 'path'

// `better-sqlite3` is a native module — kept as a dynamic import so the
// rest of the server can boot when it isn't installed yet (the deps_missing
// status reports back to the user; install completes in the background).
type Database = any
type Statement = any

let dbInstance: Database | null = null
let DatabaseCtor: any = null

export interface IndexedMessage {
  id: string
  chat_id: string
  sender_id?: string | null
  push_name?: string | null
  ts: number              // unix seconds
  direction: 'in' | 'out'
  text: string
  meta?: Record<string, string> | null
  // Raw Baileys WAMessage proto (proto.IWebMessageInfo) cached as JSON. Used by
  // the forward_message tool to reconstruct the original message for Baileys'
  // sendMessage forward payload. Optional for backward compatibility — older
  // rows have NULL and cannot be forwarded.
  raw_message?: any
}

export interface MessageRow {
  id: string
  chat_id: string
  sender_id: string | null
  push_name: string | null
  ts: number
  direction: 'in' | 'out'
  text: string
  meta: Record<string, string> | null
  snippet?: string
}

export interface SearchOptions {
  query: string
  chat_id?: string
  limit?: number
}

export interface GetMessagesOptions {
  chat_id: string
  before_ts?: number
  after_ts?: number
  limit?: number
}

export type ExportFormat = 'markdown' | 'jsonl' | 'csv'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS messages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  push_name TEXT,
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  text TEXT NOT NULL DEFAULT '',
  meta TEXT,
  UNIQUE (chat_id, id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`

export async function initDb(dbPath: string): Promise<boolean> {
  if (dbInstance) return true
  try {
    if (!DatabaseCtor) {
      const mod = await import('better-sqlite3')
      DatabaseCtor = (mod as any).default ?? mod
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    dbInstance = new DatabaseCtor(dbPath)
    try { fs.chmodSync(dbPath, 0o600) } catch {}
    dbInstance!.pragma('journal_mode = WAL')
    dbInstance!.pragma('synchronous = NORMAL')
    dbInstance!.pragma('foreign_keys = ON')
    dbInstance!.exec(SCHEMA_SQL)

    // Idempotent migration: add raw_message column if missing (older DBs).
    try {
      const cols = dbInstance!.prepare(`PRAGMA table_info(messages)`).all() as any[]
      if (!cols.some((c) => c.name === 'raw_message')) {
        dbInstance!.exec(`ALTER TABLE messages ADD COLUMN raw_message TEXT`)
      }
    } catch {
      // Migration is best-effort; lack of raw_message just means forward_message
      // can't be used until the schema catches up.
    }

    return true
  } catch {
    dbInstance = null
    return false
  }
}

export function isDbReady(): boolean {
  return dbInstance !== null
}

export function closeDb(): void {
  if (!dbInstance) return
  try { dbInstance.close() } catch {}
  dbInstance = null
  // Reset cached prepared statements so a subsequent initDb() rebinds them
  // against the new connection. Without this, tests that close + reopen the
  // DB would re-use a Statement bound to a closed connection (silent failure).
  insertStmt = null
}

let insertStmt: Statement | null = null
function getInsertStmt(): Statement {
  if (!insertStmt) {
    // UPSERT (not INSERT OR REPLACE) so we can COALESCE raw_message on conflict.
    // Otherwise re-indexing a row (e.g. on edit) without raw_message would wipe
    // the cached proto, breaking forward_message for that message.
    insertStmt = dbInstance!.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, push_name, ts, direction, text, meta, raw_message)
      VALUES (@id, @chat_id, @sender_id, @push_name, @ts, @direction, @text, @meta, @raw_message)
      ON CONFLICT(chat_id, id) DO UPDATE SET
        sender_id = excluded.sender_id,
        push_name = excluded.push_name,
        ts = excluded.ts,
        direction = excluded.direction,
        text = excluded.text,
        meta = excluded.meta,
        raw_message = COALESCE(excluded.raw_message, raw_message)
    `)
  }
  return insertStmt
}

function safeStringifyRaw(raw: any): string | null {
  if (raw === undefined || raw === null) return null
  try {
    return JSON.stringify(raw, (_k, v) => (typeof v === 'bigint' ? String(v) : v))
  } catch {
    return null
  }
}

export function indexMessage(msg: IndexedMessage): void {
  if (!dbInstance) return
  try {
    getInsertStmt().run({
      id: msg.id,
      chat_id: msg.chat_id,
      sender_id: msg.sender_id ?? null,
      push_name: msg.push_name ?? null,
      ts: Math.floor(msg.ts),
      direction: msg.direction,
      text: msg.text ?? '',
      meta: msg.meta ? JSON.stringify(msg.meta) : null,
      raw_message: safeStringifyRaw(msg.raw_message),
    })
  } catch {
    // Swallow — indexing must never break the message hot path.
  }
}

// Returns the cached WAMessage proto for a message id, parsed back from JSON,
// or null if the row predates raw_message caching (or doesn't exist). Callers
// should treat null as "cannot forward this message".
export function getRawMessage(message_id: string): any | null {
  if (!dbInstance) return null
  if (!message_id) return null
  try {
    const row = dbInstance.prepare(
      `SELECT raw_message FROM messages WHERE id = ? LIMIT 1`,
    ).get(message_id) as any
    if (!row || !row.raw_message) return null
    return JSON.parse(row.raw_message)
  } catch {
    return null
  }
}

function rowToMessage(row: any): MessageRow {
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id ?? null,
    push_name: row.push_name ?? null,
    ts: row.ts,
    direction: row.direction,
    text: row.text ?? '',
    meta: row.meta ? safeJson(row.meta) : null,
    snippet: row.snippet,
  }
}

function safeJson(s: string): Record<string, string> | null {
  try {
    const o = JSON.parse(s)
    return o && typeof o === 'object' ? o : null
  } catch {
    return null
  }
}

function clampLimit(n: number | undefined): number {
  if (!n || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

export function searchMessages(opts: SearchOptions): MessageRow[] {
  if (!dbInstance) return []
  const limit = clampLimit(opts.limit)
  const sql = opts.chat_id
    ? `SELECT m.*, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
       FROM messages m
       JOIN messages_fts ON messages_fts.rowid = m.rowid
       WHERE messages_fts MATCH @query AND m.chat_id = @chat_id
       ORDER BY m.ts DESC LIMIT @limit`
    : `SELECT m.*, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
       FROM messages m
       JOIN messages_fts ON messages_fts.rowid = m.rowid
       WHERE messages_fts MATCH @query
       ORDER BY m.ts DESC LIMIT @limit`
  try {
    const rows = dbInstance.prepare(sql).all({
      query: opts.query,
      chat_id: opts.chat_id,
      limit,
    })
    return rows.map(rowToMessage)
  } catch {
    return []
  }
}

export function getMessages(opts: GetMessagesOptions): MessageRow[] {
  if (!dbInstance) return []
  const limit = clampLimit(opts.limit)
  const conditions: string[] = ['chat_id = @chat_id']
  if (opts.before_ts !== undefined) conditions.push('ts < @before_ts')
  if (opts.after_ts !== undefined) conditions.push('ts > @after_ts')
  const sql = `SELECT * FROM messages WHERE ${conditions.join(' AND ')} ORDER BY ts DESC LIMIT @limit`
  try {
    const rows = dbInstance.prepare(sql).all({
      chat_id: opts.chat_id,
      before_ts: opts.before_ts,
      after_ts: opts.after_ts,
      limit,
    })
    return rows.map(rowToMessage)
  } catch {
    return []
  }
}

export interface ChatSender {
  sender_id: string
  push_name: string | null
  message_count: number
  last_seen_ts: number
}

export function getChatSenders(chat_id: string, since_ts?: number): ChatSender[] {
  if (!dbInstance) return []
  // Inbound rows only — we never want to suggest "Claude" as a member to
  // whitelist. Push name is taken from the most recent message (a sender
  // can change push name over time).
  const conditions = ['chat_id = @chat_id', "direction = 'in'", 'sender_id IS NOT NULL']
  const params: any = { chat_id }
  if (since_ts !== undefined) {
    conditions.push('ts >= @since_ts')
    params.since_ts = since_ts
  }
  const sql = `
    SELECT
      sender_id,
      (SELECT push_name FROM messages
        WHERE chat_id = m.chat_id AND sender_id = m.sender_id AND push_name IS NOT NULL
        ORDER BY ts DESC LIMIT 1) AS push_name,
      COUNT(*) AS message_count,
      MAX(ts) AS last_seen_ts
    FROM messages m
    WHERE ${conditions.join(' AND ')}
    GROUP BY sender_id
    ORDER BY last_seen_ts DESC
  `
  try {
    const rows = dbInstance.prepare(sql).all(params) as any[]
    return rows.map((r) => ({
      sender_id: r.sender_id,
      push_name: r.push_name ?? null,
      message_count: r.message_count,
      last_seen_ts: r.last_seen_ts,
    }))
  } catch {
    return []
  }
}

export function getOldestMessage(chat_id: string): MessageRow | null {
  if (!dbInstance) return null
  try {
    const row = dbInstance.prepare(
      `SELECT * FROM messages WHERE chat_id = @chat_id ORDER BY ts ASC LIMIT 1`,
    ).get({ chat_id })
    return row ? rowToMessage(row) : null
  } catch {
    return null
  }
}

export function countMessages(chat_id?: string): number {
  if (!dbInstance) return 0
  try {
    if (chat_id) {
      const row = dbInstance.prepare(`SELECT COUNT(*) AS c FROM messages WHERE chat_id = @chat_id`).get({ chat_id }) as any
      return row?.c ?? 0
    }
    const row = dbInstance.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as any
    return row?.c ?? 0
  } catch {
    return 0
  }
}

export interface ChatSummary {
  chat_id: string
  kind: 'dm' | 'group'
  last_ts: number
  last_text: string
  last_direction: 'in' | 'out'
  last_push_name: string | null
  msg_count: number
}

export interface MessageContext {
  anchor: MessageRow | null
  before: MessageRow[]
  after: MessageRow[]
}

function clampWindow(n: number | undefined, def: number, max: number): number {
  if (n === undefined || n === null) return def
  if (n < 0) return 0
  return Math.min(n, max)
}

export function getMessageContext(
  message_id: string,
  before?: number,
  after?: number,
): MessageContext {
  if (!dbInstance) return { anchor: null, before: [], after: [] }
  const beforeN = clampWindow(before, 5, 50)
  const afterN = clampWindow(after, 5, 50)
  try {
    const anchorRow = dbInstance
      .prepare(`SELECT * FROM messages WHERE id = ? LIMIT 1`)
      .get(message_id) as any
    if (!anchorRow) return { anchor: null, before: [], after: [] }
    const anchor = rowToMessage(anchorRow)

    const beforeRows: any[] = beforeN > 0
      ? dbInstance
          .prepare(
            `SELECT * FROM messages WHERE chat_id = ? AND ts < ? ORDER BY ts DESC, rowid DESC LIMIT ?`,
          )
          .all(anchor.chat_id, anchor.ts, beforeN)
      : []
    const afterRows: any[] = afterN > 0
      ? dbInstance
          .prepare(
            `SELECT * FROM messages WHERE chat_id = ? AND ts > ? ORDER BY ts ASC, rowid ASC LIMIT ?`,
          )
          .all(anchor.chat_id, anchor.ts, afterN)
      : []

    return {
      anchor,
      before: beforeRows.map(rowToMessage).reverse(),
      after: afterRows.map(rowToMessage),
    }
  } catch {
    return { anchor: null, before: [], after: [] }
  }
}

export function listChats(
  allowedChatIds: string[],
  limit?: number,
  offset?: number,
): ChatSummary[] {
  if (!dbInstance) return []
  if (allowedChatIds.length === 0) return []
  const lim = clampLimit(limit)
  const off = Math.max(0, offset ?? 0)
  const placeholders = allowedChatIds.map(() => '?').join(',')
  const sql = `
    SELECT
      chat_id,
      MAX(ts) AS last_ts,
      COUNT(*) AS msg_count,
      (SELECT text FROM messages m2 WHERE m2.chat_id = m.chat_id ORDER BY ts DESC LIMIT 1) AS last_text,
      (SELECT direction FROM messages m3 WHERE m3.chat_id = m.chat_id ORDER BY ts DESC LIMIT 1) AS last_direction,
      (SELECT push_name FROM messages m4 WHERE m4.chat_id = m.chat_id AND direction = 'in' AND push_name IS NOT NULL ORDER BY ts DESC LIMIT 1) AS last_push_name
    FROM messages m
    WHERE chat_id IN (${placeholders})
    GROUP BY chat_id
    ORDER BY last_ts DESC
    LIMIT ? OFFSET ?
  `
  try {
    const rows = dbInstance.prepare(sql).all(...allowedChatIds, lim, off) as any[]
    return rows.map((r) => ({
      chat_id: r.chat_id,
      kind: r.chat_id.endsWith('@g.us') ? ('group' as const) : ('dm' as const),
      last_ts: r.last_ts,
      last_text: r.last_text ?? '',
      last_direction: r.last_direction,
      last_push_name: r.last_push_name ?? null,
      msg_count: r.msg_count,
    }))
  } catch {
    return []
  }
}

export interface ContactSearchResult {
  sender_id: string
  push_name: string | null
  chat_count: number
  message_count: number
  last_seen_ts: number
}

export interface ChatAnalytics {
  chat_id: string
  since_ts: number | null
  total_messages: number
  inbound_count: number
  outbound_count: number
  unique_senders: number
  first_message_ts: number | null
  last_message_ts: number | null
  per_sender: Array<{ sender_id: string; push_name: string | null; message_count: number; last_seen_ts: number }>
  hourly_distribution: number[]
  daily_distribution: number[]
}

export function getChatAnalytics(chat_id: string, since_ts?: number): ChatAnalytics | null {
  if (!dbInstance) return null
  if (!chat_id) return null
  const sinceClause = since_ts !== undefined ? 'AND ts >= @since_ts' : ''
  const params: any = { chat_id, since_ts: since_ts ?? null }
  try {
    const totalRow = dbInstance.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound,
        SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS outbound,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM messages WHERE chat_id = @chat_id ${sinceClause}
    `).get(params) as any
    if (!totalRow || !totalRow.total) {
      return {
        chat_id,
        since_ts: since_ts ?? null,
        total_messages: 0,
        inbound_count: 0,
        outbound_count: 0,
        unique_senders: 0,
        first_message_ts: null,
        last_message_ts: null,
        per_sender: [],
        hourly_distribution: new Array(24).fill(0),
        daily_distribution: new Array(7).fill(0),
      }
    }

    const senderRows = dbInstance.prepare(`
      SELECT
        sender_id,
        (SELECT push_name FROM messages WHERE sender_id = m.sender_id AND chat_id = m.chat_id AND push_name IS NOT NULL ORDER BY ts DESC LIMIT 1) AS push_name,
        COUNT(*) AS message_count,
        MAX(ts) AS last_seen_ts
      FROM messages m
      WHERE m.chat_id = @chat_id AND m.direction = 'in' AND m.sender_id IS NOT NULL ${sinceClause}
      GROUP BY sender_id
      ORDER BY message_count DESC
    `).all(params) as any[]

    const hourlyRows = dbInstance.prepare(`
      SELECT CAST(strftime('%H', datetime(ts, 'unixepoch')) AS INTEGER) AS hour, COUNT(*) AS count
      FROM messages WHERE chat_id = @chat_id AND direction = 'in' ${sinceClause}
      GROUP BY hour
    `).all(params) as any[]

    const dailyRows = dbInstance.prepare(`
      SELECT CAST(strftime('%w', datetime(ts, 'unixepoch')) AS INTEGER) AS dow, COUNT(*) AS count
      FROM messages WHERE chat_id = @chat_id AND direction = 'in' ${sinceClause}
      GROUP BY dow
    `).all(params) as any[]

    const hourly = new Array(24).fill(0)
    for (const r of hourlyRows) hourly[r.hour] = r.count
    const daily = new Array(7).fill(0)
    for (const r of dailyRows) daily[r.dow] = r.count

    return {
      chat_id,
      since_ts: since_ts ?? null,
      total_messages: totalRow.total,
      inbound_count: totalRow.inbound ?? 0,
      outbound_count: totalRow.outbound ?? 0,
      unique_senders: senderRows.length,
      first_message_ts: totalRow.first_ts ?? null,
      last_message_ts: totalRow.last_ts ?? null,
      per_sender: senderRows.map((r) => ({
        sender_id: r.sender_id,
        push_name: r.push_name ?? null,
        message_count: r.message_count,
        last_seen_ts: r.last_seen_ts,
      })),
      hourly_distribution: hourly,
      daily_distribution: daily,
    }
  } catch {
    return null
  }
}

export function searchContacts(
  query: string,
  limit?: number,
  allowedChatIds?: string[],
): ContactSearchResult[] {
  if (!dbInstance) return []
  if (!query || !query.trim()) return []
  const lim = Math.min(Math.max(limit ?? 20, 1), 100)
  const pattern = `%${query.trim()}%`

  const useAccessFilter = Array.isArray(allowedChatIds) && allowedChatIds.length > 0
  const accessClause = useAccessFilter
    ? `AND m.chat_id IN (${allowedChatIds!.map(() => '?').join(',')})`
    : ''

  const sql = `
    SELECT
      m.sender_id,
      (SELECT push_name FROM messages WHERE sender_id = m.sender_id AND push_name IS NOT NULL ORDER BY ts DESC LIMIT 1) AS push_name,
      COUNT(DISTINCT m.chat_id) AS chat_count,
      COUNT(*) AS message_count,
      MAX(m.ts) AS last_seen_ts
    FROM messages m
    WHERE m.direction = 'in'
      AND m.sender_id IS NOT NULL
      ${accessClause}
      AND (
        (m.push_name IS NOT NULL AND LOWER(m.push_name) LIKE LOWER(?))
        OR LOWER(m.sender_id) LIKE LOWER(?)
      )
    GROUP BY m.sender_id
    ORDER BY last_seen_ts DESC
    LIMIT ?
  `

  const params: any[] = [
    ...(useAccessFilter ? allowedChatIds! : []),
    pattern,
    pattern,
    lim,
  ]

  try {
    const rows = dbInstance.prepare(sql).all(...params) as any[]
    return rows.map((r) => ({
      sender_id: r.sender_id,
      push_name: r.push_name ?? null,
      chat_count: r.chat_count,
      message_count: r.message_count,
      last_seen_ts: r.last_seen_ts,
    }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Export — pure formatters over MessageRow[]
// ---------------------------------------------------------------------------

export function formatExport(rows: MessageRow[], format: ExportFormat): string {
  // Order chronologically for export (the queries return DESC).
  const sorted = [...rows].sort((a, b) => a.ts - b.ts)
  switch (format) {
    case 'jsonl':
      return sorted.map((r) => JSON.stringify(r)).join('\n') + (sorted.length ? '\n' : '')
    case 'csv':
      return formatCsv(sorted)
    case 'markdown':
    default:
      return formatMarkdown(sorted)
  }
}

function formatMarkdown(rows: MessageRow[]): string {
  const lines: string[] = []
  for (const r of rows) {
    const when = new Date(r.ts * 1000).toISOString()
    const who = r.direction === 'out' ? 'Claude' : (r.push_name || r.sender_id || r.chat_id)
    lines.push(`**${who}** _(${when})_`)
    if (r.text) lines.push(r.text)
    if (r.meta && Object.keys(r.meta).length > 0) {
      const interesting = Object.entries(r.meta).filter(([k]) =>
        ['attachment_kind', 'attachment_filename', 'attachment_mimetype', 'image_path', 'audio_path', 'video_path', 'document_path', 'reaction'].includes(k),
      )
      if (interesting.length) {
        lines.push('> ' + interesting.map(([k, v]) => `${k}: ${v}`).join(', '))
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function formatCsv(rows: MessageRow[]): string {
  const header = ['ts_iso', 'direction', 'sender_id', 'push_name', 'chat_id', 'id', 'text']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([
      new Date(r.ts * 1000).toISOString(),
      r.direction,
      r.sender_id ?? '',
      r.push_name ?? '',
      r.chat_id,
      r.id,
      r.text,
    ].map(csvEscape).join(','))
  }
  return lines.join('\n') + (rows.length ? '\n' : '')
}
