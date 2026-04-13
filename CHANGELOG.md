# Changelog

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
