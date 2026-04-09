# Changelog

## v1.1.0

### Changes

- Voice transcription: optional local speech-to-text via Whisper (cross-platform, no API keys, 99 languages). Enable with `/whatsapp:configure audio` or `/whatsapp:configure audio <lang>`.
- Hot-reload audio config: server detects config changes every 5s — no restart needed.
- Per-project agent isolation: state stored in `.whatsapp/` per project folder. Each folder is an independent agent.
- Reaction commands: 👍 = proceed, 👎 = cancel.
- Autonomous mode docs: recommended launch with `--dangerously-skip-permissions --chrome`.
- OpenClaw coexistence: documented switching between OpenClaw and this plugin on the same number.
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
