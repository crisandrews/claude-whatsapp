# Changelog

## v1.7.0

### Changes

- Local message store backed by SQLite (`better-sqlite3`) with FTS5 full-text indexing. Every inbound and outbound message the plugin sees is indexed automatically into `<channel-dir>/messages.db`; reactions, edits, file captions, and history-backfilled messages are all included. Three new MCP tools sit on top:
  - `search_messages({query, chat_id?, limit?})` — FTS5 query with snippet, optionally scoped to a chat.
  - `fetch_history({chat_id, count?})` — calls `sock.fetchMessageHistory` with the oldest known message in the chat as the anchor; backfilled messages arrive asynchronously via `messaging-history.set` and are indexed automatically.
  - `export_chat({chat_id, format, since_ts?, until_ts?, limit?})` — writes a chronological export of the indexed rows to a file in the inbox dir. Formats: `markdown` (default), `jsonl`, `csv`.
- DB file is created with `0600` perms; WAL journaling for concurrent reads while the channel keeps writing.
- `messaging-history.set` handler indexes historical messages without running them through the gate (they're historical) or downloading their media (text/caption only).
- Each indexed outbound row carries direction `out`, sender JID, and a `Claude` push name so exports render with two clear voices and FTS results disambiguate who said what.

## v1.6.0

### Security

- `auth/` directory and credential files re-tightened to `0700`/`0600` on every server start, not just when the directory is first created. Previous installations whose umask left `0755` on `auth/` are corrected on the next boot. Baileys' `creds.update` events now run a chmod sweep on the auth files after each save, so newly written keys can't drift back to looser perms.
- Status, config, and PID files now persisted with explicit `mode: 0o600`.

### Changes

- LID↔phone resolution cache for cross-namespace mention gating. Baileys 7 addresses many group messages in `@lid` mode and carries the phone equivalent in `key.remoteJidAlt` / `key.participantAlt`; we record those mappings (bounded LRU, 1000 entries) so a later mention written in `@lid` form against a bot whose captured identity is `@s.whatsapp.net` still resolves correctly. Resolves false negatives in mention-required groups when the same physical user appears in both namespaces.
- `/whatsapp:configure import <source-dir>` skill command. Migrates an existing Baileys multi-file auth state from another local install (OpenClaw, wppconnect, prior checkout) into this plugin's auth dir. Backs up the previous session, copies the new files, re-tightens perms. User runs `/reload-plugins` to reconnect with imported credentials. No re-pairing required.
- Permission relay prompts now extract a tool-specific highlight from the request's `input_preview`. Bash shows the command in a code block; Edit/Write/MultiEdit highlight the file path with 📄; Read shows just the path; WebFetch surfaces the URL with 🌐; WebSearch the query with 🔍. Truncated JSON inputs fall back to a regex over the prefix, so the highlight survives even when CC's 200-char preview cut mid-value.

## v1.5.0

### Changes

- Pairing-code linking for headless setup. `/whatsapp:configure pair <phone>` writes the number into config and the next QR cycle generates an 8-character pairing code (`sock.requestPairingCode`) instead of a scannable QR. Code is stored in `status.json` so the skill can show it; refreshes alongside the QR rotation. Disable with `/whatsapp:configure pair off`. Verified against `@whiskeysockets/baileys` source — only fires when `sock.authState.creds.registered` is false.
- `edit_message` tool. Lets Claude correct a previously-sent message in place. WhatsApp shows an "edited" tag and skips push notifications, so corrections don't spam the chat. Constructed from `chat_id` + `message_id` + `fromMe: true` — WhatsApp rejects edits server-side for messages that weren't ours, so no sent-history cache is needed.
- `chunkMode: newline` for long replies. The `length` mode (default, current behavior) hard-cuts at 4096 characters; `newline` looks back from the limit for the nearest paragraph (`\n\n`), then line, then space break, falling back to a hard cut only when nothing usable lies past the half-way point. Configurable via `/whatsapp:configure chunk-mode newline`.
- `replyToMode` for chunked replies — `off` / `first` (default) / `all`. Controls which chunks include a quote-reply pointer to the original inbound message. Set with `/whatsapp:configure reply-to <mode>`.
- `ackReaction` (optional emoji acknowledgement). When set, the bot reacts to inbound messages from allowlisted contacts immediately on receipt, before Claude composes a reply. Closes the silence gap between "user sends" and "agent responds". Set with `/whatsapp:configure ack 👀`; clear with `/whatsapp:configure ack off`.
- Auto-document for long replies. When Claude's reply exceeds `documentThreshold` characters (default 0 = disabled; user-configurable), the plugin sends it as a single `.md`/`.txt` attachment instead of N chunked text messages. Filename and MIME chosen heuristically from content (`auto`) or forced via `documentFormat`. Set with `/whatsapp:configure document threshold 4000` and `/whatsapp:configure document format md`.

## v1.4.0

### Fixes

- Group `requireMention` is now actually enforced. The setting was declared on every group entry (`requireMention: true` by default) and documented in the `/whatsapp:access` skill, but the gate function never read it — every message in a configured group was delivered to Claude regardless of mentions. The bot's own JID is captured on connect, mentions and reply-to-quote authors are extracted from each inbound message, and groups marked `requireMention: true` now drop messages that neither @-mention the bot nor reply to one of its messages. If a message arrives before the bot identity is captured (a race between `connection.update` 'open' and the first `messages.upsert`), the gate fails closed.
- `acquireLock()` no longer succeeds silently on filesystem errors. Replaced the non-atomic `existsSync` + `readFileSync` + `writeFileSync` sequence with a single `openSync(LOCK_FILE, 'wx')` (atomic create-or-fail via POSIX `O_EXCL` on macOS/Linux). EACCES, ENOSPC and similar errors now surface as a distinct `lock_error` status with a clear channel notification, instead of being swallowed and risking a duplicate connection. Corrupt or empty PID files are detected and reclaimed; stale-PID and self-PID cases each get a single bounded retry with `unlinkSync` race tolerance. Windows filesystems without true `O_EXCL` semantics may still allow concurrent acquisition.

### Changes

- WhatsApp reactions on permission requests are now treated as enforced approvals. When Claude Code sends a `notifications/claude/channel/permission_request`, the plugin broadcasts a `🔐 Claude wants to run *<tool>*` prompt to every allowlisted DM contact carrying the request's `request_id` (5 lowercase letters, no `l`). The DM target can react with 👍/✅ to allow or 👎/❌ to deny, or reply with `yes <id>` / `no <id>` (case-insensitive — mobile autocaps work). Either path emits `notifications/claude/channel/permission` with `{request_id, behavior}` back to Claude Code and clears the pending entry. Pending requests time out after 5 minutes. The terminal-side approval dialog stays active throughout — this WhatsApp channel is additive, never blocks the local prompt. Permission text/reaction handling is restricted to DM only, so a `yes <id>` typed in an allowlisted group never accidentally consumes a pending approval. Reactions on non-permission messages still flow through to Claude as `[Reacted with X]` and are interpreted contextually.
- Pure helpers (`splitJid`, `matchesBot`, `parsePermissionReply`, `acquireLock`) extracted to `lib.ts` with a `node:test` suite (`npm test` → 28 tests) covering JID parsing, permission reply parsing, and lock acquisition under contention/staleness/corruption/filesystem-error.

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
