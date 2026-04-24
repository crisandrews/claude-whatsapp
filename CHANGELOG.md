# Changelog

## [Unreleased]

### Added

- Chat-scope governance. New `access.json` fields: `ownerJids: string[]` identifies the cross-chat owner(s); `groups[*].historyScope` and `dms[*].historyScope` configure per-chat read access (`"own"` | `"all"` | `string[]` of extra chat JIDs). New subcommands: `/whatsapp:access show-owner`, `set-owner <jid>`, `show-scope <chat>`, `set-scope <chat> <scope>`. `set-scope` validates every CSV JID against the allowlist so typos can't create phantom state.
- Nine history-reading and exfil tools now enforce server-side scope: `search_messages`, `fetch_history`, `export_chat`, `list_group_senders`, `get_message_context`, `get_chat_analytics`, `list_chats`, `search_contact`, and `forward_message`. The server tags each inbound with its originating chat and rejects out-of-scope calls with `history scope: chat_id <jid> not accessible from this session`.
- `getMessageContext` and `getRawMessage` in `db.ts` accept an optional `allowedChatIds` whitelist. Message IDs are only unique per `(chat_id, id)`, so a naked lookup could otherwise surface a row from a chat outside the caller's scope — `forward_message` and `get_message_context` now pass the scope-filtered chat list.
- `SearchOptions.chat_ids` added to `db.ts` for multi-chat search filtering with short-circuit on empty scope.
- `scope.ts` module with pure `resolveScope` / `scopedAllowedChats` / `assertReadableScope` helpers + `scope.test.ts` unit coverage (owner, non-owner defaults, per-chat overrides, terminal bootstrap, TTL fail-closed).

### Changed

- **Default behavior**: non-owner chats are now sandboxed to their own history. Before this release, any allowlisted chat could read any other allowlisted chat's history. The first `/whatsapp:access pair <code>` after upgrading seeds `ownerJids` with both JID formats (`@lid` and `@s.whatsapp.net`), granting the paired user cross-chat access automatically. Until then the channel is in bootstrap mode (no scope enforced), so upgrading an existing install doesn't silently break the operator's own access.
- Terminal invocations of read tools while an owner is configured and no recent WhatsApp inbound exists now return a `history scope` error (fail-closed). Set `WHATSAPP_OWNER_BYPASS=1` in the environment to restore unrestricted terminal access.

### Security

- Fixed a potential exfiltration path in `forward_message`: the tool previously forwarded any cached message by ID regardless of which chat it came from. It now refuses to forward messages whose source chat is outside the caller's history scope.

## [1.17.2] — 2026-04-24

### Fixed

- `README.md` Highlights: voice transcription line claimed "no API keys" without acknowledging the cloud provider opt-in shipped in v1.13.0. Now reads "local Whisper by default (no API keys, 99+ languages); optional cloud providers (Groq / OpenAI) for higher quality on slower hardware".
- `docs/media-voice.md` "What's NOT supported": removed the "Sending voice notes... isn't exposed" line — `send_voice_note` has been a tool since v1.15.0. Replaced with a positive callout linking to the tool reference, plus minor copy fixes (`send_contact` works for outbound vCards, `send_location` works for outbound static locations).
- `docs/groups.md`: added a new "Group admin from Claude" section listing all 14 group MCP tools (`get_group_metadata`, `add_participants`, `promote_admins`, `create_group`, `join_group`, etc.) introduced across v1.13.0 → v1.16.0. Previously the doc made no mention of them — anyone reading the groups doc would conclude group admin "isn't supported".
- `docs/state-contract.md`: documented the `raw_message TEXT` column added to `messages.db` in v1.16.0, including its purpose (powers `forward_message`), backward-compat behavior (older rows are NULL), the rough storage cost (~1 KB per message), and the privacy implication (caches more proto metadata, all of which already lives in Baileys' session state on the user's machine).
- `docs/tools.md` table of contents: replaced the 10-tool list (which only covered the original tool set through v1.12) with a 12-category index covering all 52 tools. Anyone scanning the doc by TOC now finds every tool.

## [1.17.1] — 2026-04-24

### Added

- Test coverage for the backbone `db.ts` functions: `searchMessages` (5 tests for FTS5 single-term match, chat scope, limit cap, no-match, ts ordering), `getMessages` (4 tests for chat scope, before_ts / after_ts windowing, empty), and `formatExport` (5 tests for markdown / jsonl / csv output, CSV escaping of quotes and commas, empty input, chronological ASC re-sort). 14 new tests; total now 86 across `lib.test.ts` + `db.test.ts`.

## [1.17.0] — 2026-04-23

### Added

