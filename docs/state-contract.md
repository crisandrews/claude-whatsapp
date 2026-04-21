# State contract for companions

Public integration surface for companion plugins, automation scripts, or anything else that wants to detect, observe, or cooperate with `claude-whatsapp`. The paths, field names, and MCP capabilities documented here are **stable** — they'll only change with a major version bump.

- [Channel directory resolution](#channel-directory-resolution)
- [Public files](#public-files)
- [Private files](#private-files)
- [MCP capabilities](#mcp-capabilities)
- [Detection patterns](#detection-patterns)
- [Worked example: ClawCode integration](#worked-example-clawcode-integration)
- [Stability policy](#stability-policy)

---

## Channel directory resolution

Every stateful file the plugin writes lives under a single directory, resolved in this order:

1. **`<project>/.whatsapp/`** — if the plugin is installed in local scope for the launched project. The plugin reads `~/.claude/plugins/installed_plugins.json`, looks for the entry `whatsapp@claude-whatsapp`, and picks the local entry whose `projectPath` matches the launch cwd.
2. **`~/.claude/channels/whatsapp/`** — global fallback when no matching local install is found.

Companions detecting claude-whatsapp should replicate this logic (check the installed_plugins entry for the current project; fall back to the global path if absent).

The directory is created with `0700` permissions; the plugin re-tightens permissions on every startup in case an older install left things looser.

---

## Public files

Read-only from outside the plugin. Safe to watch, parse, or display.

### `status.json`

Primary signal: is the WhatsApp connection up, down, or in-between?

```json
{
  "status": "connected",
  "ts": 1713543200000
}
```

`status` is always one of:

| Value | Meaning | Extra fields |
|---|---|---|
| `deps_missing` | First launch — native deps aren't installed yet. Plugin is polling for them. | — |
| `qr_ready` | Ready to link. QR is at `<channel-dir>/qr.png`; pairing-code flow may be active. | `qrPath`, optionally `pairingCode`, `pairingPhone` |
| `qr_error` | QR rendering failed (disk / permission). Safe to retry. | — |
| `connected` | Linked and online. | — |
| `reconnecting` | Backing off after a disconnect. | `attempt` (consecutive failures), `nextDelayMs` |
| `logged_out` | Session terminated from the phone's Linked Devices UI. Needs re-linking. | — |
| `idle_other_instance` | Another running plugin instance holds the single-instance lock. This MCP server stays up for tool calls but won't connect to WhatsApp. | `holder` (PID) |
| `lock_error` | Filesystem error at `<channel-dir>/server.pid`. Check perms / disk. | `error` |

Written atomically with `0600` perms. Readers should tolerate the file being briefly absent (deleted across a restart before the first write).

### `access.json`

Access control state — who can DM, which groups are allowed, which pairings are pending.

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["5491155556666@s.whatsapp.net"],
  "groups": {
    "120363xxxxxxxxx@g.us": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "pending": {
    "a1b2c3": {
      "senderId": "5491166667777@s.whatsapp.net",
      "chatId": "5491166667777@s.whatsapp.net",
      "createdAt": 1713543200000,
      "expiresAt": 1713546800000,
      "replies": 1
    }
  }
}
```

Field reference:

| Field | Type | Semantics |
|---|---|---|
| `dmPolicy` | `"pairing" \| "allowlist" \| "disabled"` | Policy for DMs from unknown senders. |
| `allowFrom` | `string[]` | JIDs allowed for direct messaging and permission-relay broadcast. |
| `groups` | `Record<jid, {requireMention, allowFrom}>` | Per-group config. Absence = group drops. |
| `pending` | `Record<code, PendingEntry>` | Live pairing codes; expires after 1 hour. |

Companions can count `allowFrom.length` to know whether the channel has any DM targets at all, or inspect `groups` to enumerate allowed groups.

### `config.json`

All plugin configuration — flat schema, no nested objects.

```json
{
  "audioTranscription": true,
  "audioLanguage": "es",
  "audioModel": "base",
  "audioQuality": "balanced",
  "audioProvider": "local",
  "chunkMode": "newline",
  "replyToMode": "first",
  "ackReaction": "👀",
  "documentThreshold": 4000,
  "documentFormat": "auto",
  "pairingPhone": "5491155556666"
}
```

| Key | Type | Default |
|---|---|---|
| `audioTranscription` | boolean | `false` |
| `audioLanguage` | ISO 639-1 string or `null` | `null` (auto-detect) |
| `audioModel` | `"tiny" \| "base" \| "small"` | `"base"` (local provider only) |
| `audioQuality` | `"fast" \| "balanced" \| "best"` | `"balanced"` (local provider only) |
| `audioProvider` | `"local" \| "groq" \| "openai"` | `"local"` — `groq` / `openai` require the matching `GROQ_API_KEY` / `OPENAI_API_KEY` env var |
| `chunkMode` | `"length" \| "newline"` | `"length"` |
| `replyToMode` | `"off" \| "first" \| "all"` | `"first"` |
| `ackReaction` | string or undefined | undefined (disabled) |
| `documentThreshold` | number | `0` (disabled) — `-1` = always, `>0` = threshold in chars |
| `documentFormat` | `"auto" \| "md" \| "txt"` | `"auto"` |
| `pairingPhone` | E.164 digits (no `+`) or undefined | undefined |

Companions can read this to know whether voice transcription is on, or to adapt their own delivery (e.g. matching `chunkMode`).

### `transcriber-status.json`

Live state of the transcriber (whatever provider is active).

```json
{"status": "ready", "provider": "local", "ts": 1713543215000}
```

`status` is one of:

| Value | Meaning |
|---|---|
| `loading` | Model is downloading / warming up (local) or provider is being validated (cloud). |
| `ready` | Transcription pipeline is live. |
| `error` | Initialization failed; the transcriber is disabled until the next launch or config change. The `error` field holds the message. |

The `provider` field (added alongside cloud transcription support) reports which backend was last initialized: `"local"`, `"groq"`, or `"openai"`. Older snapshots written before this field existed will not include it; treat absence as `"local"`.

> ⚠️ The plugin never writes `"disabled"` as a status value. When voice transcription is turned off, the plugin sets its transcriber to `null` internally but does **not** rewrite `transcriber-status.json`. Treat the authoritative "is it on?" signal as `config.json`'s `audioTranscription: true`, not this file's contents. The file tells you whether the transcriber was last able to load, not whether it's currently enabled.

### `recent-groups.json`

Groups that have dropped messages because they weren't yet allowed. LRU-bounded to the 50 most-recent.

```json
{
  "120363xxxxxxxxx@g.us": {
    "first_seen_ts": 1713540000,
    "last_seen_ts": 1713543200,
    "drop_count": 7,
    "last_sender_push_name": "Juan",
    "last_sender_id": "5491155556666@s.whatsapp.net"
  }
}
```

Useful for companion UIs that want to surface "groups awaiting allow". Entries disappear when `add-group` is called for that JID.

### `messages.db`

SQLite + FTS5 store of all indexed messages. Schema described in [docs/search-export.md#where-the-store-lives](search-export.md#where-the-store-lives).

Prefer calling the MCP tools (`search_messages`, `list_group_senders`, `export_chat`) over opening the file directly — the WAL journal can be in flight. If you do open it, use a read-only connection with `journal_mode=WAL` respected.

### `inbox/`

Downloaded inbound media files. Naming pattern documented in [docs/media-voice.md#inbound-media-layout](media-voice.md#inbound-media-layout). Files are user-owned (`0600`), inside a `0700` directory.

### `logs/conversations/*.jsonl` and `logs/conversations/*.md`

Daily conversation logs. Structure documented in [docs/operations.md#logs](operations.md#logs). Companions can tail the `.jsonl` for a complete message stream without going through MCP.

### `logs/system.log`

Plain-text server log. Not a structured format — grep-friendly but don't parse it programmatically.

---

## Private files

**Do not read or write from outside the plugin.** These are either secrets or transient state managed by the server process.

| Path | Why private |
|---|---|
| `auth/` | Baileys session keys. Presence means a session has been linked, but the contents are rotating crypto material. Never copy or display. |
| `server.pid` | Single-instance lock. Managed by the server — writing to it from outside will cause two instances to fight or both fail. |
| `qr.png` | Transient, regenerated by Baileys on each QR rotation (~20s cadence). Use `status.json.qrPath` instead of opening the file directly. |
| `*.tmp`, `*.corrupt-*` | Atomic-write scratch files and quarantined corrupt JSON. Transient. |

---

## MCP capabilities

The plugin declares two experimental capabilities on its MCP server handshake:

| Capability | Purpose |
|---|---|
| `experimental['claude/channel']` | Registers the server as a channel notification handler. Routes inbound WhatsApp messages to Claude Code via `notifications/claude/channel`. |
| `experimental['claude/channel/permission']` | Opts into Claude Code's permission-relay protocol. Enables the `🔐 Claude wants to run …` broadcasts and the approve/deny flow. See [docs/permission-relay.md](permission-relay.md). |

**MCP server name**: `whatsapp`. Tools surface to the model as `mcp__whatsapp__<tool>` (e.g. `mcp__whatsapp__search_messages`). Use this namespacing to write precise rules (`/permissions` entries, enablement flags) that target WhatsApp tools without affecting other plugins.

---

## Detection patterns

### "Is claude-whatsapp installed?"

Check for a cached plugin under the marketplace:

```js
const installed = fs.existsSync(
  path.join(os.homedir(), '.claude/plugins/cache/claude-whatsapp')
)
```

If you want to know which *scope* (local project vs global) the user picked, parse `~/.claude/plugins/installed_plugins.json`:

```js
const plugins = JSON.parse(
  fs.readFileSync(`${os.homedir()}/.claude/plugins/installed_plugins.json`, 'utf8')
)
const entries = plugins.plugins?.['whatsapp@claude-whatsapp'] ?? []
// `entries` is an array — one per scope/project the user installed under.
```

### "Is the WhatsApp connection up?"

```js
const s = JSON.parse(fs.readFileSync(`${channelDir}/status.json`, 'utf8'))
if (s.status === 'connected') { /* linked and online */ }
```

Note: `status.ts` is milliseconds (epoch), not seconds — useful if you want to show "last checked X ago".

### "Can I broadcast to any DM contact right now?"

```js
const access = JSON.parse(fs.readFileSync(`${channelDir}/access.json`, 'utf8'))
const dmTargets = access.allowFrom.filter((j) => !j.endsWith('@g.us'))
const canBroadcast = dmTargets.length > 0 && access.dmPolicy !== 'disabled'
```

### "Has the user enabled voice transcription?"

```js
const config = JSON.parse(fs.readFileSync(`${channelDir}/config.json`, 'utf8'))
if (config.audioTranscription === true) { /* enabled */ }
```

Don't key off `transcriber-status.json` for this — as noted above, that file only tells you the *last* load attempt, not current state.

---

## Worked example: ClawCode integration

The ClawCode agent plugin ([crisandrews/ClawCode](https://github.com/crisandrews/ClawCode)) uses the contract above to surface WhatsApp as a delivery channel.

**Detection & offer** — On first-run setup, ClawCode's `/agent:messaging` checks whether claude-whatsapp is installed. If not, it walks the user through installing it. claude-whatsapp runs the symmetric check (`isClawCodeInstalled()` in `server.ts`) so neither plugin loops on suggesting the other.

**Status surfacing** — `/agent:channels` reads each messaging plugin's `status.json` (including ours) and shows whether it's connected. A green check means `status === 'connected'`, red means anything else, with the specific status string as hover text.

**Scheduled delivery** — ClawCode crons can declare `delivery.channel: "whatsapp"`. When such a cron fires, ClawCode looks up the claude-whatsapp MCP server by name (`whatsapp`) and calls the `reply` tool (`mcp__whatsapp__reply`) with a `chat_id` and the cron's output as `text`. Because the MCP server name is stable, ClawCode doesn't need to know the plugin's internal path layout.

**Error handling** — If the reply call fails (WhatsApp not connected, recipient not allowlisted, etc.), ClawCode logs the failure to its own cron-run log but does not retry — the user sees the cron-run entry with the error and can fix it manually.

Relevant hooks on our side: `server.ts:223-239` (isClawCodeInstalled detection), `server.ts:759-793` (first-connect companion suggestion). Relevant ClawCode hooks: its `/agent:channels` skill and its cron delivery dispatch.

---

## Stability policy

The contract documented here is versioned alongside the plugin:

- **Path shapes** — `<channel-dir>/<file>` — stable. New files may be added; existing ones won't move.
- **Field names in public JSON** — stable. New fields may be added; existing ones won't be renamed or have their semantics changed.
- **`status.json`'s enum** — stable. New values may be added; existing ones won't be removed.
- **MCP server name and tool names** — stable. New tools may be added; existing ones won't be renamed or have arguments renamed (arguments may become optional or gain new optional companions, but won't lose required fields).

If any of the above needs to change, it ships behind a major version bump with migration notes in `CHANGELOG.md`.

What's NOT part of the contract:

- The internal path layouts under `auth/` (Baileys format).
- `logs/system.log`'s message text (grep at your own risk).
- Internal constants like the reconnect backoff curve, LID cache size, or syslog throttle rates — observable only, not contractual.
- Anything in `server.ts` that isn't mirrored above.

Questions about extending the contract for a new companion? File an issue — keeping this surface small and deliberate is a design goal.
