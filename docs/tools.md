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

## `list_chats`

List recent WhatsApp chats (DMs + groups) with last message preview and metadata. Filtered to only include chats in the current access allowlist — DMs in `allowFrom` and groups in `access.groups`. Useful when the user asks *"what chats do I have?"*, *"who's been messaging me?"*, or before handing a `chat_id` off to another per-chat tool.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `limit` | | Max chats to return. Default `50`, clamped to `200`. |
| `offset` | | Number of chats to skip before returning (for pagination). Default `0`. |

**Return**

A plain-text list of chats, each entry showing:

- Kind (`DM` or `Group`) + JID in backticks for easy copy-paste
- Total indexed message count for that chat (inbound + outbound)
- Last message preview: direction (`in`/`out`), sender push name for inbound, truncated text (60 chars), timestamp in UTC (`YYYY-MM-DD HH:MM`)

Example output:

```
Showing 3 chats:

1. DM `5491155556666@s.whatsapp.net`
   12 msgs · last (in, Juan Pérez): "yes please" · 2026-04-20 22:14

2. Group `120363xxx@g.us`
   47 msgs · last (in, Pedro): "where are we playing today?" · 2026-04-19 21:00

3. DM `5491166667777@s.whatsapp.net`
   5 msgs · last (out, Claude): "Done, scheduled." · 2026-04-18 18:45
```

**Worked example**

> *"What active chats do I have on WhatsApp?"*

Claude calls `list_chats` with no arguments. The tool returns the formatted list filtered to the allowlist. Claude then summarizes, or — if the user follows up with *"export my conversation with Juan"* — extracts the DM's `chat_id` from the list and passes it to `export_chat`.

**Pitfalls**

- **Only indexed chats appear.** A newly-allowed contact or group that hasn't sent a message yet won't be listed. The entry appears the moment the first message lands in `messages.db`.
- **Group names aren't resolved.** Only the JID is shown. Use `list_group_senders` to recognize a group by its participants, or call `get_group_metadata` (coming later) for the subject.
- **Access-filtered output.** Chats outside the allowlist are invisible even if present in the database. This is intentional — prevents the agent from accidentally referencing conversations it shouldn't. If a chat you expect is missing, check `/whatsapp:access`.
- **Pagination past the page size.** With more chats than `limit`, call again with `offset = limit` to get the next page. There is no explicit "has more" flag — if you got exactly `limit` results, there is probably more.

---

## `check_number_exists`

Ask WhatsApp whether one or more phone numbers are registered. This is a lookup via Baileys' `onWhatsApp` API — no message is sent, no chat is created, nothing is indexed. Returns existence + the canonical JID for active numbers.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `phones` | ✅ | Array of phone numbers in E.164 format. `"+56912345678"` and `"56912345678"` both work — non-digit characters (spaces, parentheses, hyphens) are stripped. Numbers must be 7–15 digits after normalization. Max 50 per call. |

**Return**

A bulleted list, one line per input number, showing whether it's on WhatsApp and the resolved JID when it is:

```
Checked 3 numbers:

• +56912345678 → ✅ on WhatsApp — `56912345678@s.whatsapp.net`
• +5491155556666 → ✅ on WhatsApp — `5491155556666@s.whatsapp.net` (LID: `12345@lid`)
• +19999999999 → ❌ not on WhatsApp
```

When a number is active, the canonical JID is what you pass to `reply`, `react`, `search_messages`, etc. When a LID is available (Linked Device mode), it's reported too.

**Worked example**

> *"Is Juan on WhatsApp? His number is +5491155556666."*

Claude calls `check_number_exists` with `phones: ["+5491155556666"]`. On `exists: true`, Claude can say *"Yes, he's active"* with confidence, and has the JID ready if the user follows up with *"send him a hello"*.

**Pitfalls**

- **Hits WhatsApp's servers.** Don't run this in tight loops over thousands of numbers — you'll look abusive and risk a ban. Batch up to 50 per call, and only check what you actually need to use next.
- **Requires an active connection.** If the plugin is in `reconnecting` or `logged_out` state, this errors with "WhatsApp is not connected".
- **Ephemeral truth.** "Not on WhatsApp" today doesn't mean never — don't cache results long-term without re-checking.
- **Formatting is tolerated.** `"+56 9 1234 5678"`, `"+56-9-1234-5678"`, and `"56912345678"` all normalize to the same digits before lookup.

---

## `get_group_metadata`

Fetch the full metadata of a WhatsApp group via Baileys' `groupMetadata` API. Returns the group's subject, description, creation info, settings (restrict / announce / ephemeral), and the complete participant list with admin flags. Access-checked — only works for groups present in `access.groups`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups` (add via `/whatsapp:access group-add <jid>`). |

**Return**

A plain-text block with group header, settings, participant count, and the full participant list. Admins are marked ⭐, super admins 👑, regular participants •:

```
Group metadata for `120363xxx@g.us`:

Subject: Fútbol Lunes
Description: Weekly 5-a-side football meetup
Created: 2024-03-15 (by `5491155556666@s.whatsapp.net`)
Settings:
  • Messages: everyone can send
  • Subject/description: everyone can change
  • Ephemeral: off
Size: 12 participants (2 admins, 1 super admin)

Participants:
  👑 `5491155556666@s.whatsapp.net` (super admin)
  ⭐ `5491155557777@s.whatsapp.net` (admin)
  ⭐ `5491155558888@s.whatsapp.net` (admin)
  • `5491155559999@s.whatsapp.net`
  ...
```

**Worked example**

> *"Who are the admins of the Fútbol Lunes group?"*

Claude already has the group's JID from earlier conversation or via `list_chats`. Calls `get_group_metadata` with the JID, filters the participant list to admins in the output, answers with their JIDs (or cross-references `list_group_senders` if it needs display names).

**Difference vs `list_group_senders`**

- `list_group_senders` returns **only** participants who have sent at least one indexed message. SQLite-backed. Includes push names.
- `get_group_metadata` returns **all** current participants via a live Baileys call. Admin flags. JIDs only (no names). Includes group-level settings.

Use both when you need names AND the full roster.

**Pitfalls**

- **Requires the bot to still be a member.** If the bot was kicked or left the group, `groupMetadata` fails with an error suggesting re-joining.
- **Live lookup — not cached.** Every call hits WhatsApp. Don't poll this in a loop.
- **JIDs only, no push names.** Cross-reference with `list_group_senders` if you need display names for participants who have spoken.
- **Access-gated.** Groups not in `access.groups` are rejected — prevents enumerating membership of groups the user hasn't explicitly allowed.

---

## `get_business_profile`

Fetch the WhatsApp Business profile fields (description, category, email, website, address, business hours) for a user JID via Baileys' `getBusinessProfile`. For personal accounts (or businesses that never filled out a profile) returns a clear "no business profile" response — not an error.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | User JID ending in `@s.whatsapp.net` or `@lid`. Not a group. If you only have a phone number, run `check_number_exists` first to resolve the canonical JID. |

**Return**

When the account has a business profile, a plain-text block with all populated fields:

```
Business profile for `56987654321@s.whatsapp.net`:

Description: Artisanal coffee roasters in Santiago
Category: Food & Beverage
Email: hola@cafes-ejemplo.cl
Website: https://cafes-ejemplo.cl
Address: Av. Providencia 1234, Santiago
Hours: {"timezone":"America/Santiago","business_config":[...]}
```

For personal accounts (or a business that hasn't filled the profile):

```
No business profile found for `56912345678@s.whatsapp.net`. This is likely a personal (non-business) WhatsApp account.
```

**Worked example**

> *"Is +56987654321 a business? What do they do?"*

Claude first calls `check_number_exists` with the phone to resolve the JID, then `get_business_profile` with that JID. If a profile exists, Claude summarizes description + category to the user.

**Pitfalls**

- **Live WhatsApp lookup.** Don't poll this in a loop.
- **JID required, not phone.** Baileys needs the `@s.whatsapp.net` or `@lid` JID. Use `check_number_exists` to convert phones.
- **`business_hours` is raw JSON.** Structure varies by Baileys version. Claude can parse it and format day-by-day schedules if the user asks.
- **No access gate.** This is a read-only lookup on a public-ish WhatsApp field; any JID can be queried.

---

## `get_message_context`

Fetch the conversation context around a specific message: N messages before, the anchor message itself, and N messages after — all from the same chat, in chronological order. Pure SQLite query — no WhatsApp roundtrip.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `message_id` | ✅ | Anchor message ID. Typically from `search_messages` results, `fetch_history`, or `meta.message_id` of an inbound notification. |
| `before` | | Messages to fetch BEFORE the anchor. Default `5`, clamped to `50`. |
| `after` | | Messages to fetch AFTER the anchor. Default `5`, clamped to `50`. |

**Return**

A plain-text block showing the anchor + its surrounding messages in chronological order. The anchor line is prefixed with `→` so it's easy to locate visually. Each row shows timestamp, sender (push name for inbound; `Claude` for outbound), and message text.

Example output:

```
Context around message `3EB0F8AF…` in chat `120363xxx@g.us` (3 before, 2 after):

  [2026-04-20 21:00:12] Pedro: where are we playing today?
  [2026-04-20 21:00:34] Carlos: at the club as usual.
  [2026-04-20 21:01:05] Pedro: ok, cool.
→ [2026-04-20 21:01:33] Juan: what time?
  [2026-04-20 21:02:01] Carlos: 7pm
  [2026-04-20 21:02:15] Pedro: I'm in.
```

**Worked example**

> *"Search for 'game' and give me context for the first result."*

Claude calls `search_messages` with `query: "game"`, receives hits with `id` fields, then calls `get_message_context` with the first hit's `id`. With the surrounding thread in hand, Claude can answer follow-ups like *"what did they reply?"* or *"reply to that message with a summary"*.

**Pitfalls**

- **Anchor must be indexed.** If the message isn't in `messages.db` yet, the tool returns a "not found" error. Run `fetch_history` for the target chat to populate older messages first.
- **Access-checked on the anchor's chat.** If the anchor belongs to a chat that isn't in the allowlist, the tool refuses — Claude cannot use this tool to peek into non-permitted conversations.
- **Edge of the history.** Asking for `before: 50` when only 3 messages precede the anchor returns those 3 — no padding, no error. Same for `after`.
- **Same-second ordering.** Messages with identical timestamps are ordered by insertion (`rowid`) for determinism, not by content.

---

## `search_contact`

Search indexed contacts (senders) across all allowlisted chats by substring of push name or JID. Pure SQLite query over `messages.db` — only finds people who have sent at least one indexed message. Results are access-filtered to the allowlist.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `query` | ✅ | Substring to search. Name fragment (`"juan"`) or phone/JID fragment (`"+5491"`, `"5491155"`). Matches in `push_name` OR `sender_id`. Case-insensitive. |
| `limit` | | Max results. Default `20`, clamped to `100`. |

**Return**

A numbered list of matching contacts grouped by JID, with latest push name, message count, chat count, and last-seen timestamp:

```
Found 3 contacts matching "juan":

1. Juan Pérez — `5491155556666@s.whatsapp.net`
   47 msgs across 3 chats · last seen 2026-04-20 22:14

2. Juan Carlos — `5491155557777@s.whatsapp.net`
   12 msgs across 1 chat · last seen 2026-04-18 15:30

3. Juancho — `5491166667777@s.whatsapp.net`
   3 msgs across 1 chat · last seen 2026-04-15 09:00
```

**Worked example**

> *"Do I have any contact named Juan on WhatsApp?"*

Claude calls `search_contact` with `query: "juan"`. The tool returns matches with JIDs. If the user follows up with *"send a hello to the first one"*, Claude extracts the first result's JID and passes it to `reply`.

**Pitfalls**

- **Only indexed senders appear.** If someone is in your contacts but has never sent a message through the bot, they won't appear. Run `fetch_history` on relevant chats to populate older senders.
- **Push name shown is the most recent.** WhatsApp users can change their display name — this tool surfaces whatever they were called in their last message.
- **Access-filtered.** Senders from chats currently outside the allowlist don't appear, even if they exist in `messages.db` from a past allowlist state. If you expect someone to appear but they don't, check `/whatsapp:access` for the relevant chat.
- **Outbound messages excluded.** Claude's own messages have `direction='out'` and no sender_id is matched. You'll never see the bot as a result.

---

## `block_contact`

Block a WhatsApp contact so they can no longer send messages via Baileys' `updateBlockStatus`. Only works on user JIDs — groups can't be blocked this way. No access gate: this is a defensive action that applies even to contacts outside the allowlist (spammers especially). Every call is logged to `logs/system.log`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | User JID ending in `@s.whatsapp.net` or `@lid`. Not a group. If only a phone is known, run `check_number_exists` first. |

**Return**

A one-line confirmation: `Blocked \`<jid>\`. They can no longer send you messages on WhatsApp.`