- New MCP tool `pin_message` — pins or unpins a specific message in a WhatsApp chat via Baileys' `sendMessage` with a `pin` payload. WhatsApp accepts only three pin durations (`86400` = 24h, `604800` = 7d, `2592000` = 30d); the tool validates. The `fromMe` flag is auto-resolved from the cached WAMessage proto in `messages.db` (defaults to `false` for messages indexed before raw caching). Distinct from `pin_chat` (which pins the entire chat to the top of the chat list). Closes the last benchmark gap.
- Test coverage for `db.ts` — new `db.test.ts` adds 20 unit tests covering `listChats`, `getMessageContext`, `searchContacts`, `getChatAnalytics`, `getRawMessage`, `getChatSenders`. Tests spin up a temp SQLite file, seed known data, assert results, and tear down — pure DB-level, no Baileys / no network. Run via `npm test` alongside the existing `lib.test.ts` (now 72 tests total). Already paid off: the test pass surfaced two real bugs (see Fixed below).
- README tool index — the `Tools` section in `README.md` now lists all 52 tools grouped into 12 categories (Messaging, Message types, Discovery, Chat mgmt, Group admin, Group lifecycle, Contacts, Profile, Calls, Presence, Analytics, Media). Replaces the previous 10-row table that only covered the original tool set.
- Richer `/whatsapp:configure status` output — the skill now surfaces every populated `config.json` field grouped by area (Voice, Inbound, Outbound shaping, Pairing) including newer fields (`outboundDelayMs`, `inboundDebounceMs`, `audioProvider`, `audioModel`, `audioQuality`) that previously weren't reported.

### Fixed

- `getChatSenders(chat_id)` (no `since_ts`) silently returned `[]` because the optional `since_ts` was passed as `undefined` in the named params object, which better-sqlite3 rejects. The function now builds the params object conditionally — `list_group_senders` calls without `since_days` work as documented.
- `closeDb()` did not reset the cached `insertStmt` prepared statement, so re-opening the DB (e.g. in tests, or after a hypothetical reconnect) would silently fail every subsequent `indexMessage` call against a Statement still bound to the closed connection. `closeDb` now nulls `insertStmt` so `initDb` re-prepares it against the new connection.

## [1.16.0] — 2026-04-22

### Added

- Per-chat outbound throttle: a new `outboundDelayMs` field in `config.json` (default `200`, `0` disables) enforces a minimum delay between successive `sock.sendMessage` calls to the same `chat_id`. Anti-ban hygiene — bursts of messages to the same chat can trigger WhatsApp rate limits. Implemented as a wrap around `sock.sendMessage` at boot, so every tool that sends (reply, react, send_*, edit, delete, forward, ...) is automatically rate-limited without per-tool changes. The delay is read live from `config.json` on every call, so tuning takes effect without a server restart. Baileys' presence updates use a different API and are unaffected.
- Incoming call notifications: the plugin now surfaces every inbound WhatsApp call offer as a `notifications/claude/channel` notification with `kind: "call_offer"`, `call_id`, `call_from`, and `is_video` in meta. The agent can decide to react via the new `reject_call` tool, or simply ignore the notification and let the call ring out / be answered on another linked device. Other call lifecycle events (accept, timeout, etc.) are best-effort logged to `logs/system.log` but not surfaced as agent notifications.
- New MCP tool `reject_call` — rejects an incoming WhatsApp call via Baileys' `rejectCall(call_id, call_from)`. Designed to consume the `call_id` and `call_from` fields from the matching `call_offer` channel notification. No access gate — defensive action works regardless of the caller. Logged to `logs/system.log`.
- New MCP tool `forward_message` — forwards an existing message to another chat via Baileys' `sendMessage` with a `forward` payload. Reads the original WAMessage proto from the local SQLite store; the tool is indexed into `messages.db` as an outbound message with `meta.kind = "forward"` and the source message id for traceability. Works reliably for text messages; media forwards may have edge cases due to JSON round-tripping of the cached proto.
- WAMessage caching in `messages.db` — every inbound, outbound, and history-backfilled message now persists its raw Baileys WAMessage proto as JSON in a new `raw_message` column. Powers `forward_message` and unblocks future tools that need the full proto. Migration is idempotent (`ALTER TABLE messages ADD COLUMN raw_message TEXT` is run on initDb if the column is missing). Existing rows have `raw_message=NULL` and cannot be forwarded — only messages indexed from this version onwards.
- Internals: `indexMessage` switched from `INSERT OR REPLACE` to UPSERT semantics with `COALESCE(excluded.raw_message, raw_message)`, so re-indexing a row (e.g. on edit) preserves the cached proto instead of clearing it. New `getRawMessage(id)` helper in `db.ts` returns the parsed proto or null.

## [1.15.0] — 2026-04-21

### Added

