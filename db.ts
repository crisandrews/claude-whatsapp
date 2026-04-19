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
}

let insertStmt: Statement | null = null
function getInsertStmt(): Statement {
  if (!insertStmt) {
    insertStmt = dbInstance!.prepare(`
      INSERT OR REPLACE INTO messages (id, chat_id, sender_id, push_name, ts, direction, text, meta)
      VALUES (@id, @chat_id, @sender_id, @push_name, @ts, @direction, @text, @meta)
    `)
  }
  return insertStmt
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
    })
  } catch {
    // Swallow — indexing must never break the message hot path.
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