**Worked example**

> *"Block the number that keeps spamming me — +5491199999999."*

Claude first calls `check_number_exists` to resolve the canonical JID, then `block_contact` with that JID. Messages from that contact stop reaching the plugin from that point onwards.

**Pitfalls**

- **Immediate, server-side.** No confirmation prompt — if the agent decides to block, it happens. WhatsApp stops delivering messages from that sender.
- **Logged** to `logs/system.log` as `block_contact: blocked <jid>`. Check the log if you suspect an over-eager block.
- **Groups can't be blocked** this way — use `leave_group` (coming later) or `/whatsapp:access remove-group` instead.
- **Reversible** via `unblock_contact`.

---

## `unblock_contact`

Unblock a previously-blocked WhatsApp contact via Baileys' `updateBlockStatus`. Only works on user JIDs.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | User JID ending in `@s.whatsapp.net` or `@lid`. |

**Return**

A one-line confirmation with a caveat about the access allowlist: `Unblocked \`<jid>\`. They can now send you messages on WhatsApp again. Note: this does NOT re-add them to the plugin's access allowlist — use /whatsapp:access pair or allow for that.`

**Worked example**

> *"I blocked Juan by accident last week — unblock him."*

Claude calls `unblock_contact` with Juan's JID (the user must know the JID, or look it up via `search_contact`).

**Pitfalls**

- **Unblocking restores WhatsApp delivery, not the plugin's access gate.** If the contact was never on the allowlist, their messages will still be dropped by the plugin even after unblocking. Pair with `/whatsapp:access pair <code>` or `allow <jid>` to fully restore them.
- **Logged** to `logs/system.log` as `unblock_contact: unblocked <jid>`.

---

## `mark_read`

Mark one or more messages in a chat as read. Sends "blue checks" to the senders via Baileys' `readMessages`. Useful after the agent has actioned a batch of inbound messages and wants to clear the unread state.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | JID of the chat the messages belong to. Must be in the access allowlist. |
| `message_ids` | ✅ | Array of message IDs to mark as read. Source them from inbound notifications (`meta.message_id`), `search_messages` results, or `get_message_context`. Max 100 per call. |

**Return**

A one-line confirmation: `Marked N messages as read in \`<chat_id>\` (sent blue checks).`

**Worked example**

> *"I've answered the unread DMs from Juan — mark them as read."*

Claude collects the message IDs of Juan's recent inbound messages (from prior notifications or via `get_message_context`) and calls `mark_read` with the chat_id and the list of IDs. Juan now sees the blue checks on his side.

**Pitfalls**

- **Sends blue checks** — this is a privacy disclosure. The sender sees the user has read their message. If the user normally keeps read receipts disabled in WhatsApp, this tool re-discloses on a per-message basis.
- **Inbound only.** The tool hardcodes `fromMe: false` in the key — only inbound messages get marked. Outbound wouldn't make sense to mark.
- **Access-gated.** The chat must be in the access allowlist; non-allowlisted chats reject the call.
- **No partial-success reporting.** If `readMessages` accepts the batch but WhatsApp silently drops a key (e.g. for an expired message), the tool still reports success — WhatsApp doesn't surface per-key acknowledgements.

---

## `archive_chat`

Archive or unarchive a WhatsApp chat via Baileys' `chatModify`. Moves a chat out of the main list (or back in). Useful for inbox hygiene — clearing a long-resolved DM or moving a busy group out of the at-a-glance view without leaving it.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | JID of the chat to archive or unarchive. Must be in the access allowlist. |
| `archive` | ✅ | `true` to archive, `false` to unarchive. |

**Return**

A one-line confirmation: `Archived \`<chat_id>\`.` or `Unarchived \`<chat_id>\`.`

**Worked example**

> *"Archive the conversation with Juan — we're done with that thread."*

Claude resolves Juan's `chat_id` (from `list_chats` or earlier context), then calls `archive_chat` with `archive: true`. The chat moves to the Archived section in WhatsApp on all linked devices.

**Pitfalls**

- **Requires at least one indexed message.** Baileys' `chatModify` needs a `lastMessages` array to build the payload. The tool reads the most recent message from `messages.db` for the chat. If the chat has no indexed messages (e.g. a contact who paired but never sent anything), the tool errors with a clear "send or receive at least one message first" hint.
- **Access-gated.** Non-allowlisted chats are rejected.
- **Reversible.** `archive: false` brings the chat back into the main list.
- **Logged** to `logs/system.log` as `archive_chat: archived <jid>` (or `unarchived`).
- **Syncs to all linked devices.** WhatsApp propagates the archive state — the user's phone reflects the change too.

---

## `update_group_subject`

Rename a WhatsApp group via Baileys' `groupUpdateSubject`. Requires the bot to be an admin of the group.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `subject` | ✅ | New group name. Non-empty. |

**Return**

A one-line confirmation: `Updated subject of \`<jid>\` to "<subject>".`

**Worked example**

> *"Rename the team group to 'Q2 Launch Team'."*

Claude calls `update_group_subject` with the group's JID and the new name. WhatsApp updates the subject on all participants' devices.

**Pitfalls**

- **Bot must be admin.** If not, Baileys errors with a permission denial; the tool surfaces that with an actionable message.
- **Access-gated.** Group must be in `access.groups`.
- **Logged** to `logs/system.log` as `update_group_subject: <jid> → "<subject>"`.

---

## `update_group_description`

Update or clear a WhatsApp group description via Baileys' `groupUpdateDescription`. Pass an empty string or omit `description` to clear it. Requires the bot to be an admin.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `description` | | New description. Empty string or omitted = clear. |

**Return**

A one-line confirmation: `Updated description of \`<jid>\`.` or `Cleared description of \`<jid>\`.`

**Worked example**

> *"Update the team group description to 'Async standup at 10am Mon/Wed/Fri'."*

Claude calls `update_group_description` with the group's JID and the new text. To clear: pass `description: ""` or omit.

**Pitfalls**

- **Bot must be admin.** Same Baileys behavior as `update_group_subject`.
- **Access-gated.**
- **Logged** to `logs/system.log` as `update_group_description: <jid> updated` (or `cleared`).

---

## `update_group_settings`