- New MCP tool `get_chat_analytics` — aggregates per-chat stats from the local SQLite store: total messages, inbound vs outbound, per-sender top contributors, hourly distribution (UTC), daily distribution (Sun-Sat), first / last message timestamps. Renders the distributions as horizontal bar charts in plain text. Supports optional `since_days` lookback window. Pure SQLite, no WhatsApp roundtrip; access-gated on chat_id.
- New MCP tool `update_profile_name` — updates the bot's WhatsApp display name via Baileys' `updateProfileName`. Server-side change, propagates to all linked devices.
- New MCP tool `update_profile_status` — updates (or clears with empty string) the bot's WhatsApp profile status / About text via Baileys' `updateProfileStatus`.
- New MCP tool `update_profile_picture` — updates the bot's WhatsApp profile picture from a local JPEG / PNG image file via Baileys' `updateProfilePicture`. Uses `sock.user.id` as the self JID. WhatsApp auto-resizes large images server-side.
- New MCP tool `remove_profile_picture` — clears the bot's WhatsApp profile picture via Baileys' `removeProfilePicture` (falls back to WhatsApp's default avatar).
- New MCP tool `update_privacy` — updates one or more of the bot's WhatsApp privacy settings (`last_seen`, `online`, `profile_picture`, `status`, `read_receipts`, `groups_add`) in a single call. Each maps to the corresponding Baileys `update*Privacy` API. Settings apply sequentially; at least one must be provided.
- New MCP tool `send_voice_note` — sends a voice note (push-to-talk) to a WhatsApp chat. Accepts any audio file path and converts it to mono 16kHz OGG Opus via `ffmpeg` (required for WhatsApp's voice note format) before sending. Errors with a clear "install ffmpeg" hint when the binary is missing. Indexed into `messages.db` as an outbound message with `meta.kind = "voice"` and the source path for traceability.
- New MCP tool `send_presence` — manually sends a presence update (`composing` / `recording` / `paused` / `available` / `unavailable`) to a chat via Baileys' `sendPresenceUpdate`. Distinct from the auto-typing-on-inbound the plugin already does — this lets the agent set `recording` before sending a voice note, or manually clear a stuck typing indicator with `paused`.
- New MCP tool `send_location` — sends a static location (latitude / longitude, optional name and address) to a chat via Baileys' `sendMessage` with a location payload. Validates the lat/lng ranges. Indexed into `messages.db` as an outbound message with `meta.kind = "location"`.
- New MCP tool `send_contact` — sends a vCard 3.0 contact card to a chat via Baileys' `sendMessage`. Accepts structured fields (`name`, `phone`, optional `email`); the tool builds the vCard string and the WhatsApp-ID hint (`waid`) so tapping the card on the recipient's phone offers WhatsApp message / call as an option.
- New MCP tool `send_link_preview` — sends a text message with an explicit link-preview card (custom title + optional description and thumbnail) via Baileys' `sendMessage` with `linkPreview`. Useful when you want guaranteed preview metadata, regardless of whether WhatsApp can fetch the URL itself. Title is required (WhatsApp rejects previews without one).
- New MCP tool `pin_chat` — pins or unpins a WhatsApp chat to the top of the chat list via Baileys' `chatModify`. WhatsApp allows max 3 pinned chats; pinning a 4th may fail silently. Chat must be in the access allowlist. Logged to `logs/system.log`.
- New MCP tool `mute_chat` — mutes a WhatsApp chat for N seconds (or unmutes it with `mute_until_seconds: 0`) via Baileys' `chatModify`. Internally converts the relative seconds duration to the absolute future ms-epoch Baileys expects. Mute syncs to all linked devices including the user's phone. Logged to `logs/system.log`.
- New MCP tool `delete_chat` — removes a chat from the user's chat list via Baileys' `chatModify` with `delete: true`. Destructive on the chat-list side but recoverable: the chat reappears if a new message arrives. Requires at least one indexed message in `messages.db`. Access-gated. Logged to `logs/system.log`.
- New MCP tool `clear_chat` — clears all message history from a WhatsApp chat (the chat stays in the list) via Baileys' `chatModify` with `clear: true`. Destructive — messages disappear from the user's WhatsApp clients. The plugin's local SQLite store is unaffected. Requires at least one indexed message. Access-gated. Logged to `logs/system.log`.

## [1.14.0] — 2026-04-21

### Added

- New MCP tool `create_group` — creates a new WhatsApp group via Baileys' `groupCreate` with the bot as super admin. The new group is auto-registered into `access.groups` in open mode so the agent can interact with it immediately, no extra `/whatsapp:access group-add` step required. Accepts a `subject` (required) and an optional initial `participants` array (max 50; empty allowed for a bot-only group). Logged to `logs/system.log`.
- New MCP tool `join_group` — joins a WhatsApp group via an invite code or full `chat.whatsapp.com/<code>` URL, using Baileys' `groupAcceptInvite`. Parses URL form automatically. Same auto-registration into `access.groups` in open mode as `create_group`. Logged to `logs/system.log`.
- New MCP tool `get_invite_code` — returns the current 8-character invite code for a WhatsApp group via Baileys' `groupInviteCode`, plus the full `chat.whatsapp.com/<code>` URL. Bot must be admin. Group must be in `access.groups`.
- New MCP tool `revoke_invite_code` — revokes the current invite code and generates a new one for a WhatsApp group via Baileys' `groupRevokeInvite`. Returns the new code (no need to chain `get_invite_code` after). The old link stops working immediately. Bot must be admin. Group must be in `access.groups`. Logged to `logs/system.log`.
- New helper `autoRegisterGroup(jid)` in `server.ts` — adds a freshly created or joined group to `access.groups` in open mode (`requireMention: false, allowFrom: []`) so the agent can interact with it immediately. Best-effort; failures are logged but never propagated. Used by `create_group` and `join_group`.
- New MCP tool `leave_group` — bot leaves a WhatsApp group via Baileys' `groupLeave`. Destructive (re-entry needs an invite). Auto-removes the group from `access.groups` so the agent can't accidentally try to use the group afterwards. Group must be in `access.groups`. Logged to `logs/system.log`.
- New MCP tool `toggle_group_ephemeral` — sets or clears the disappearing-messages timer for a WhatsApp group via Baileys' `groupToggleEphemeral`. Accepts any non-negative number of seconds (`0` = disable). WhatsApp's standard presets are 86400 (24h), 604800 (7d), 2592000 (30d), 7776000 (90d). Group must be in `access.groups`; bot typically must be admin. Logged to `logs/system.log`.
- New MCP tool `handle_join_request` — manages pending join requests for a WhatsApp group with restricted-add settings. Single tool with three actions: `list` (enumerate pending), `approve`, `reject`. Approve/reject return per-participant status. Group must be in `access.groups`; bot must be admin. Approve/reject calls logged to `logs/system.log`.
- New MCP tool `promote_admins` — promotes one or more group members to admin via Baileys' `groupParticipantsUpdate` with action `promote`. Reuses the participants-array input + per-participant status output of `add_participants` / `remove_participants` (and the shared `formatParticipantStatus` decoder). Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New MCP tool `demote_admins` — demotes one or more admins back to regular members via Baileys' `groupParticipantsUpdate` with action `demote`. Same shape as `promote_admins`. WhatsApp blocks demoting the super admin (group creator); the per-participant status surfaces it. Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New MCP tool `add_participants` — adds one or more participants to a WhatsApp group via Baileys' `groupParticipantsUpdate` with action `add`. Accepts an array of user JIDs (max 50 per call); returns per-participant status (success / not-found / already-in / permission-denied) so the agent can surface partial failures with the raw WhatsApp status codes. Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New MCP tool `remove_participants` — removes one or more participants from a WhatsApp group via Baileys' `groupParticipantsUpdate` with action `remove`. Same input / output shape as `add_participants`; the meaning of WhatsApp status `409` flips to "not in group". Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New helper `formatParticipantStatus(status, action)` in `server.ts` — turns the raw WhatsApp HTTP-like status code returned per participant by `groupParticipantsUpdate` into a marker + human-readable label, with action-aware messaging (e.g. `409` is "already in group" for `add` and "not in group" for `remove`). Reused by every group participant mutation tool.
- New MCP tool `update_group_subject` — renames a WhatsApp group via Baileys' `groupUpdateSubject`. Group must be in `access.groups`; bot must be admin (Baileys propagates a clean error if not). Logged to `logs/system.log`.
- New MCP tool `update_group_description` — updates or clears a WhatsApp group description via Baileys' `groupUpdateDescription` (omit `description` or pass empty string to clear). Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New MCP tool `update_group_settings` — toggles group-level settings via Baileys' `groupSettingUpdate`. Surfaces WhatsApp's announcement / locked modes as two independent booleans (`admins_only_messages`, `admins_only_info`); pass either or both. Group must be in `access.groups`; bot must be admin. Logged to `logs/system.log`.
- New helper `assertAllowedGroup(jid)` in `server.ts` — stricter sibling of `assertAllowedChat` for group admin operations, validates both the `@g.us` suffix and presence in `access.groups` with a single shared error message. Used by every group admin tool from this batch onwards.
- New MCP tool `archive_chat` — archives or unarchives a WhatsApp chat via Baileys' `chatModify`. Boolean `archive` parameter (true to archive, false to unarchive). Access-gated. Reuses the local SQLite store to look up the chat's last message (Baileys requires it for the chatModify payload). Logged to `logs/system.log`. Useful for inbox hygiene.
- New MCP tool `mark_read` — marks one or more messages in a chat as read (sends blue checks to senders) via Baileys' `readMessages`. Inbound only (`fromMe: false` hardcoded). Access-gated on chat_id. Max 100 IDs per call. Useful after the agent has actioned a batch of inbound messages and wants to clear the unread state.
- New MCP tool `block_contact` — blocks a WhatsApp contact so they can no longer send messages, via Baileys' `updateBlockStatus` with action `block`. User JID only (no groups). No access gate — this is a defensive action that applies even to contacts outside the allowlist (spammers). Every call is logged to `logs/system.log` for auditability. Reversible via `unblock_contact`.
- New MCP tool `unblock_contact` — unblocks a previously-blocked WhatsApp contact via Baileys' `updateBlockStatus` with action `unblock`. User JID only. Logged to `logs/system.log`. Does NOT re-add the contact to the plugin's access allowlist — pair with `/whatsapp:access pair` or `allow` to fully restore a dropped contact.

## [1.13.0] — 2026-04-21

### Added

- New MCP tool `search_contact` — searches indexed contacts across all allowlisted chats by substring of push name or JID. Pure SQLite over `messages.db`, access-filtered. Returns matching senders grouped by JID with their latest push name, chat count, message count, and last-seen timestamp. Closes a common gap: users can now ask *"do I have any Juan?"* or *"who is +549155?"* without knowing the exact JID.
- New MCP tool `get_business_profile` — fetches WhatsApp Business profile fields (description, category, email, website, address, hours) for a user JID via Baileys' `getBusinessProfile`. Returns a clear "no business profile" response for personal accounts rather than erroring. No access gate (public-ish lookup). Chain with `check_number_exists` when only a phone is known.
- New MCP tool `get_group_metadata` — fetches full group metadata via Baileys' `groupMetadata` API (subject, description, creation info, settings, participants with admin flags). Access-checked: only works for groups in the `access.groups` allowlist. Complements `list_group_senders`: this tool lists ALL current participants (live from WhatsApp) with admin status, while `list_group_senders` lists only those who have spoken (from SQLite, with push names).
- New MCP tool `check_number_exists` — verifies whether one or more phone numbers are registered on WhatsApp via Baileys' `onWhatsApp` API. Batched up to 50 per call, with phone normalization (strips `+`, spaces, parentheses, hyphens; enforces 7–15 digits). Returns the canonical JID for active numbers (plus LID when available) and an explicit "not on WhatsApp" line per inactive one. Useful as pre-flight validation before pairing, sending, or answering "is X on WhatsApp?".
- New MCP tool `get_message_context` — returns N messages before + the anchor message + N messages after, all from the same chat, in chronological order. Pure SQLite query, access-checked on the anchor's chat. Lets the agent hand a `search_messages` hit (or any indexed message ID) into this tool to understand the surrounding thread before responding. Default window is 5 before and 5 after, clamped to 50 each.
- New MCP tool `list_chats` — lists recent WhatsApp chats (DMs + groups) with last message preview, timestamp, and message count. Filtered to the access allowlist so the agent never enumerates non-permitted chats. Backed by the existing `messages.db` SQLite store with no additional persistence. Enables discovery queries like *"what chats do I have"* / *"who's been messaging me"* without the user needing to know a specific JID, and lets the agent extract `chat_id`s before calling per-chat tools (`export_chat`, `fetch_history`, `list_group_senders`).
- Voice transcription provider switch: a new `audioProvider` field in `config.json` (`"local"` default, `"groq"`, or `"openai"`) lets users opt into a cloud transcription backend instead of the bundled local Whisper. Cloud providers use the OpenAI-compatible audio endpoint (`whisper-large-v3-turbo` for Groq, `whisper-1` for OpenAI) and read the API key from `GROQ_API_KEY` / `OPENAI_API_KEY` env vars (never stored in `config.json`). Local stays the default and recommendation — picking cloud trades privacy for higher transcription quality and lower latency on slower hardware. Switch via `/whatsapp:configure audio provider [local|groq|openai]`. If a cloud call fails (missing key, network error, rate limit, auth), the plugin lazy-loads local Whisper as a fallback so no transcription is ever lost; each fallback is recorded in `logs/system.log`. `transcriber-status.json` now also exposes a `provider` field so companion plugins can tell which backend is active.

### Fixed

- Privacy: replaced a real-looking example `@lid` JID in `README.md`, `skills/access/SKILL.md` and `docs/access.md` with a clearly-synthetic placeholder (`12345678901234@lid`, matching `lib.test.ts`). The previous value was authentic-format and should not have been committed.
- Hardening: the bot's own JID (LID or PN) can no longer land in `access.json.pending` under any Baileys edge case. `gate()` now short-circuits pairing for the bot's own identity using both `sock.user.id` (PN) and `sock.user.lid` (LID). A startup sanity-purge also strips any legacy owner entries from `pending` and `allowFrom` if found.
- Onboarding: `/whatsapp:configure`'s `connected` branch now uses MUST-level language so the ClawCode invite and voice-transcription tip reliably re-surface when their conditions hold.
- Onboarding: `/whatsapp:configure`'s QR vs pairing-code prompt now explicitly requires invoking `AskUserQuestion` — previously some sessions rendered the options as a numbered chat message instead.
- Onboarding: the "WhatsApp is ready to connect" channel notification is now debounced per link cycle instead of re-firing on every ~20s QR refresh, eliminating the "Waiting." loop.

## [1.12.0] — 2026-04-20

### Added

- Inbound debouncing: rapid plain-text messages from the same sender are now batched into a single agent turn instead of firing one notification per line. A 2-second sliding window (configurable via `inboundDebounceMs` in `config.json`; `0` disables) accumulates text while the user keeps typing, then flushes a single consolidated notification. Attachments, voice notes, reactions, and permission relays still flush immediately (flushing any pending text first, so ordering is preserved). Matches the OpenClaw `messages.inbound.debounceMs` behavior so agents written against either gateway see the same shape.

### Changed

- Onboarding: `/whatsapp:configure` now asks "QR code or pairing code?" on a fresh link cycle when `pairingPhone` isn't already set, so the headless option is discoverable without the user needing to already know the `pair <phone>` subcommand.
- Onboarding: on a `connected` status, `/whatsapp:configure` now re-surfaces the ClawCode companion invite (when ClawCode isn't installed) and the voice-transcription tip — same wording as the first-connect channel notification, which gets collapsed in the UI and was easy to miss.

## [1.11.0] — 2026-04-19

### Added

- Session-start banner: on each Claude Code session start, the plugin now shows a one-line install card with its version and repo link, then stays quiet for the rest of the session. Suppressed when ClawCode is installed on the same machine so the two plugins don't both greet on boot (same cache-directory probe as `isClawCodeInstalled()` in server.ts).

### Changed

- **Breaking (markdown log format):** daily conversation transcripts at `<channel-dir>/logs/conversations/YYYY-MM-DD.md` now use the WhatsApp chat-export format (`[DD-MM-YY, H:MM:SS a.m.] ~Sender: text`) instead of the previous bold/arrow format (`**← Sender** (HH:MM:SS): text`), so the files drop straight into any tool that already parses WhatsApp exports. Inbound senders are prefixed with `~` per the export convention; outbound stays plain. Times are now host-local (the old format accidentally slotted UTC into a field documented as local — this is a fix). The sibling `.jsonl` is unchanged and remains the authoritative structured record, so any tooling reading JSONL is unaffected.

## [1.10.0] — 2026-04-19

### Changes

- Onboarding/companion: when WhatsApp links successfully for the first time in a session, the channel notification now also suggests pairing with the [ClawCode](https://github.com/crisandrews/ClawCode) companion plugin (memory across sessions, scheduled tasks, voice replies, persona) — but only when ClawCode isn't already installed locally, so users who set up via ClawCode → claude-whatsapp don't see the companion offered back to them in a loop.

### Security

- Policies: added `PRIVACY.md` and `SECURITY.md` so users (and Anthropic marketplace reviewers) can see exactly what data the plugin handles, where it lives locally, and how to report a vulnerability — material for marketplace eligibility, not just docs.

## v1.9.0

### Changes

- Group discovery: unknown groups that drop a message are now persisted to `recent-groups.json` and listed inline by `/whatsapp:access` with a copy-paste `add-group` command and the most recent sender's push name, so finding a group's JID stops requiring tailing the system log.
- Group whitelist: new `/whatsapp:access group-allow <group-jid> <member-jid>` and `group-revoke <group-jid> <member-jid>` commands restrict a group to specific people in it (or open it back up), so a busy group can route only one or two members' messages to Claude without writing JSON by hand.
- Member discovery: new `list_group_senders` tool reports the participants who have spoken in a chat — push names, JIDs, message counts, last seen — drawn from the local message store, so picking which member to whitelist becomes a question the user asks Claude in plain English.
- Group access docs: README rewritten around a four-policy matrix (open / mention-only / restricted-mention-only / restricted-open) and states up front that group access is independent of DM access — allowing someone in a group does NOT let them DM the bot, and pairing for DM does NOT auto-allow them in any group.

## v1.8.1

### Changes

- Group discovery: when a message arrives from a group that isn't in the allowlist, the system log now records the group JID once per minute with a copy-pasteable `/whatsapp:access add-group <jid>` command, so finding a new group's JID stops requiring you to grep raw traffic.

## v1.8.0

### Changes

- Delete/messages: new `delete_message` tool revokes a message the bot sent, so Claude can take back a wrong reply instead of patching it with a follow-up correction.
- Polls/groups: new `send_poll` tool delivers a tappable poll with 2-12 options (single-choice or multi-select), so quick group decisions stop needing free-text answers and manual tallying.

## v1.7.0

### Changes

- Search/messages: `search_messages` tool runs full-text search over every message the plugin has seen, optionally scoped to one chat, so Claude can answer "find where Juan sent the address" without re-reading the whole conversation.
- History/backfill: `fetch_history` tool asks WhatsApp to ship older messages for a chat using the oldest known message as the anchor, so questions about yesterday's conversation stop requiring you to paste context.
- Export/chat: `export_chat` tool dumps a chat to `markdown` (default), `jsonl`, or `csv` under the inbox directory, so transcripts can be handed off, summarized, or archived.
- Local store: every inbound and outbound message — including reactions, edits, file captions, and backfilled history — is now indexed locally to `<channel-dir>/messages.db`, so search, history, and export results stay available across restarts.
- Local store: indexed outbound rows carry a `Claude` author label, so exports and search snippets disambiguate who said what.

### Security

- Local store: `messages.db` is created with `0600` perms, so the on-disk message archive stays readable only by your user.

## v1.6.0

### Security

- Auth/perms: the auth directory and credential files are re-tightened to `0700` / `0600` on every server start and after every credential save, so installations that started under a permissive umask converge to user-only access without manual chmod.
- State files: status, config, and PID files are now written with `0600`, so on-disk state stops being world-readable on shared machines.

### Changes

- Group gating/LID: the bot now resolves `@lid` mentions back to its phone identity using the LID-to-phone hint Baileys carries on every group message, so a `requireMention` group no longer silently drops legitimate mentions when the chat is addressed in LID mode.
- Auth/import: `/whatsapp:configure import <source-dir>` migrates an existing WhatsApp session from another local app (OpenClaw, wppconnect, a previous checkout) into the plugin's auth directory, so switching tools no longer forces you to scan a new QR or re-pair the device. The previous session is backed up automatically.
- Permission relay/preview: tool prompts on WhatsApp now highlight the most relevant field instead of dumping raw JSON — Bash shows the command, Edit / Write / MultiEdit show the file with 📄, Read shows the path with 👁, WebFetch surfaces the URL with 🌐, WebSearch the query with 🔍 — so approvals on a phone are scannable in one glance.

## v1.5.0

### Changes

- Pairing/linking: `/whatsapp:configure pair <phone>` generates an 8-character pairing code instead of a QR on the next link cycle, so headless servers and SSH-only sessions can connect a number without a camera or a screen. Disable with `/whatsapp:configure pair off`.
- Edit/messages: new `edit_message` tool lets Claude correct a previously sent message in place. WhatsApp shows an "edited" tag and skips the push notification, so typo fixes stop spamming the chat.
- Replies/chunking: `chunkMode: newline` splits long replies at the nearest paragraph, line, or space break instead of cutting at 4096 characters, so multi-message answers read naturally instead of breaking mid-word.
- Replies/quote-reply: `replyToMode` (`off` / `first` / `all`) controls which chunks of a long reply quote the user's original message, so threaded conversations stay anchored without every chunk repeating the quote.
- Replies/ack: `ackReaction` posts a configured emoji as soon as a message arrives from an allowlisted contact, so the user sees an instant receipt instead of silence while Claude composes the reply.
- Replies/auto-document: long replies above a configurable threshold are sent as a single `.md` or `.txt` attachment instead of many chunked messages, so reviewing a 10-page analysis in WhatsApp becomes opening a file instead of scrolling forever.

## v1.4.0

### Fixes

- Group gating/mention: `requireMention: true` on a group now actually filters messages — the setting was advertised in `/whatsapp:access` but never enforced, so the bot was responding to every message in mention-restricted groups. With this fix it only delivers messages that @-mention the bot or quote one of its prior messages, with a fail-closed fallback if the bot identity hasn't been captured yet.
- Connection/lock: the single-instance lock now uses an atomic create and surfaces filesystem errors instead of swallowing them, so a disk-full or permission failure can no longer silently drop you back to the duplicate-connection loop. Corrupt or empty lock files and stale PIDs are reclaimed automatically.

### Changes

- Permission relay: WhatsApp reactions and `yes <id>` / `no <id>` text on a permission prompt now actually approve or deny the pending tool, instead of being a hint that Claude may or may not follow. Approvals are restricted to the DM target so a stray `yes ABCDE` in a group can't trigger a tool. The terminal approval dialog stays active throughout — the WhatsApp channel is additive, never blocking. Pending requests expire after 5 minutes.

## v1.3.9

### Fixes

- Orphaned plugin processes no longer linger after Claude Code exits. `bootstrap.mjs` and `server.ts` now run a PPID watchdog: when the parent dies and the kernel reparents us (to launchd/init), we shut down within ~5s. Closes the source of the long-running orphans that fought new sessions for the WhatsApp auth.
- Two simultaneous Claude Code sessions in the same workspace no longer trigger a status-440 (`connectionReplaced`) reconnect loop. The server now writes a PID lock to `<channel-dir>/server.pid` before opening Baileys; the second instance detects the live owner, stays idle, and emits a single channel notification explaining the situation. Stale locks (owner already dead) are reclaimed automatically.
- Reconnects use exponential backoff with jitter (2s → 4s → 8s … capped at 5 min, ±30% randomization) instead of a fixed 5s delay. Network blips and edge-case collisions resolve in seconds instead of looping at a constant cadence; counter resets after a connection holds for ≥30s.
- The `WhatsApp connected successfully!` channel notification now fires only on the first successful connection of the server's lifetime, not on every reconnect. Stops the agent from receiving (and replying to) hundreds of phantom system messages during transient disconnects. `syslog` still records every open for diagnostics.

## v1.3.8

### Changes

- Interactive multi-choice prompts via `AskUserQuestion` when args are missing:
  - `/whatsapp:configure audio` → pick language (Spanish / English / Portuguese / Auto-detect, "Other" for any ISO code).
  - `/whatsapp:configure audio model` → pick Whisper size (Base / Tiny / Small).
  - `/whatsapp:configure audio quality` → pick level (Balanced / Fast / Best).
  - `/whatsapp:access policy` → pick DM policy (Allowlist / Pairing / Disabled), with recommendation reordered based on current `allowFrom` state.
- Pairing (`/whatsapp:access pair <code>`) and JID operations (`allow` / `revoke` / `add-group` / `remove-group`) still require explicit arguments — never prompted via multi-choice, to avoid prompt-injected approval flows.
- One-shot invocations with args (e.g. `/whatsapp:configure audio es small best`) still execute directly without prompting.

## v1.3.7

### Fixes

- `/whatsapp:access pair <code>` sometimes claimed a valid pending code wasn't in the list when a second pairing arrived after the initial status notification: the skill model relied on cached context from earlier messages instead of re-reading `access.json`. Skill now requires a fresh Read on every invocation, ignoring any prior-context view of pending/allowlist/policy.

## v1.3.6

### Fixes

- State written to wrong project when the plugin is installed in more than one local project: `detectProjectDir()` returned the first `scope: local` entry in `installed_plugins.json` without checking the launch cwd, so QR/auth/inbox collided under a single `.whatsapp/`. Now matches the entry whose `projectPath` equals the cwd Claude Code launched from (forwarded by `bootstrap.mjs`), falling back to the first local entry to preserve behavior for single-install users.

## v1.3.0

### Changes

- Audio deps bundled: `@huggingface/transformers` and `ogg-opus-decoder` now included in main dependencies. No separate install step needed.
- Simplified audio setup: `/whatsapp:configure audio es` only writes config — no npm install or model pre-download step.
- Whisper model downloads on first voice message and is cached permanently.

### Fixes

- Audio transcription not activating after update: caused by Node.js caching failed dynamic imports. Now deps are always available since they're bundled.

## v1.2.1

### Fixes

- Auto-wait on `reconnecting` status instead of asking user to re-run `/whatsapp:configure`.
- Clarified update flow: wait for Claude to respond after `/reload-plugins`, may need a second reload.
- Documented that audio transcription may need re-enabling after plugin update.

## v1.2.0

### Changes

- Conversation logging: dual-format logs per day — JSONL (for RAG/memory) and Markdown (for humans) in `.whatsapp/logs/conversations/`.
- System logging: server events (connections, errors, pairing) in `.whatsapp/logs/system.log`.
- Configurable Whisper model: choose between `tiny` (~39MB), `base` (~77MB, default), or `small` (~250MB) via `/whatsapp:configure audio model <size>`.
- Configurable transcription quality: `fast`, `balanced` (default), or `best` (full precision + beam search) via `/whatsapp:configure audio quality <level>`.
- Chunked transcription: Whisper now processes audio with 30s chunks and 5s stride overlap for complete transcription of longer messages.

### Fixes

- Audio downloads returning 0 bytes: switched from `'buffer'` to `'stream'` mode for `downloadMediaMessage` (Baileys v7 bug).
- Truncated transcriptions: concatenate all Whisper result chunks instead of taking only the first. Reset decoder between calls.
- Missing watchers on first launch: `watchApproved()` and `watchConfig()` were not called in the dep-polling branch, so config changes were never detected.
- Duplicate pairing for same user: Baileys v7 can identify one user with two JID formats (`@lid` and `@s.whatsapp.net`). Gate now checks both, pairing deduplicates across formats, and access skill adds both IDs on approval.
- Silent error swallowing: all media download and transcription catch blocks now log errors to system.log.

## v1.1.0

### Changes

- Voice transcription: optional local speech-to-text via Whisper (cross-platform, no API keys, 99 languages). Enable with `/whatsapp:configure audio` or `/whatsapp:configure audio <lang>`.
- Hot-reload audio config: server detects config changes every 5s — no restart needed.
- Per-project agent isolation: state stored in `.whatsapp/` per project folder. Each folder is an independent agent.
- Reaction commands: 👍 = proceed, 👎 = cancel.
- WhatsApp-native formatting: enforced in MCP instructions (no markdown headers/tables/links).

### Fixes

- First-launch reliability: deps installed from skill foreground instead of MCP background (was timing out).
- Startup speed: skip `npm install` if deps already exist.
- Audio language detection: pass explicit language to Whisper (was defaulting to English).
- Configure skill timeout: foreground install replaces blind 120s wait.

### Security

- Path traversal: sanitize filenames (`safeName`) and MIME extensions (`safeExt`).
- File exfiltration: `assertSendable()` blocks sending auth/access files via reply tool.
- Attachment path: `download_attachment` restricted to inbox directory only.
- Access control: fix substring match → exact match in `assertAllowedChat`.
- File permissions: `access.json` written with 0600, directories with 0700.
- 50 MB attachment size limit.
- Block pairing codes in group chats.
- Validate approved directory entries before sending.
- Corrupt `access.json` recovery: move aside and log.
- Global `unhandledRejection`/`uncaughtException` handlers.
- Prompt injection defense in access skill.

## v1.0.0

Initial release.

- WhatsApp Web connection via QR code scan (Baileys).
- Inbound/outbound messaging with MCP channel protocol.
- Access control: pairing flow, allowlist, disabled modes.
- Media support: photos, documents, audio, video.
- Tools: reply (auto-chunk at 4096 chars), react, download_attachment.
- Session persistence in multi-file auth state.
