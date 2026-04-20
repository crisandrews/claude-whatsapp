# Troubleshooting

Symptom → cause → fix. Each entry tells you where to look and which doc has the pedagogical walkthrough.

- [Connection issues](#connection-issues)
- [Linking and pairing](#linking-and-pairing)
- [Messages not flowing](#messages-not-flowing)
- [Permission relay](#permission-relay)
- [Voice transcription](#voice-transcription)
- [Updates and cache](#updates-and-cache)
- [History and search](#history-and-search)
- [Where to look](#where-to-look)

---

## Connection issues

### `status: "deps_missing"` doesn't transition

**What it means.** First launch (or first launch after an update that bumped dependencies). The plugin is installing native modules (Baileys, `better-sqlite3`, optionally the Whisper transcriber) in the background. Takes ~60–90 seconds the first time, faster after.

**Fix.** Wait. Don't restart Claude Code — that aborts the install. Once `/whatsapp:configure` shows `qr_ready` or `connected`, run `/reload-plugins` and you're set. See [docs/operations.md#updating](operations.md#updating).

If it's been more than a few minutes and the status still reads `deps_missing`, something's actually wrong — check `<channel-dir>/logs/system.log` for install errors (network, permissions).

### `status: "idle_other_instance"`

**What it means.** Another running plugin instance owns the single-instance lock at `<channel-dir>/server.pid`. The MCP server is up for tool calls but the WhatsApp side is skipped.

**Fix.** Close extra Claude Code sessions in the same workspace. If you're sure only one is running, the PID file may point at a zombie process — see [docs/operations.md#multi-instance-and-the-single-instance-lock](operations.md#multi-instance-and-the-single-instance-lock) for the full diagnostic.

### `status: "lock_error"`

**What it means.** The plugin couldn't create or read `<channel-dir>/server.pid` due to a filesystem error.

**Fix.** Check:

```sh
ls -la <channel-dir>
df -h <channel-dir>
```

Ensure your user owns the directory and has write perms; check for disk-space exhaustion. The `status.json` entry has the exact error string.

### `status: "reconnecting"` stays stuck

**What it means.** The plugin reconnects with exponential backoff + jitter — you'll see `reconnecting` during the wait, `connected` after a success. A brief stint in `reconnecting` is normal (network blip, WhatsApp-side rotation). If it's stuck for minutes, `status.json`'s `attempt` and `nextDelayMs` fields tell you how far into the backoff curve you are.

**Fix.** Check `<channel-dir>/logs/system.log` for the `connection closed (status ...)` lines. If the status code is `401` or `403`, the session may have been invalidated on WhatsApp's side — run `/whatsapp:configure reset` and relink. For `408` / `428` (timeouts), wait — often resolves on its own.

### Reconnect loop at fixed cadence

**What it means.** The plugin retries with exponential backoff — if you see retries at a steady cadence (especially ~5 s intervals), that's almost always two instances fighting over the same WhatsApp session.

**Fix.** See [docs/operations.md#reconnection-behavior](operations.md#reconnection-behavior). Close the other instance.

---

## Linking and pairing

### `status: "qr_error"`

**What it means.** QR PNG rendering failed — usually a filesystem error.

**Fix.** Run `/whatsapp:configure reset` to clear `auth/`, `status.json`, and `qr.png`, then `/whatsapp:configure` again. If it persists, check disk space and permissions on `<channel-dir>/qr.png`.

### `qr_ready` shows a code, not a QR

**What it means.** `pairingPhone` is set in `config.json`. The plugin is generating an 8-character pairing code alongside the QR, intended for headless servers.

**Fix.** On your phone, open WhatsApp → **Linked Devices → Link with phone number** and enter the code. Or, if you meant to use the QR: `/whatsapp:configure pair off` to disable pairing-code mode, then `/whatsapp:configure`. See [docs/configuration.md#linking](configuration.md#linking).

### Pairing code expired

**What it means.** QR / pairing codes rotate every ~20 seconds.

**Fix.** Run `/whatsapp:configure` again — it generates a fresh one.

### `status: "logged_out"`

**What it means.** WhatsApp logged you out from the device list on your phone.

**Fix.** Run `/whatsapp:configure reset`, then `/whatsapp:configure` to link again. Your `access.json`, `config.json`, and `messages.db` are preserved — only `auth/` is cleared.

### The bot stopped offering pairing codes to new contacts

**What it means.** You hit the 3-pending cap on `access.pending`.

**Fix.** Resolve one of the existing pendings (pair / deny) or wait 1 hour for expiry. See [docs/access.md#pairing-flow-the-default](access.md#pairing-flow-the-default).

---

## Messages not flowing

### Messages from a DM contact drop even though they're paired

**What it means.** Most likely `dmPolicy: "disabled"` is set (hard kill-switch), or the contact was revoked after pairing.

**Fix.** Check:

```sh
cat <channel-dir>/access.json
```

Confirm the JID is in `allowFrom` and `dmPolicy` is `pairing` or `allowlist`. See [docs/access.md](access.md).

### First message from a group member drops, then subsequent ones work

**What it means.** Normal. The LID↔phone resolution cache populates from per-message hints; until the first message carrying an `Alt` field is seen for a member, mention-gating can't resolve their JID and the message is dropped (fail-closed). Once the cache fills (after the first or second message), mention detection works normally for that member.

**Fix.** No action needed. If it persists for a specific member, see [docs/groups.md#edge-cases--gotchas](groups.md#edge-cases--gotchas).

### A group's messages never arrive even though it's on the allowlist

**What it means.** Either `requireMention: true` is set and no mention is in the message, or `allowFrom` is non-empty and the sender isn't in it.

**Fix.** Check `access.json` under `groups[<jid>]`. See [docs/groups.md#the-four-policies](groups.md#the-four-policies).

### Bot sent a reply but the recipient never received it

**What it means.** Rare, but possible if:

- `chat_id` was stale (older than the current session) and WhatsApp rejected it silently.
- The recipient blocked the bot's number on their side (Baileys can't report this back).
- `reply` was called with a group JID that isn't in `access.groups` — `assertAllowedChat` throws and the tool returns an error.

**Fix.** Check `<channel-dir>/logs/conversations/<today>.md` for the outbound line. If it's there, the send went through from our side; the issue is downstream. If it's absent, look at `logs/system.log` for the tool error.

---

## Permission relay

### Permission prompt never arrives on WhatsApp

**What it means.** Any of:

- **Claude Code feature flag.** The permission relay is gated by `tengu_harbor_permissions`. If your Claude Code version doesn't have that flag enabled for your account, no `permission_request` notification fires. The terminal dialog still works as usual.
- **Empty DM allowlist.** No targets to broadcast to. Pair at least one contact first.
- **Capabilities not negotiated.** Should be impossible (we declare both `experimental['claude/channel']` and `experimental['claude/channel/permission']`), but worth double-checking in `logs/system.log` if anything looks off after a Claude Code update.

**Fix.** See [docs/permission-relay.md#failure-modes](permission-relay.md#failure-modes).

### Text reply to permission prompt doesn't approve

**What it means.** The parser is strict: format is `(y|yes|n|no) <id>` with one space. Extra text, or the ID before the y/n, fails the match.

**Fix.** Retype exactly: `yes abcde` or `no abcde`. The ID is 5 letters; case is normalized so autocapitalized `YES ABCDE` works.

### Reaction doesn't approve

**What it means.** Either the reaction wasn't on the original `🔐 Claude wants to run …` message, or the emoji isn't in the supported set.

**Fix.** Supported: 👍 / ✅ / skin-tone 👍 variants for approve; 👎 / ❌ / skin-tone 👎 variants for deny. React on the original prompt, not on a later message.

---

## Voice transcription

### Voice messages arrive as `[Voice message received]` instead of transcript

**What it means.** Transcription is disabled. Or enabled but initialization failed.

**Fix.** First check `config.json`:

```sh
cat <channel-dir>/config.json | grep audioTranscription
```

If `false`, enable: `/whatsapp:configure audio <lang>` (e.g. `audio es`). If `true` but it's still not working, check `transcriber-status.json`:

```sh
cat <channel-dir>/transcriber-status.json
```

- `"status": "loading"` — first-message model download in progress. Wait ~30 seconds.
- `"status": "error"` — native deps missing, or model couldn't load. The `error` field has the message; check `logs/system.log` for the full stack.
- `"status": "ready"` — should be transcribing. If it isn't, the message may have exceeded the 50 MB inbound cap, or the audio decode failed. See `logs/system.log`.

### Transcription in wrong language

**What it means.** Without an explicit language, Whisper auto-detects per message. Short voice notes often auto-detect to English even when the speaker is in another language.

**Fix.** Set the language explicitly: `/whatsapp:configure audio es` (or your ISO code). See [docs/configuration.md#voice-transcription](configuration.md#voice-transcription) and [docs/media-voice.md#voice-transcription-end-to-end](media-voice.md#voice-transcription-end-to-end).

### Transcription is slow

**What it means.** Whisper runs on CPU. The `base` model on a mid-range laptop can take 15-30 seconds for a 2-minute voice note.

**Fix.** Trade accuracy for speed:

```
/whatsapp:configure audio model tiny
/whatsapp:configure audio quality fast
```

---

## Updates and cache

### Reinstall fails or plugin behaves unexpectedly

**What it means.** Corrupted or stale plugin cache.

**Fix.** See [docs/operations.md#clearing-cache](operations.md#clearing-cache). Close Claude Code, `rm -rf ~/.claude/plugins/cache/claude-whatsapp`, reopen.

### After `/plugin update`, the agent stops responding

**What it means.** The plugin is reinstalling its dependencies. Can take a few minutes the first time after a release.

**Fix.** Wait. Run `/whatsapp:configure` to see live status — it'll report `deps_missing` during the install and transition automatically. Once out of `deps_missing`, `/reload-plugins` brings everything back without a full Claude Code restart. See [docs/operations.md#updating](operations.md#updating).

### My session was lost after an update

**Shouldn't happen.** `auth/`, `access.json`, `config.json`, and `messages.db` are all preserved across updates. If one of them disappeared:

- Check `<channel-dir>` still exists (local-scope installs rely on being launched from the same project dir).
- Check for `.backup-*` dirs if you ever ran `/whatsapp:configure import`.

If the `auth/` directory was wiped and you haven't touched `/whatsapp:configure reset`, that's a bug — please file an issue with your `logs/system.log`.

---

## History and search

### `fetch_history` returns anchor-missing error

**What it means.** The local store has no indexed messages for that chat yet, so there's no timestamp to anchor the backfill request against.

**Fix.** Send or receive any one message in that chat first, then retry. See [docs/search-export.md#anchor-selection](search-export.md#anchor-selection).

### Search returns empty, but I know the message is there

**What it means.** Either the message was never indexed (happened before the plugin was running, or was dropped by the gate), or the FTS5 query syntax is being interpreted differently than you expect.

**Fix.** Try a simpler query: `"exact phrase"` instead of a multi-word AND, or `word*` for prefix. See [docs/search-export.md#fts5-query-matrix](search-export.md#fts5-query-matrix). If the message predates the plugin, `fetch_history` can sometimes pull it back.

### `messages.db` is locked or corrupt

**What it means.** Usually a hard shutdown leaving the WAL journal in an odd state.

**Fix.** The database should heal on next open. If it doesn't, safe to delete:

```sh
rm <channel-dir>/messages.db*
```

You lose indexed history only — no auth, no config, no access control impact. The DB is recreated empty on next launch.

---

## Where to look

When none of the above matches, go straight to the logs:

- **`<channel-dir>/logs/system.log`** — server events, errors, reconnect attempts, lock state, permission-request broadcasts. Grep for the timestamp of when the problem happened. Format documented in [docs/operations.md#logs](operations.md#logs).
- **`<channel-dir>/logs/conversations/YYYY-MM-DD.jsonl`** — every delivered inbound and outbound reply, with timestamps and JIDs.
- **`<channel-dir>/status.json`** — current connection state. See [docs/state-contract.md#statusjson](state-contract.md#statusjson) for the full enum.
- **`<channel-dir>/transcriber-status.json`** — last transcription pipeline state (not current enablement — that's `config.json`).

Still stuck? Open an issue at [github.com/crisandrews/claude-whatsapp/issues](https://github.com/crisandrews/claude-whatsapp/issues) with:

- The last ~50 lines of `logs/system.log`.
- Your `status.json` contents.
- The Claude Code command you launch with.
- macOS / Linux / Windows and Node version (`node --version`).

Do **not** paste `auth/` contents — they're session secrets.