Toggle group-level settings via Baileys' `groupSettingUpdate`. Two independent toggles surfaced as separate booleans for clarity.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `admins_only_messages` | | `true` = only admins can send messages (WhatsApp's "announcement" mode). `false` = everyone. Omit to leave unchanged. |
| `admins_only_info` | | `true` = only admins can edit subject/description/picture (WhatsApp's "locked" mode). `false` = everyone. Omit to leave unchanged. |

At least one of the two booleans must be provided; the tool errors otherwise.

**Return**

A one-line confirmation listing what was applied: `Updated settings of \`<jid>\`: messages: admins only; info edit: everyone.`

**Worked example**

> *"Lock the announcements group so only admins can send messages."*

Claude calls `update_group_settings` with `admins_only_messages: true` (and omits `admins_only_info` to leave it as-is).

**Pitfalls**

- **Bot must be admin.** Each toggle is a separate Baileys call (`groupSettingUpdate` accepts one setting at a time); if both booleans are passed, two calls happen sequentially. If the second fails the first stays applied — partial-state risk in pathological cases.
- **Access-gated.**
- **Logged** to `logs/system.log` as `update_group_settings: <jid> — messages: ..., info edit: ...`.

---

## `add_participants`

Add one or more participants to a WhatsApp group via Baileys' `groupParticipantsUpdate` with action `add`. Returns per-participant status so the agent can surface which JIDs succeeded and which failed (and why).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `participants` | ✅ | Array of user JIDs to add. Max 50 per call. If only phones are known, chain `check_number_exists` first. |

**Return**

A per-participant report with markers and the raw WhatsApp status code:

```
Add result for `120363xxx@g.us`:

✅ `5491155556666@s.whatsapp.net` — added (200)
❌ `5491155557777@s.whatsapp.net` — not found / invalid number (404)
⚠️ `5491155558888@s.whatsapp.net` — already in group (409)
```

Status codes follow WhatsApp's HTTP-like convention: `200` = success, `401`/`403` = bot not admin, `404` = invalid JID, `408` = timeout, `409` = already in group, `500` = server error.

**Worked example**

> *"Add Juan and María to the launch group."*

Claude resolves their JIDs (via `check_number_exists` if needed), then calls `add_participants` with the group `chat_id` and the JID array. The output tells Claude (and the user) exactly who got in.

**Pitfalls**

- **Bot must be admin.** Without admin status, every JID returns `403`. Surface the error.
- **Access-gated.** Group must be in `access.groups`.
- **Some contacts can't be added programmatically.** WhatsApp blocks adds when the target's privacy settings disallow it from non-contacts; those return `403` per-participant even if the bot is admin.
- **Logged** to `logs/system.log` with success / failure counts.

---

## `remove_participants`

Remove one or more participants from a WhatsApp group via Baileys' `groupParticipantsUpdate` with action `remove`. Same shape as `add_participants` but reversing the operation.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `participants` | ✅ | Array of user JIDs to remove. Max 50 per call. |

**Return**

A per-participant report:

```
Remove result for `120363xxx@g.us`:

✅ `5491155556666@s.whatsapp.net` — removed (200)
⚠️ `5491155557777@s.whatsapp.net` — not in group (409)
```

Status codes mirror `add_participants`. Note the meaning of `409` flips: here it means "not in the group".

**Worked example**

> *"Kick Juan from the launch group — he left the team."*

Claude calls `remove_participants` with the group `chat_id` and Juan's JID.

**Pitfalls**

- **Bot must be admin.**
- **Access-gated.**
- **Removing the bot itself is not what this tool is for** — use `leave_group` (coming later) instead. WhatsApp may allow the call, but the result is undefined behavior.
- **Logged** to `logs/system.log` with success / failure counts.

---

## `promote_admins`

Promote one or more group members to admin via Baileys' `groupParticipantsUpdate` with action `promote`. Same input / output shape as `add_participants` / `remove_participants`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `participants` | ✅ | Array of user JIDs to promote. Max 50 per call. Must already be members of the group. |

**Return**

A per-participant report:

```
Promote result for `120363xxx@g.us`:

✅ `5491155556666@s.whatsapp.net` — promoted (200)
❌ `5491155557777@s.whatsapp.net` — not found / invalid number (404)
```

Status code semantics: `200` success, `403` bot not admin (or not super admin in some communities), `404` not in group, `409` already an admin.

**Worked example**

> *"Make Juan an admin of the launch group."*

Claude calls `promote_admins` with the group's `chat_id` and Juan's JID.

**Pitfalls**

- **Bot must be admin** (super admin in some communities). Otherwise every call returns `403`.
- **Participants must already be members.** Promote acts on existing members; non-members return `404`. Use `add_participants` first.
- **Access-gated.**
- **Logged** to `logs/system.log` with success / failure counts.

---

## `demote_admins`

Demote one or more admins back to regular members via Baileys' `groupParticipantsUpdate` with action `demote`. Mirror of `promote_admins`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `participants` | ✅ | Array of admin JIDs to demote. Max 50 per call. Must currently be admins. |

**Return**

A per-participant report:

```
Demote result for `120363xxx@g.us`:

✅ `5491155556666@s.whatsapp.net` — demoted (200)
⚠️ `5491155557777@s.whatsapp.net` — not in group (409)
```

**Worked example**

> *"Demote Juan from admin in the team group."*

Claude calls `demote_admins` with the group's `chat_id` and Juan's JID.

**Pitfalls**

- **Bot must be admin.**
- **Cannot demote the super admin** (the group creator). WhatsApp rejects with `403` per-participant.
- **Watch out for self-demotion.** If the bot is the only admin and demotes itself, no admins remain — subsequent group admin calls will fail.
- **Access-gated.**
- **Logged** to `logs/system.log`.

---

## `leave_group`

Bot leaves a WhatsApp group via Baileys' `groupLeave`. Destructive — re-entering requires an invite from a current member.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |

**Return**

A confirmation that includes the next-step recovery hint:

```
Left `120363xxx@g.us` and removed it from the access allowlist. To rejoin, the bot needs an invite from a current member, then run /whatsapp:access group-add 120363xxx@g.us.
```

**Worked example**

> *"Leave the spam group I got added to."*

Claude calls `leave_group` with the group's `chat_id`. The bot exits, the group entry is auto-removed from `access.json`, and any further attempts to message the group will be rejected by `assertAllowedGroup`.

**Pitfalls**

- **Destructive.** No undo — the bot is out. Re-entry requires another member to invite the bot, then re-adding to `access.groups`.
- **Auto-cleanup of `access.groups`.** The group entry is removed automatically so the agent can't accidentally try to use the group afterwards. The cleanup is best-effort; if the access file is corrupt the leave still succeeds and a warning is logged.
- **Access-gated.** Group must be in `access.groups` to call (you can't leave a group you never allowed).
- **Logged** to `logs/system.log`.

---

## `toggle_group_ephemeral`

Set or clear the disappearing-messages timer for a WhatsApp group via Baileys' `groupToggleEphemeral`. Accepts any non-negative number of seconds.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `duration_seconds` | ✅ | `0` = disable disappearing messages. WhatsApp's standard presets: `86400` (24h), `604800` (7d), `2592000` (30d), `7776000` (90d). |

**Return**

A one-line confirmation: `Ephemeral messages for \`<jid>\` set to <N>s.` or `... set to disabled.`

**Worked example**

> *"Set the strategy group to wipe messages after 7 days."*

Claude calls `toggle_group_ephemeral` with `duration_seconds: 604800`.

**Pitfalls**

- **Bot typically must be admin.** Non-admins can't change ephemeral settings unless the group itself permits it.
- **WhatsApp clients render only the standard presets nicely.** Custom values (e.g. 3600 = 1 hour) are accepted by the protocol and applied, but most clients show "custom" instead of a friendly label.
- **Access-gated.**
- **Logged** to `logs/system.log` as `toggle_group_ephemeral: <jid> → <status>`.

---

## `handle_join_request`

Manage pending join requests for a WhatsApp group with restricted-add settings. Single tool with three actions:

- `list` — enumerate currently pending requests (no mutation).
- `approve` — admit specific JIDs into the group.
- `reject` — deny specific JIDs.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |
| `action` | ✅ | One of `list`, `approve`, `reject`. |
| `participants` | conditional | Required when `action` is `approve` or `reject`. Array of user JIDs to act on. Max 50. Discover them via action `list` first. |

**Return**

For `list`:

```
Pending join requests for `120363xxx@g.us`:

• `5491155556666@s.whatsapp.net` — via invite_link
• `5491155557777@s.whatsapp.net` — via non_admin_add
```

For `approve` / `reject`:

```
Approve result for `120363xxx@g.us`:

✅ `5491155556666@s.whatsapp.net` — approved (200)
❌ `5491155557777@s.whatsapp.net` — failed (404)
```

**Worked example**

> *"Approve all the pending requests on the community group."*

Claude calls `handle_join_request` with `action: 'list'` first, gets the pending JIDs, then calls again with `action: 'approve'` and the `participants` array.

**Pitfalls**

- **Bot must be admin.** Otherwise `list` errors and approve/reject return `403` per JID.
- **Access-gated.**
- **Approve/reject are logged** to `logs/system.log`. `list` is read-only and not logged.

---

## `create_group`

Create a new WhatsApp group via Baileys' `groupCreate`. The bot becomes super admin. The new group is **automatically registered** to `access.groups` in open mode (no mention required, no member restrictions) so the bot can interact with it immediately — without this auto-step the agent would have to run `/whatsapp:access group-add` manually right after creating the group.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `subject` | ✅ | Group name. Non-empty. |
| `participants` | | Initial members as user JIDs. Empty array allowed — creates a bot-only group; add members later via `add_participants`. Max 50. |

**Return**

A confirmation with the new group JID and participant count:

```
Created group "Q2 Launch Team" → `120363xxx@g.us` with 3 initial participants. Auto-registered to access.groups in open mode.
```

**Worked example**

> *"Create a group called 'Q2 Launch Team' with Juan and María."*

Claude resolves the JIDs (via `check_number_exists` if needed), then calls `create_group` with the subject and the JID array. The new JID can be used immediately for further ops.

**Pitfalls**

- **WhatsApp throttles bulk group creation.** Don't create dozens of groups back-to-back — you'll trigger anti-spam.
- **Some contacts can't be added at creation** for the same privacy reasons as `add_participants` (their settings disallow non-contact adds). They're omitted from the participant list silently; check `get_group_metadata` after to see who actually got in.
- **Auto-registration uses open mode.** If you want to gate the new group, run `/whatsapp:access group-add <new-jid> --mention` (mention-only) or set per-member allowlist via `group-allow` after creation.
- **Logged** to `logs/system.log`.

---

## `join_group`

Join a WhatsApp group via an invite code or invite link, using Baileys' `groupAcceptInvite`. The joined group is **automatically registered** to `access.groups` in open mode (same auto-register logic as `create_group`).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `invite` | ✅ | Either the 8-character invite code (e.g. `AbCdEf12`) or the full URL (`https://chat.whatsapp.com/AbCdEf12345678`). The URL form gets parsed automatically. |

**Return**

A confirmation with the joined group JID:

```
Joined group `120363xxx@g.us` via invite code `AbCdEf12345678`. Auto-registered to access.groups in open mode.
```

**Worked example**

> *"Join this group: https://chat.whatsapp.com/AbCdEf12345678."*

Claude calls `join_group` with the URL. The plugin extracts the code, accepts the invite, and the bot is now in the group with full access.

**Pitfalls**

- **Expired or revoked codes fail** — Baileys returns no JID; the tool errors with a clear "may be expired, revoked, or invalid" hint.
- **Already in the group** — Baileys typically returns the existing JID, no error. The auto-register is a no-op.
- **Spam invites** — joining a malicious group still works mechanically, but the bot may be exposed. Treat invites from unknown sources cautiously.
- **Logged** to `logs/system.log`.

---

## `get_invite_code`

Get the current invite code for a WhatsApp group via Baileys' `groupInviteCode`. Returns the 8-character code; the full invite URL is `https://chat.whatsapp.com/<code>`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |

**Return**

The code and the full invite URL:

```
Invite code for `120363xxx@g.us`: `AbCdEf12345678`
Full invite URL: https://chat.whatsapp.com/AbCdEf12345678
```

**Worked example**

> *"Get me the invite link for the launch group."*

Claude calls `get_invite_code` with the group's `chat_id` and returns the URL to the user.

**Pitfalls**

- **Bot must be admin.** Without admin status, Baileys returns no code; the tool errors.
- **Access-gated.**
- **Anyone with this code can join** the group (subject to the group's join-request settings — see `handle_join_request`). Treat the code like a password.

---

## `revoke_invite_code`

Revoke the current invite code for a WhatsApp group and generate a new one, via Baileys' `groupRevokeInvite`. The old invite link stops working immediately. Returns the new code in the same call (no need to chain `get_invite_code` after).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Group JID ending in `@g.us`. Must be in `access.groups`. |

**Return**

The new code and full invite URL:

```
Revoked old invite for `120363xxx@g.us`. New code: `XyZ12345678AbCd`
Full invite URL: https://chat.whatsapp.com/XyZ12345678AbCd
```

**Worked example**

> *"Someone leaked the invite link to the team group — rotate it."*

Claude calls `revoke_invite_code` with the group's `chat_id`. The old link dies; the new one is returned immediately so Claude can share it with the legitimate members.

**Pitfalls**

- **Bot must be admin.**
- **Access-gated.**
- **Members already in the group are unaffected** — only future joiners using the old code are blocked.
- **Logged** to `logs/system.log`.

---

## `pin_chat`

Pin or unpin a WhatsApp chat to the top of the chat list via Baileys' `chatModify`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `pin` | ✅ | `true` to pin, `false` to unpin. |

**Return**

A one-line confirmation: `Pinned \`<jid>\`. WhatsApp allows up to 3 pinned chats; if 3 are already pinned, the call may have failed silently.`

**Pitfalls**

- **3-pin limit.** WhatsApp allows max 3 pinned chats. Adding a 4th typically fails silently — the tool can't tell. Use `list_chats` to verify after.
- **Access-gated.**
- **Logged** to `logs/system.log`.

---

## `mute_chat`

Mute or unmute a WhatsApp chat for a specified duration via Baileys' `chatModify`. Internally converts a relative duration in seconds to the absolute future ms-epoch that Baileys expects.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `mute_until_seconds` | ✅ | Seconds from now until the mute expires. `0` = unmute. Common: `28800` (8h), `604800` (7d), `31536000` (1y / "always"). |

**Return**

A one-line confirmation: `Muted for <N>s \`<jid>\`.` or `Unmuted \`<jid>\`.`

**Pitfalls**

- **Server-side mute** — propagates to all linked devices, including the user's phone.
- **Access-gated.**
- **Logged** to `logs/system.log`.

---

## `delete_chat`

Delete a WhatsApp chat from the user's chat list via Baileys' `chatModify` with `delete: true`. Destructive but recoverable: the chat reappears as soon as a new message arrives in it.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |

**Return**

A one-line confirmation: `Deleted \`<jid>\` from the chat list. Note: the chat reappears if a new message arrives.`

**Pitfalls**

- **Destructive on the chat-list side.** The chat is removed from the user's WhatsApp clients. Message history is preserved server-side and reappears with the next inbound.
- **Requires at least one indexed message** in `messages.db` to build the `lastMessages` payload Baileys requires.
- **Access-gated.**
- **Logged** to `logs/system.log`.

---

## `clear_chat`

Clear all message history from a WhatsApp chat while keeping the chat itself in the list, via Baileys' `chatModify` with `clear: true`. Destructive on the message side.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |

**Return**

A one-line confirmation: `Cleared message history of \`<jid>\` from your WhatsApp clients. The chat itself stays in the list.`

**Pitfalls**

- **Destructive — messages disappear from the user's WhatsApp clients.** The plugin's local SQLite store (`messages.db`) is unaffected; FTS, export, and history backfill keep working.
- **Requires at least one indexed message** to build the `lastMessages` payload.
- **Does not affect the other party's view.** Only your own clients clear.
- **Access-gated.**
- **Logged** to `logs/system.log`.

---

## `send_location`

Send a static location to a chat via Baileys' `sendMessage` with a location payload.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `latitude` | ✅ | Decimal degrees, -90 to 90. |
| `longitude` | ✅ | Decimal degrees, -180 to 180. |
| `name` | | Location title (e.g. `"Café Central"`). |
| `address` | | Location subtitle / address. |

**Return**

A confirmation: `Sent location <lat>, <lng> (<name>) to \`<jid>\`.`

**Worked example**

> *"Send Juan our office location: -33.4513, -70.6653, 'Office HQ', 'Av. Apoquindo 1234'."*

Claude calls `send_location` with the coords + optional metadata. The receiver sees the WhatsApp location card with title and address.

**Pitfalls**

- **Static, not live.** Live-location streaming is not exposed by this tool.
- **Access-gated.**

---

## `send_contact`

Send a contact card to a chat via Baileys' `sendMessage`. The tool builds the vCard 3.0 string from structured fields — the agent does not need to know vCard syntax.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `name` | ✅ | Display name. |
| `phone` | ✅ | E.164 format (with or without `+`). Non-digit characters are stripped before building the `waid` field. Must normalize to 7–15 digits. |
| `email` | | Optional email. |

**Return**

A confirmation: `Sent contact card "<name>" (+<phone>) to \`<jid>\`.`

**Worked example**

> *"Send my dentist's contact to María: name 'Dr. Salinas', phone +56 9 8765 4321."*

Claude calls `send_contact` with the structured fields; the tool produces a vCard 3.0 with the WhatsApp-ID hint (`waid`) so tapping it on the recipient's phone offers WhatsApp message / call as an option.

**Pitfalls**

- **vCard 3.0 only** — older clients that don't parse it gracefully might show a raw card.
- **Single contact per call** — to send multiple, call repeatedly.
- **Access-gated.**

---

## `send_link_preview`

Send a text message with an explicit link-preview card (title + optional description / thumbnail) via Baileys' `sendMessage` with `linkPreview`. Use when you want guaranteed preview metadata, regardless of whether WhatsApp can fetch the URL itself.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `text` | ✅ | Message body. Should contain or reference the URL. |
| `url` | ✅ | Canonical URL the preview points to. |
| `title` | ✅ | Preview title. WhatsApp rejects link previews without a title. |
| `description` | | Optional preview description. |
| `thumbnail_url` | | Optional thumbnail image URL (maps to WAUrlInfo `originalThumbnailUrl`). |

**Return**

A confirmation: `Sent link preview to \`<jid>\` for <url> ("<title>").`

**Worked example**

> *"Send Juan the launch announcement link with title 'Q2 Launch' and description 'Live on April 30'."*

Claude calls `send_link_preview` with the URL + custom metadata. The card appears in WhatsApp with the explicit title / description rather than whatever WhatsApp would auto-fetch.

**Pitfalls**

- **`title` is mandatory** — Baileys / WhatsApp reject empty-title previews.
- **For URLs WhatsApp can preview itself, just `reply` with the URL in the text** — auto-preview kicks in for most public URLs without needing this tool.
- **Access-gated.**

---

## `send_voice_note`

Send a voice note (push-to-talk audio message) to a WhatsApp chat. Accepts any audio file path; the tool converts it to mono 16kHz OGG Opus via ffmpeg before sending — WhatsApp requires this format for voice notes.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `file_path` | ✅ | Absolute path to the source audio file. Any format ffmpeg can decode (mp3, wav, m4a, flac, etc.). |

**Return**

A confirmation with the OGG byte size: `Sent voice note to \`<jid>\` (<N> KB OGG Opus, source: <path>).`

**Worked example**

> *"Generate a hello in my voice and send it to Juan."*

A separate TTS tool produces `/tmp/hello.wav`. Claude calls `send_voice_note` with that path; the tool converts to OGG Opus and sends.

**Pitfalls**

- **ffmpeg required.** Install via `brew install ffmpeg` (macOS), `apt-get install ffmpeg` (Linux), or equivalent. The tool errors with a clear hint if missing.
- **Conversion is always run** — even if the input is already OGG. This guarantees correct codec / sample rate for WhatsApp's playback.
- **Mono 16kHz 32kbps.** Optimized for voice intelligibility, not music quality.
- **Source file is not auto-deleted.** The plugin's local SQLite indexes the source path in `meta.source_path` for traceability.
- **Access-gated.**

---

## `send_presence`

Manually send a presence update to a chat via Baileys' `sendPresenceUpdate`. Five states: `composing` (typing), `recording` (recording voice), `paused` (clear), `available` (online), `unavailable` (offline).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `presence` | ✅ | One of `composing`, `recording`, `paused`, `available`, `unavailable`. |

**Return**

A one-line confirmation: `Sent presence \`<presence>\` to \`<jid>\`.`

**Worked example**

> *"Show María the recording indicator while you generate the voice note."*

Claude calls `send_presence` with `presence: 'recording'`, then runs the TTS tool, then `send_voice_note`. María sees "recording…" while Claude prepares the audio.

**Pitfalls**

- **Distinct from auto-typing-on-inbound.** The plugin already auto-fires `composing` when a message arrives and `paused` after the reply is sent (see `server.ts:1055-1056`, `2069-2070`). Use this tool only for explicit overrides — e.g. setting `recording` before `send_voice_note`, or manually clearing a stuck state with `paused`.
- **Server-side timeout.** WhatsApp clears `composing` / `recording` after ~10-15 seconds if no follow-up; pair with a real send to keep the indicator alive.
- **Access-gated.**

---

## `update_profile_name`

Update the bot's WhatsApp profile name (the display name other users see) via Baileys' `updateProfileName`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `name` | ✅ | New display name. Non-empty. |

**Return**

A one-line confirmation: `Updated profile name to "<name>".`

**Pitfalls**

- **Server-side change.** Propagates to all linked devices and other users.
- **Logged** to `logs/system.log`.

---

## `update_profile_status`

Update the bot's WhatsApp profile status / "About" text (the short bio on the profile) via Baileys' `updateProfileStatus`. Pass an empty string to clear.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `status` | ✅ | New status text. Empty string clears it. |

**Return**

`Updated profile status to "<status>".` or `Cleared profile status.`

**Pitfalls**

- **Server-side change.**
- **Visibility is governed by `status` privacy** (see `update_privacy`).
- **Logged** to `logs/system.log`.

---

## `update_profile_picture`

Update the bot's WhatsApp profile picture from a local image file via Baileys' `updateProfilePicture`.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `file_path` | ✅ | Absolute path to a JPEG or PNG image. |

**Return**

`Updated profile picture from <path> (<N> KB).`

**Pitfalls**

- **WhatsApp auto-resizes** large images server-side; very small / very large files may end up cropped or pixelated.
- **Visibility is governed by `profile_picture` privacy** (see `update_privacy`).
- **Logged** to `logs/system.log`.

---

## `remove_profile_picture`

Clear the bot's WhatsApp profile picture via Baileys' `removeProfilePicture`. Falls back to WhatsApp's default avatar.

**Arguments**

(No arguments.)

**Return**

`Removed profile picture (defaulted to WhatsApp avatar).`

**Pitfalls**

- **Logged** to `logs/system.log`.

---

## `update_privacy`

Update one or more of the bot's WhatsApp privacy settings via the corresponding Baileys `update*Privacy` calls. Pass any subset of the six settings; each maps to a separate Baileys call.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `last_seen` | | `all` / `contacts` / `contact_blacklist` / `none`. Who can see the "last seen" timestamp. |
| `online` | | `all` / `match_last_seen`. Who can see online status. `match_last_seen` follows the `last_seen` setting. |
| `profile_picture` | | `all` / `contacts` / `contact_blacklist` / `none`. Who can see the profile picture. |
| `status` | | `all` / `contacts` / `contact_blacklist` / `none`. Who can see the profile status / About text. |
| `read_receipts` | | `all` / `none`. Whether to send blue checks. `none` disables read receipts globally. |
| `groups_add` | | `all` / `contacts` / `contact_blacklist`. Who can add the bot to groups. |

At least one setting must be provided.

**Return**

`Updated privacy: <setting1>: <value1>; <setting2>: <value2>; ...`

**Pitfalls**

- **Settings apply sequentially.** If one fails mid-batch, earlier ones in the same call are already applied — the error message says so.
- **Disabling read receipts disables them both ways** — the bot stops sending blue checks AND stops receiving them on outbound messages.
- **Logged** to `logs/system.log`.

---

## `get_chat_analytics`

Aggregate stats for a chat from the local SQLite store. Pure query — no WhatsApp roundtrip.

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID. Must be in the access allowlist. |
| `since_days` | | Optional lookback window in days. Default: all-time. |

**Return**

A plain-text report with sections for totals, top senders (up to 10), hourly distribution (0-23 UTC), and daily distribution (Sun-Sat) — both shown as horizontal bar charts:

```
Chat analytics for `120363xxx@g.us` (last 7 days):

Total: 247 messages (213 inbound, 34 outbound)
Unique senders: 8
First message: 2026-04-14 09:23
Last message: 2026-04-21 19:45

Top senders (by inbound message count):
1. Pedro Ramirez `5491155556666@s.whatsapp.net` — 67 msgs, last 2026-04-21 19:45
2. Carlos Perez `5491155557777@s.whatsapp.net` — 54 msgs, last 2026-04-21 18:30
...

Hourly inbound activity (UTC):
  00:                      | 0
  ...
  14: ████████████████████ | 32
  ...

Daily inbound activity:
  Sun: ██                   | 12
  Mon: ████████████████████ | 41
  ...
```

**Worked example**

> *"What hours is the team group most active?"*

Claude calls `get_chat_analytics` with the group's `chat_id` and `since_days: 7`, then summarizes the hourly distribution.

**Pitfalls**

- **Only inbound traffic** is bucketed in the hourly / daily distribution. Outbound counts roll up into the totals but not the buckets.
- **UTC bucketing** for hourly — convert in your head if the chat is in another timezone.
- **Access-gated** — chat must be in the allowlist.
- **No WhatsApp roundtrip** — pure SQLite. Fast even for large stores.

---

## `forward_message`

Forward an existing message to another chat via Baileys' `sendMessage` with a `forward` payload. Reads the original WAMessage proto from the local SQLite store, which is cached at index time since v1.16.0+ (older messages have `raw_message=NULL` and cannot be forwarded).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `target_chat_id` | ✅ | JID of the chat to forward TO. Must be in the access allowlist. |
| `message_id` | ✅ | Source message ID to forward. Get it from `search_messages`, `get_message_context`, or an inbound `meta.message_id`. Must have been indexed with raw_message caching (v1.16.0+). |

**Return**

A confirmation: `Forwarded message \`<message_id>\` (originally from \`<source_chat>\`) to \`<target_chat>\`.`

**Worked example**

> *"Forward the funny meme Pedro sent yesterday to María."*

Claude calls `search_messages` to find the message ID, then `forward_message` with `target_chat_id` (María's JID) and the source `message_id`. The message reappears in María's chat with WhatsApp's "Forwarded" header.

**Pitfalls**

- **Only post-v1.16.0 messages can be forwarded.** Older indexed messages have no cached raw payload. The tool errors clearly when this happens.
- **Text messages forward reliably; media may have edge cases.** The cached proto is round-tripped through JSON (with bigint coercion), which works perfectly for text but can lose Buffer fidelity for media keys. If a media forward fails, the tool surfaces the error — fall back to `download_attachment` + `reply` with the file as a workaround.
- **Target chat is access-gated**, source chat is not (you can forward FROM a non-allowlisted chat as long as the message is indexed).
- The forward is itself indexed into `messages.db` as an outbound message with `meta.kind = "forward"` and `source_message_id` for traceability.
- **Logged** to `logs/system.log`.

---

## `reject_call`

Reject an incoming WhatsApp call via Baileys' `rejectCall(call_id, call_from)`. Use in response to an `[Incoming call from ...]` channel notification — the notification's `meta` carries `call_id` and `call_from` exactly for this purpose.

**Channel notification for incoming calls.** As of v1.16.0, the plugin surfaces every inbound call offer as a channel notification:

```
content: [Incoming call from 5491155556666@s.whatsapp.net]
meta:
  kind: call_offer
  call_id: <opaque id>
  call_from: <caller JID>
  is_video: true|false
  message_id: call-<call_id>
```

The agent can decide to call `reject_call` with those two meta fields, or simply ignore the notification (the call rings out / is answered elsewhere).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `call_id` | ✅ | Call ID from the notification meta (`meta.call_id`). |
| `call_from` | ✅ | Caller JID from the notification meta (`meta.call_from`). Required by Baileys to route the rejection. |

**Return**

A one-line confirmation: `Rejected call \`<call_id>\` from \`<call_from>\`.`

**Pitfalls**

- **Reject is server-side and immediate.** No undo — the caller sees a missed-call entry.
- **No access gate** — this is a defensive action and works regardless of whether the caller is in the allowlist.
- **Other call lifecycle events** (accept, timeout, etc.) are best-effort logged to `logs/system.log` but are NOT surfaced as channel notifications. Only `offer` reaches the agent.
- **Logged** to `logs/system.log`.

---

## `pin_message`

Pin or unpin a specific message in a WhatsApp chat via Baileys' `sendMessage` with a `pin` payload. WhatsApp's pin feature is per-message (separate from chat-level pinning — see `pin_chat` for that).

**Arguments**

| Field | Required | Notes |
|---|---|---|
| `chat_id` | ✅ | Chat JID where the message lives. Must be in the access allowlist. |
| `message_id` | ✅ | ID of the message to pin or unpin. |
| `action` | ✅ | `pin` or `unpin`. |
| `duration_seconds` | conditional | Required when `action` is `pin`. Must be one of `86400` (24h), `604800` (7d), `2592000` (30d) — WhatsApp only allows those three. Ignored for unpin. |

**Return**

A one-line confirmation: `Pinned message \`<id>\` in \`<chat_id>\` for <N> day(s).` or `Unpinned message ...`

**Worked example**

> *"Pin Pedro's message about the meeting time for the next 7 days."*

Claude resolves the message ID (from `search_messages` or recent context) and calls `pin_message` with `action: 'pin'` and `duration_seconds: 604800`.

**Pitfalls**

- **Three durations only.** WhatsApp does not allow custom pin durations — only 24h, 7d, or 30d. The tool rejects other values.
- **`fromMe` is auto-resolved** from the cached WAMessage proto in `messages.db` (since v1.16.0). For messages indexed before raw caching, `fromMe` defaults to `false` — this is correct for inbound messages but wrong for outbound; if pinning an old outbound message fails, that's why.
- **Distinct from `pin_chat`.** `pin_chat` pins the entire chat to the top of the chat list; `pin_message` pins a single message inside a chat. WhatsApp surfaces them in different UI affordances.
- **Access-gated** on `chat_id`.
- **Logged** to `logs/system.log`.

---

## What's NOT a tool (yet)

- **Group administration.** Creating groups, renaming them, adding or removing members, promoting admins. Do these from your phone manually — on the roadmap but not shipped.
- **Outbound voice notes.** Inbound voice is received and optionally transcribed ([docs/media-voice.md](media-voice.md)); sending a voice message from Claude isn't exposed today.
- **Status / story posts.** Not part of WhatsApp Web's API surface that Baileys covers.
- **Group invite links.** Read or generate them from your phone.
