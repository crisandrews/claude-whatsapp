# Search, history, and export

How the local message store works, how to search it, how to pull older messages from WhatsApp into it, and how to dump a chat out. This is the end-to-end flow — the per-tool reference lives in [docs/tools.md](tools.md).

- [What gets indexed](#what-gets-indexed)
- [Where the store lives](#where-the-store-lives)
- [Per-chat history scope](#per-chat-history-scope)
- [Searching: FTS5 query matrix](#fts5-query-matrix)
- [`fetch_history` flow](#fetch_history-flow)
- [Exporting a chat](#exporting-a-chat)
- [Windowing and limits](#windowing-and-limits)
- [Worked examples](#worked-examples)
- [Edge cases & gotchas](#edge-cases--gotchas)

---

## What gets indexed

Every time a message passes through the plugin, it's written to the SQLite store. That covers:

- **Inbound deliveries** — text, captions on media, and the placeholder text for non-text messages (`[Image]`, `[Voice message received]` → replaced with the transcript if voice transcription is on, etc.).
- **Outbound messages Claude sends** — `reply`, `edit_message` (updates the existing row), `send_poll` (the question + options).
- **Reactions** — stored as text `[Reacted with 👍]` plus `meta.reaction` / `meta.reacted_to_message_id`.
- **History backfills** — messages that arrive from `fetch_history` land in the same table, marked `meta.from_history: "1"` (and aren't run through the access gate — they're historical).

What doesn't get indexed:

- Dropped inbound messages (gated out by DM policy or per-group `requireMention`/`allowFrom`). If you change the gate later, those messages won't appear retroactively.
- Media bytes. Only the placeholder text + meta path live in the store; the actual file is in `<channel-dir>/inbox/`.

---

## Where the store lives

```
<channel-dir>/messages.db
```

SQLite database with a WAL journal. Created on first launch, user-only permissions (`0600`). Safe to delete to wipe history — it'll be recreated empty on the next launch. The indexing path swallows errors, so losing the DB never breaks the message hot path; only the search/export/history tools degrade.

Schema (stable; changes only with a major version bump):

```sql
CREATE TABLE messages (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  push_name TEXT,
  ts INTEGER NOT NULL,              -- unix seconds
  direction TEXT CHECK (direction IN ('in','out')),
  text TEXT DEFAULT '',
  meta TEXT,                        -- JSON blob
  UNIQUE (chat_id, id)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61'
);
```

The `porter unicode61` tokenizer means matches are case-insensitive, Unicode-aware, and stemmed — `running` matches `runs` and `ran` in English. Good for natural-language search, slightly surprising for exact-term hunting (use a phrase query if you need exact: `"pizza"`).

Access through the SDK side is idiomatic better-sqlite3 (`db.ts:97-116`). Third-party companions should go through the MCP tools rather than opening `messages.db` directly — the WAL journal can be in flight.

---

## Per-chat history scope

All tools that read or exfiltrate indexed history are gated by chat: `search_messages`, `fetch_history`, `export_chat`, `list_group_senders`, `get_message_context`, `get_chat_analytics`, `list_chats`, `search_contact`, and `forward_message` (source side). The rule in one sentence: **owners (`ownerJids` in `access.json`) read every indexed chat; every other chat is sandboxed to its own history by default.**

Practical consequences for this doc's workflows:

- A non-owner chat asking "search all of Maria's chats" gets `history scope: chat_id <jid> not accessible from this session` for any chat other than its own.
- From a non-owner chat, `search_messages` without a `chat_id` is automatically filtered to that chat's scope (+ any explicit overrides configured via `set-scope`).
- Running `search_messages` from the terminal after an owner is configured requires either a recent WhatsApp inbound (to establish context) or `WHATSAPP_OWNER_BYPASS=1` in the environment — the server fails closed to prevent a delayed WhatsApp turn from inheriting terminal privileges.

Override per-chat with `/whatsapp:access set-scope <chat> <own|all|csv>`. Full model: [docs/access.md#history-scope](access.md#history-scope).

---

## FTS5 query matrix

`search_messages` passes your `query` string straight to SQLite FTS5's `MATCH` operator. Everything FTS5 supports is available; the useful subset:

| Input | Matches | Doesn't match |
|---|---|---|
| `pizza` | Any message containing `pizza` (or stemmed variant). | |
| `pizza tacos` | Both words somewhere in the same message. | "just pizza", "only tacos" |
| `"exact phrase"` | Exact adjacent token sequence. | "phrase exact" |
| `pizza*` | `pizza`, `pizzas`, `pizzeria`. Prefix only. | `Napolitan pizza` (no suffix match) |
| `NEAR(pizza tacos, 5)` | Both words within 5 tokens of each other. | "pizza" early + "tacos" at end of long message |
| `pizza -pepperoni` | Messages with `pizza` but NOT `pepperoni`. | messages with both |
| `(pizza OR tacos) AND dinner` | Boolean grouping with explicit operators. | |

### Scoping to one chat

`search_messages` takes an optional `chat_id`. Claude typically does this automatically when you say *"search my chat with Maria"* — it maps "Maria" to a recent JID from inbound meta, then scopes.

Manual example: if you're driving the tool directly, pass both:

```json
{
  "query": "address",
  "chat_id": "5491155556666@s.whatsapp.net",
  "limit": 20
}
```

### Results

Each result includes a 12-token snippet with match markers (`«match»`) and ellipses at the edges, plus the sender, chat, timestamp, and message ID. Claude formats this for you; the raw shape is in [docs/tools.md#search_messages](tools.md#search_messages).

---

## `fetch_history` flow

The store only contains messages delivered while the plugin was connected. For older context, `fetch_history` asks WhatsApp to replay them.

### Anchor selection

The tool needs a known message to "anchor" the request — essentially "ship me the 50 messages that came before this one". The plugin picks the **oldest** indexed message for the chat as the anchor. If no message is indexed for that chat yet, the call returns:

```
No anchor message known for <chat_id> — wait for at least one live message before requesting history.
```

Fix: ask the other party to send any message, or send one yourself from Claude. Then retry.

### How the request is made

Under the hood, the plugin calls Baileys' `sock.fetchMessageHistory(count, key, oldestMsgTsMs)`. The return is a session ID — not the messages themselves. Example tool output:

```
History request sent for 5491155556666@s.whatsapp.net (anchor msg 3EB0..., count ~50, session 1A2B...).
Backfilled messages will arrive asynchronously and be indexed automatically — call search_messages or fetch_history again in a few seconds to see them.
```

### Async arrival

Backfilled messages land via Baileys' `messaging-history.set` event (`server.ts:800-822`). The plugin indexes each one with `meta.from_history: "1"` so you can filter them out if needed:

```json
{"query": "pizza", "chat_id": "<jid>"}
```

...then inspect results; the meta blob includes `from_history` for backfilled rows.

### No progress signal

There's no "done" event. In practice: wait 2–5 seconds and re-query. If you need N messages exactly, call `fetch_history` in a loop, requesting 50 at a time, checking the count each iteration. WhatsApp may deliver fewer than requested — the server decides.

### Running it again to go further back

After the first backfill, the anchor (= oldest indexed message) is now older than before. A second `fetch_history` call walks further back. Keep going until the count stops growing.

---

## Exporting a chat

`export_chat` writes the indexed rows for a chat to a file under `<channel-dir>/inbox/`.

### Formats

**`markdown`** (default) — human-readable transcript:

```markdown
**Juan** _(2026-04-19T14:22:31.000Z)_
Can you pull up last month's invoices?

**Claude** _(2026-04-19T14:22:58.000Z)_
Yes — I found 12 matching messages. Do you want them as a table or CSV?
> attachment_kind: document, attachment_filename: invoices.md

**Juan** _(2026-04-19T14:23:10.000Z)_
Table is fine.
```

Any interesting meta fields (attachments, reactions) are summarized on a leading `> …` quote line underneath the message.

**`jsonl`** — one JSON object per line, ideal for scripted consumption:

```jsonl
{"id":"3EB0...","chat_id":"549...","sender_id":"549...","push_name":"Juan","ts":1713543751,"direction":"in","text":"Can you pull up last month's invoices?","meta":null}
{"id":"3EB1...","chat_id":"549...","sender_id":"199...@lid","push_name":"Claude","ts":1713543778,"direction":"out","text":"Yes — I found 12 matching messages...","meta":{"attachment_kind":"document","attachment_filename":"invoices.md"}}
```

**`csv`** — header row, quoted fields, commas-in-text safe:

```csv
ts_iso,direction,sender_id,push_name,chat_id,id,text
2026-04-19T14:22:31.000Z,in,549...@s.whatsapp.net,Juan,549...@s.whatsapp.net,3EB0...,"Can you pull up last month's invoices?"
2026-04-19T14:22:58.000Z,out,199...@lid,Claude,549...@s.whatsapp.net,3EB1...,"Yes — I found 12 matching messages..."
```

CSV preserves multiline content — a newline inside a quoted field is legal. Open with any spreadsheet that handles RFC 4180.

### Output path

```
<channel-dir>/inbox/export-<sanitized_chat_id>-<unix_ms>.<ext>
```

The JID is sanitized (`[^a-zA-Z0-9]` → `_`) and prefixed with `export-` so exports are easy to grep out of the inbox later. Files land with `0600` perms.

---

## Windowing and limits

The interplay here is the thing Codex flagged — don't assume the limits are the same across tools:

| Tool | Default `limit` | Max `limit` |
|---|---|---|
| `search_messages` | 50 | 500 |
| `export_chat` | 500 | 500 |
| `list_group_senders` | (no limit; all senders) | — |

**Time window** (both `search` and `export`):

- `since_ts` — Unix seconds lower bound (exclusive-greater).
- `until_ts` — Unix seconds upper bound (exclusive-lesser).

Omit either to leave the bound open. Use both for a fixed window.

```json
{
  "chat_id": "<jid>",
  "since_ts": 1713456000,
  "until_ts": 1713542399,
  "limit": 500
}
```

---

## Worked examples

### Scenario A — "Did we already decide on pizza?"

1. Someone in a group asks whether the lunch decision was already made.
2. Tell Claude from your phone: *"Search the office group for where we settled on pizza."*
3. Claude scopes `search_messages` to the group JID with `query: "pizza decided OR settled"`.
4. Claude surfaces the most recent hit with the snippet and timestamp.

Everything runs against the local store. Zero round-trips to WhatsApp's servers — even if you're offline.

### Scenario B — "Give me a transcript of last week with Maria"

1. *"Export my last 7 days of chat with Maria as markdown."*
2. Claude resolves Maria's JID from recent inbound meta.
3. Computes `since_ts = now_seconds - 7*86400`, calls `export_chat` with `format: "markdown"` and that window.
4. Plugin writes `inbox/export-<jid>-<ts>.md` and returns the path.
5. Claude optionally reads that file directly and writes you a summary.

If the local index doesn't go back 7 days (new install, messages just started flowing), Claude should run `fetch_history` first. Usually you have to prompt it — e.g. *"…pulling older messages first if the index is thin."*

### Scenario C — "Show me everything about the deal we talked about in March"

> Use case: loosely-dated, loosely-worded search that spans multiple chats.

1. *"Search all chats for messages from March that mention the acme deal."*
2. Claude computes March's `since_ts` / `until_ts`, calls `search_messages` with `query: "acme deal"`, no `chat_id` (global).
3. Claude sorts results by timestamp, highlights the ones with file attachments (using `meta.attachment_kind`), and offers to export the matching chats.

Notice the pattern: **search first, then narrow, then export**. Export without search tends to produce too much.

### Scenario D — Pulling older messages before searching

1. *"Search my chat with Maria for anything about the Q4 budget."*
2. Claude tries `search_messages`. Zero hits, but the oldest indexed message is recent.
3. Claude says "the local store only goes back 2 days — let me pull older messages first", calls `fetch_history` with `count: 200`.
4. Waits 3 seconds, re-runs `search_messages`. Hits now.

---

## Edge cases & gotchas

**Search returns empty but I know the word is there.**
- The FTS5 tokenizer is Porter-stemmed on English. Non-English words may stem oddly. Try `"exact word"` (phrase query — bypasses stemming) or a prefix (`worda*`).
- The message may predate indexing — check `countMessages` by asking *"how many messages are indexed for this chat?"*. If small, run `fetch_history` first.

**FTS5 syntax error on a query with a hyphen or parens.**
- Escape or quote the literal: `"a-b-c"` rather than `a-b-c` (the latter is parsed as "a AND NOT b AND NOT c").

**Deleted messages still show up in results.**
- Intentional. The index records what the plugin saw; revocations don't retroactively delete rows. Check `meta.edited === "1"` if the row was replaced by an edit.

**Export file has `\n` inside a CSV cell and my tool can't parse it.**
- The file is RFC-4180-compliant (quoted field + escaped `""`). Most spreadsheet tools handle it; a naive `split(',')` won't. Use a proper CSV parser.

**`fetch_history` returned immediately but no new messages appear after minutes.**
- WhatsApp may refuse old history for that chat (account age, chat activity, server-side policy — not documented). Try a different chat to isolate; if nothing works for any chat, the session may be mid-link — check `<channel-dir>/status.json`.

**Index is corrupt after a hard shutdown.**
- The WAL journal should heal on next open. If not, safe to `rm <channel-dir>/messages.db*` and restart — you lose the indexed history only, nothing else.

**The same message appears twice in results.**
- Shouldn't happen — `UNIQUE (chat_id, id)` is enforced. If it does, the second row has a different `chat_id` (same JID in two namespaces — `@s.whatsapp.net` and `@lid`) which is a Baileys v7 quirk. The search is still correct; the duplication is cosmetic.
