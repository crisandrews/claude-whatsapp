# Changelog

## [Unreleased]

### Changes

- Onboarding/companion: when WhatsApp links successfully for the first time in a session, the channel notification now also suggests pairing with the [ClawCode](https://github.com/crisandrews/ClawCode) companion plugin (memory across sessions, scheduled tasks, voice replies, persona) — but only when ClawCode isn't already installed locally, so users who set up via ClawCode → claude-whatsapp don't see the companion offered back to them in a loop.

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
