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
   47 msgs · last (in, Pedro): "donde jugamos hoy?" · 2026-04-19 21:00

3. DM `5491166667777@s.whatsapp.net`
   5 msgs · last (out, Claude): "Listo, agendado" · 2026-04-18 18:45
```

**Worked example**

> *"¿Qué chats activos tengo en WhatsApp?"*

Claude calls `list_chats` with no arguments. The tool returns the formatted list filtered to the allowlist. Claude then summarizes, or — if the user follows up with *"exportá la conversación con Juan"* — extracts the DM's `chat_id` from the list and passes it to `export_chat`.

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

> *"¿Juan está en WhatsApp? Es +5491155556666."*

Claude calls `check_number_exists` with `phones: ["+5491155556666"]`. On `exists: true`, Claude can say *"Sí, está activo"* with confidence, and has the JID ready if the user follows up with *"mandale un saludo"*.

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
Description: Juntada semanal de fútbol 5
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

> *"¿quiénes son admins del grupo Fútbol Lunes?"*

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

> *"¿El +56987654321 es un negocio? ¿Qué hacen?"*

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

  [2026-04-20 21:00:12] Pedro: donde jugamos hoy?
  [2026-04-20 21:00:34] Carlos: en el club como siempre
  [2026-04-20 21:01:05] Pedro: ah dale
→ [2026-04-20 21:01:33] Juan: a qué hora?
  [2026-04-20 21:02:01] Carlos: 7pm
  [2026-04-20 21:02:15] Pedro: voy
```

**Worked example**

> *"Buscá 'partido' y dame contexto del primer resultado."*

Claude calls `search_messages` with `query: "partido"`, receives hits with `id` fields, then calls `get_message_context` with the first hit's `id`. With the surrounding thread in hand, Claude can answer follow-ups like *"¿qué respondieron?"* or *"respondele a ese mensaje con un resumen"*.

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

> *"¿Tengo algún Juan en WhatsApp?"*

Claude calls `search_contact` with `query: "juan"`. The tool returns matches with JIDs. If the user follows up with *"mandale un saludo al primero"*, Claude extracts the first result's JID and passes it to `reply`.

**Pitfalls**

- **Only indexed senders appear.** If someone is in your contacts but has never sent a message through the bot, they won't appear. Run `fetch_history` on relevant chats to populate older senders.
- **Push name shown is the most recent.** WhatsApp users can change their display name — this tool surfaces whatever they were called in their last message.
- **Access-filtered.** Senders from chats currently outside the allowlist don't appear, even if they exist in `messages.db` from a past allowlist state. If you expect someone to appear but they don't, check `/whatsapp:access` for the relevant chat.
- **Outbound messages excluded.** Claude's own messages have `direction='out'` and no sender_id is matched. You'll never see the bot as a result.

---

## What's NOT a tool (yet)

- **Group administration.** Creating groups, renaming them, adding or removing members, promoting admins. Do these from your phone manually — on the roadmap but not shipped.
- **Outbound voice notes.** Inbound voice is received and optionally transcribed ([docs/media-voice.md](media-voice.md)); sending a voice message from Claude isn't exposed today.
- **Status / story posts.** Not part of WhatsApp Web's API surface that Baileys covers.
- **Group invite links.** Read or generate them from your phone.
