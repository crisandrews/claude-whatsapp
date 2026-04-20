# MCP tools

Reference for every WhatsApp tool the plugin exposes to Claude — arguments, return shape, one natural-language example, and the pitfalls worth knowing. Multi-tool flows (search → fetch → export; inbound media → transcription) live in their own docs; each tool below links out when there's a deeper walkthrough.

- [Quick reference](#quick-reference)
- [Talking to Claude through WhatsApp](#talking-to-claude-through-whatsapp)
- [`reply`](#reply)
- [`react`](#react)
- [`edit_message`](#edit_message)
- [`delete_message`](#delete_message)
- [`send_poll`](#send_poll)
- [`download_attachment`](#download_attachment)
- [`search_messages`](#search_messages)
- [`fetch_history`](#fetch_history)
- [`list_group_senders`](#list_group_senders)
- [`export_chat`](#export_chat)
- [What's NOT a tool (yet)](#whats-not-a-tool-yet)

All tools surface to the model as `mcp__whatsapp__<tool>`. Each one takes a `chat_id` (the JID from `meta.chat_id` on the inbound message) and enforces the access policy — you can only send into a DM that's on `allowFrom`, or a group that's in `groups{}`.

---

## Quick reference

| Tool | One-liner |
|---|---|
| `reply` | Send text or a file. Auto-chunks text >4096 chars. |
| `react` | Emoji reaction on any message. |
| `edit_message` | Rewrite a previously-sent message in place (no push). |
| `delete_message` | Revoke a message (both sides see the deleted placeholder). |
| `send_poll` | Send a tappable poll, 2–12 options. |
| `download_attachment` | Read a file from the inbox (sandboxed). |
| `search_messages` | FTS5 search over the local message store. |
| `fetch_history` | Request older messages from WhatsApp for a chat. |
| `list_group_senders` | Who has spoken in a chat (indexed senders only). |
| `export_chat` | Dump a chat as markdown / jsonl / csv into the inbox. |

---

## Talking to Claude through WhatsApp

Claude picks tools automatically based on what you ask. Some example prompts from your phone, and the tool Claude will typically reach for:

- *"Delete that last message, I changed my mind."* → `delete_message`
- *"Edit your last reply and change X to Y."* → `edit_message`
- *"React with 👍 to Juan's message."* → `react`
- *"Send the quarterly PDF to this chat."* → `reply` (with `file_path`)
- *"Run a poll in the office group: pizza, sushi, or tacos?"* → `send_poll`
- *"Search my chat with Maria for where we talked about the address."* → `search_messages`
- *"Pull 50 older messages from this chat."* → `fetch_history`
- *"Who's been talking in the office group lately?"* → `list_group_senders`
- *"Export this chat as markdown."* → `export_chat`

You rarely need to name a tool explicitly. If Claude isn't picking the right one, describe the outcome, not the mechanism ("I want a transcript" not "call export_chat").

---

## `reply`

Send a text message, optionally with a file attachment.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | JID from `meta.chat_id` on the inbound message. |
| `text` | ✅ | The message body. For file attachments this becomes the caption. |
| `reply_to` | | Message ID to quote. If unset, falls back to `replyToMode` from `config.json` (default: quote the first chunk only). |
| `file_path` | | Absolute path. Images (`.jpg/.jpeg/.png/.gif/.webp`) are sent as inline images; anything else as a document. |

**Return**

A text summary: `"Message sent"`, `"Sent N messages (auto-chunked, <mode>)"`, or `"Sent as response.md (… chars)"` when the auto-document threshold triggers.

**Worked example**

> *"Reply with a list of next week's deliverables."*

Claude composes the list and calls `reply` with `chat_id` + `text`. If the list is long, the plugin either chunks at 4096 chars or (if `documentThreshold` is configured) sends a single `response.md` attachment. See [docs/configuration.md#reply-shaping](configuration.md#reply-shaping) for the shaping knobs.

**Pitfalls**

- **`assertSendable` refuses channel-state files.** Any path inside the channel dir that isn't under `inbox/` throws — no accidentally leaking `auth/creds.json`, `access.json`, or similar. Anywhere else on the filesystem is fine.
- **No fixed size cap on outbound files.** The 50 MB cap you'll see in the README applies to **inbound** media the plugin downloads into `inbox/`. Outbound sends go through Baileys without a size check; WhatsApp imposes its own ~100 MB server-side limit for documents.
- **Long replies behavior** is governed by `chunkMode`, `replyToMode`, and `documentThreshold` — set via `/whatsapp:configure`, not by the caller.

---

## `react`

Add an emoji reaction to a message.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | |
| `message_id` | ✅ | The target message ID (from `meta.message_id`). |
| `emoji` | ✅ | Any single emoji (skin-tone variants ok). |

**Worked example**

> *"React 👍 to Juan's last message."* → `react` with Juan's message_id.

**Pitfalls**

- Reactions on a permission prompt (a `🔐 Claude wants to run …` message) are **intercepted by the plugin** as approve/deny signals — see [docs/permission-relay.md](permission-relay.md). Claude doesn't see those.

---

## `edit_message`

Rewrite a message the bot previously sent, in place. WhatsApp shows an "edited" tag and does **not** push a notification — useful for typo fixes.

**Arguments**

| Field | Required |
|---|---|
| `chat_id` | ✅ |
| `message_id` | ✅ |
| `text` | ✅ |

**Worked example**

> *"Edit your last reply and change the time from 3 PM to 4 PM."*

**Pitfalls**

- **Bot-sent only.** WhatsApp rejects the edit server-side if the referenced message wasn't ours — no way to edit a user message, no pre-check needed on our side.
- **~15-minute window.** WhatsApp enforces this server-side; after that the edit call returns an error from Baileys.

---

## `delete_message`

Revoke a message (the "delete for everyone" action). Both sides see the standard "This message was deleted" placeholder.

**Arguments**

| Field | Required |
|---|---|
| `chat_id` | ✅ |
| `message_id` | ✅ |

**Worked example**

> *"Delete that last message, I changed my mind."*

**Pitfalls**

- **Bot-sent only**, same as `edit_message`. WhatsApp rejects otherwise.
- **Revoke window** is WhatsApp-enforced — for most accounts ~1 hour, but it's drifted over the years.

---

## `send_poll`

Send a tappable poll. WhatsApp renders it as a list with live vote tallies.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | |
| `question` | ✅ | Title shown above the options. |
| `options` | ✅ | Array of 2 to 12 non-empty strings. |
| `multi_select` | | `true` allows multiple picks per voter. Default `false`. |

**Worked example**

> *"Run a poll in the office group: pizza, sushi, or tacos?"* → `send_poll` with those three options, single-choice.

**Pitfalls**

- **2–12 options** enforced. Fewer or more throws.
- **Votes come back as inbound messages** via the normal channel; the plugin indexes them but doesn't give Claude a tally API yet — if you need the result, ask Claude to `search_messages` the chat for the poll's message ID.

---

## `download_attachment`

Confirm a media file exists and report its absolute path. Used by Claude when it needs to read an inbound attachment.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `attachment_path` | ✅ | Must already be inside `<channel-dir>/inbox/`. |

**Return**

Either `File available at: <abs path>` or `File not found at: <abs path>`.

**Worked example**

> *"Summarize the PDF I just sent."* — Claude reads `meta.attachment_path` from the inbound message and calls `download_attachment` to confirm, then reads the file directly.

**Pitfalls**

- **Sandboxed to `inbox/`.** Any `attachment_path` outside that directory throws. Not a bug — it's deliberate so Claude can't be tricked into leaking arbitrary files.

See [docs/media-voice.md](media-voice.md) for the full inbound-media lifecycle.

---

## `search_messages`

Full-text search the local message store (SQLite + FTS5). Indexes every inbound and outbound message the plugin sees, plus anything fetched via `fetch_history`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `query` | ✅ | FTS5 MATCH syntax (see below). |
| `chat_id` | | Optional JID to scope to one chat. |
| `limit` | | Default 50, max 500. |

**FTS5 syntax at a glance**

| Input | Behavior |
|---|---|
| `pizza sushi` | AND: both words must appear. |
| `"exact phrase"` | Phrase search. |
| `pizza*` | Prefix match (`pizza`, `pizzas`, `pizzeria`). |
| `NEAR(pizza tacos, 5)` | Both words within 5 tokens of each other. |
| `-excluded` | Negate — match the rest but not `excluded`. |

The full matrix with before/after examples and the `chat_id` scoping walkthrough is in [docs/search-export.md#fts5-query-matrix](search-export.md#fts5-query-matrix).

**Worked example**

> *"Search my chat with Maria for where we talked about the address."* — Claude pulls Maria's `chat_id` from recent inbound meta, then calls `search_messages` with `query: "address"` and that `chat_id`.

**Pitfalls**

- **Default limit is 50**, not 500. If you want more, ask Claude to pass `limit` explicitly. (Contrast with `export_chat`, where the default is 500.)
- **Deleted messages stay indexed.** The index records what was seen; revocations don't retroactively purge. That's intentional — "search everything we saw" is the useful semantic.
- **New install has an empty index.** Nothing to search until messages start flowing. For historical context, run `fetch_history` first — see next.

---

## `fetch_history`

Ask WhatsApp to ship older messages for a chat. Requires at least one already-known message as the anchor.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | |
| `count` | | Default 50. Approximate — WhatsApp may deliver more or fewer. |

**Return**

`History request sent for <chat_id> (anchor msg <id>, count ~N, session <id>). Backfilled messages will arrive asynchronously and be indexed automatically — call search_messages or fetch_history again in a few seconds to see them.`

**Worked example**

> *"Pull 50 older messages from this chat."* — Claude calls `fetch_history` with the current `chat_id`. A few seconds later it calls `search_messages` (or counts via `list_group_senders`) to verify the backfill landed.

**Pitfalls**

- **Needs an anchor.** If the store has never seen a message for this chat, the call returns `No anchor message known for <chat_id> — wait for at least one live message before requesting history.` Ask someone to send any message first, then retry.
- **Async arrival.** The call returns immediately; the actual messages land via Baileys' `messaging-history.set` event. Re-query to see them.
- **No progress signal.** There's no "done" notification — if you need N messages exactly, call in a loop with increasing waits and check counts via `search_messages` with a broad query.

Full walkthrough with the anchor-selection / async-arrival detail in [docs/search-export.md#fetch_history-flow](search-export.md#fetch_history-flow).

---

## `list_group_senders`

List the participants who have spoken in a chat, drawn from the local message store. Useful when you're about to whitelist specific people in a group via `/whatsapp:access group-allow` and need their JIDs.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group or DM JID. |
| `since_days` | | Optional lookback. Default: all-time. |

**Return**

A bulleted list of senders with push name, JID (as a code span so you can copy), message count, and last-seen timestamp, sorted by recency.

**Worked example**

> *"Who's been talking in the office group in the last 7 days?"* → `list_group_senders` with `since_days: 7`.

**Pitfalls**

- **Only indexed senders.** If a member has never sent a message while the plugin was running, they won't appear. Use `fetch_history` first to populate the store.
- **Claude is excluded.** Outbound messages are filtered out — you'll never see the bot listed as a sender.

Full walkthrough (including handing the output to `group-allow`) in [docs/groups.md#member-discovery](groups.md#member-discovery).

---

## `export_chat`

Dump a chat from the local store as `markdown`, `jsonl`, or `csv`. The file lands in `<channel-dir>/inbox/export-<chat_id>-<ts>.<ext>`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | |
| `format` | | `markdown` (default), `jsonl`, or `csv`. |
| `since_ts` | | Unix seconds, lower bound. |
| `until_ts` | | Unix seconds, upper bound. |
| `limit` | | Default 500, max 500. |

**Return**

`Exported N of M indexed messages from <chat_id> as <format> → <filepath>`.

**Worked example**

> *"Export this chat as markdown for the last 30 days."* — Claude computes `since_ts = now - 30 days` and calls `export_chat` with `format: "markdown"`.

**Pitfalls**

- **Windowing uses indexed rows**, not "everything WhatsApp knows". If the store only covers the last two weeks and you ask for 30 days, you get two weeks. Run `fetch_history` first to widen the window.
- **Export goes into `inbox/`**, which means Claude can subsequently read it via `download_attachment` or pass it to another tool. Clean up manually when you're done — no auto-retention.

Full format samples and the difference between `export_chat`'s default limit (500) and `search_messages`'s default (50) are covered in [docs/search-export.md#windowing-and-limits](search-export.md#windowing-and-limits).

---

## What's NOT a tool (yet)

- **Group administration.** Creating groups, renaming them, adding or removing members, promoting admins. Do these from your phone manually — on the roadmap but not shipped.
- **Outbound voice notes.** Inbound voice is received and optionally transcribed ([docs/media-voice.md](media-voice.md)); sending a voice message from Claude isn't exposed today.
- **Status / story posts.** Not part of WhatsApp Web's API surface that Baileys covers.
- **Group invite links.** Read or generate them from your phone.
