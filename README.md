<h1 align="center">💬 WhatsApp for Claude Code</h1>

<p align="center">
  <strong>Your WhatsApp number, powered by Claude Code.</strong>
</p>

<p align="center">
  <a href="https://github.com/crisandrews/claude-whatsapp/releases"><img src="https://img.shields.io/github/v/release/crisandrews/claude-whatsapp?include_prereleases&style=for-the-badge&color=25D366" alt="Release"></a>
  <a href="https://github.com/crisandrews/claude-whatsapp/stargazers"><img src="https://img.shields.io/github/stars/crisandrews/claude-whatsapp?style=for-the-badge&color=blue" alt="Stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-blue?style=for-the-badge&logo=node.js&logoColor=white" alt="Node ≥ 18">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge" alt="Platform">
</p>

<p align="center">
  <a href="#quick-setup">Quick Setup</a> ·
  <a href="#features">Features</a> ·
  <a href="#access-control">Access</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#going-further">Going further</a> ·
  <a href="https://github.com/crisandrews/claude-whatsapp/issues">Issues</a>
</p>

---

With Anthropic's recent policy changes, many users lost access to their AI agents through messaging platforms. While official channel plugins exist for [Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) and Instagram, **WhatsApp — the world's most used messaging app — had no solution.**

This plugin fills that gap. It connects your WhatsApp number directly to Claude Code, turning it into a fully functional AI agent that responds through WhatsApp.

## [Highlights](#highlights)

- **[Native WhatsApp channel](#quick-setup)** — scan a QR (or use a pairing code on headless servers), pair your contacts, start chatting with Claude.
- **[Access control](#access-control)** — pairing codes, allowlist, group gating with `requireMention`. Nobody talks to your agent without permission.
- **[Permission relay](#permission-requests-over-whatsapp)** — when Claude wants to run a tool, get the prompt on WhatsApp; approve or deny with a 👍 reaction or `yes <id>` reply.
- **[Local search and export](#search-history-and-export)** — every message indexed locally; full-text search, request older messages from WhatsApp, dump chats to markdown / jsonl / csv.
- **[Voice transcription](#voice-transcription-optional)** — local Whisper, no API keys, 99+ languages.
- **[Media pipeline](#media)** — inbound images, audio, video, and documents auto-downloaded for Claude to read.
- **[Reply shaping](#reply-shaping)** — paragraph-aware chunking, optional ack reaction, auto-document for long replies, message editing without push notifications.
- **[Autonomous mode + web browsing](#autonomous-mode--web-browsing)** — combine with `--chrome` for a fully agentic WhatsApp assistant.
- **[Always-on](#always-on-run-as-a-background-service)** — launchd, systemd, or Task Scheduler recipes included.
- **[Multiple agents](#multiple-agents)** — run separate numbers from separate folders, each isolated.

## [Prerequisites](#prerequisites)

- [Node.js](https://nodejs.org/) v18+

## [Quick Setup](#quick-setup)

**1. Create a folder for your WhatsApp agent.**

Each agent lives in its own folder. Create one and open Claude Code there:

```sh
mkdir ~/my-whatsapp-agent && cd ~/my-whatsapp-agent
claude
```

**2. Install the plugin.**

Inside Claude Code, add the marketplace:

```
/plugin marketplace add crisandrews/claude-whatsapp
```

Then install the plugin:

```
/plugin install whatsapp@claude-whatsapp
```

When prompted for scope, select **"Install for you, in this repo only (local scope)"** — this keeps the agent isolated to this folder.

**3. Close and relaunch with the WhatsApp channel.**

Exit Claude Code (`/exit` or Ctrl+C), then relaunch:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
```

> `--dangerously-skip-permissions` lets the agent run without asking for confirmation on every action — recommended for a smooth experience. First launch installs dependencies in the background (~60-90s). Subsequent launches are instant.

**4. Link your number.**

```
/whatsapp:configure
```

Opens a QR code on your screen. Scan it with WhatsApp > **Settings > Linked Devices > Link a Device**.

> **Headless server / no camera?** Run `/whatsapp:configure pair +5491155556666` first. The next link cycle generates an 8-character code instead of a QR — read it from the terminal, then on your phone open WhatsApp > **Linked Devices > Link with phone number** and type it in.

Session is saved — you won't need to link again unless you log out.

**5. Pair.**

Message your WhatsApp number from another phone. It replies with a 6-character code. In Claude Code:

```
/whatsapp:access pair <code>
```

**6. Lock it down.**

```
/whatsapp:access policy allowlist
```

Now only your approved contacts can reach Claude.

## [Documentation](#documentation)

In-depth guides, each with worked examples end-to-end. The README is the at-a-glance reference; these pages are where the tutorials live.

**Setup & access**

- **[docs/access.md](docs/access.md)** — DM access tutorial: pairing flow, the three policies, JID formats, recovery.
- **[docs/groups.md](docs/groups.md)** — adding the bot to a WhatsApp group, the four access policies, discovery flow, member discovery, edge cases.

**Runtime reference**

- **[docs/configuration.md](docs/configuration.md)** — every `/whatsapp:configure` sub-command (linking, audio, reply shaping, auth migration, reset) and every key in `config.json`.
- **[docs/tools.md](docs/tools.md)** — per-tool reference (`reply`, `react`, `search_messages`, `fetch_history`, …) with natural-language examples and pitfalls.
- **[docs/permission-relay.md](docs/permission-relay.md)** — how Claude Code's permission prompts reach your phone, how to respond from text or reaction.
- **[docs/media-voice.md](docs/media-voice.md)** — inbound media runtime: layout, the 50 MB cap, the `inbox/` sandbox, voice transcription end-to-end, stickers / locations / contacts.
- **[docs/search-export.md](docs/search-export.md)** — full-text search, FTS5 query matrix, `fetch_history` flow, export formats.

**Operations & integration**

- **[docs/operations.md](docs/operations.md)** — background service (launchd/systemd/Task Scheduler), updates, cache, multi-instance, logs, reconnection.
- **[docs/state-contract.md](docs/state-contract.md)** — public contract for companion plugins: channel dir, public files, MCP capabilities, ClawCode integration walkthrough.
- **[docs/troubleshooting.md](docs/troubleshooting.md)** — symptoms → causes → fixes; covers every connection state and the most common gotchas.

## [Access control](#access-control)

### [DMs](#access-dms)

> *Deep dive with worked examples: [docs/access.md](docs/access.md).*

| Command | Description |
| --- | --- |
| `/whatsapp:access` | List allowed users, pending pairings, and current policy |
| `/whatsapp:access pair <code>` | Approve a pending pairing |
| `/whatsapp:access deny <code>` | Reject a pending pairing |
| `/whatsapp:access allow <jid>` | Add a user directly |
| `/whatsapp:access revoke <jid>` | Remove a user |
| `/whatsapp:access policy <mode>` | Set DM policy: `pairing`, `allowlist`, or `disabled` |

Default policy is `pairing`. IDs are WhatsApp JIDs — format depends on your Baileys version (e.g. `56912345678@s.whatsapp.net` or `199999598137448@lid`). Check `/whatsapp:access` to see the exact IDs.

### [Groups](#access-groups)

> *Deep dive with worked examples: [docs/groups.md](docs/groups.md).*

**Group access is fully independent of DM access.** Allowing someone in a group does NOT let them DM the bot, and pairing a DM contact does NOT auto-allow them in any group.

| Command | Description |
| --- | --- |
| `/whatsapp:access add-group <jid>` | Allow a group, mention-only (default). |
| `/whatsapp:access add-group <jid> --no-mention` | Allow a group, open delivery (every message goes to Claude). |
| `/whatsapp:access group-allow <group-jid> <member-jid>` | Restrict the group to specific members. |
| `/whatsapp:access group-revoke <group-jid> <member-jid>` | Remove a member from the group's whitelist. |
| `/whatsapp:access remove-group <jid>` | Stop accepting messages from the group entirely. |

## [Features](#features)

### [Tools](#tools)

> *Deep dive with worked examples: [docs/tools.md](docs/tools.md).*

| Tool | Purpose |
| --- | --- |
| `reply` | Send text or files. Auto-chunks long text at 4096 chars (configurable). |
| `react` | Emoji reaction on a message. |
| `edit_message` | Rewrite a previously-sent message in place — no push notification, just an "edited" tag. |
| `delete_message` | Revoke a message Claude sent. |
| `send_poll` | Send a tappable poll with 2-12 options. |
| `download_attachment` | Access downloaded media from the inbox. |
| `search_messages` | Full-text search the local message store. |
| `fetch_history` | Ask WhatsApp for older messages in a chat. |
| `list_group_senders` | Participants who have spoken in a chat (from the local store). |
| `export_chat` | Dump a chat as `markdown`, `jsonl`, or `csv` under the inbox. |

**What's NOT a plugin feature (yet)**

- Inviting or removing people from a group, renaming a group, or creating a new group from Claude.
- Sending voice notes (audio messages). Inbound voice is transcribed; outbound voice isn't.

### [Reactions](#reactions)

Reactions behave differently depending on what the user reacts to:

**On a permission request** (a `🔐 Claude wants to run …` message): the plugin intercepts the reaction directly and converts it into an approve/deny decision sent back to Claude Code. The terminal prompt clears automatically.

| Reaction | Meaning |
| --- | --- |
| 👍 / ✅ | Approve the pending tool |
| 👎 / ❌ | Deny the pending tool |

Skin-tone variants of 👍 / 👎 also work. Pending requests time out after 5 minutes; the terminal-side dialog stays active either way, so you can also approve there.

**On a regular message**: the reaction is forwarded to Claude as `[Reacted with X]` and Claude interprets it from context — typically 👍 as "ok/proceed" and 👎 as "no/stop".

### [Permission requests over WhatsApp](#permission-requests-over-whatsapp)

> *Deep dive with worked examples: [docs/permission-relay.md](docs/permission-relay.md).*

When Claude Code asks to run a tool (e.g. a Bash command), the plugin broadcasts the request to every allowlisted DM contact:

```
🔐 Claude wants to run *Bash*
ls -la /tmp

Reply *yes abcde* / *no abcde* or react 👍 / 👎.
```

Respond with text (`yes <id>` / `no <id>`, case-insensitive) or a reaction (👍 / ✅ to allow, 👎 / ❌ to deny). Whoever responds first wins; the terminal prompt remains active as a fallback. Pending requests expire after 5 minutes.

### [Search, history, and export](#search-history-and-export)

> *Deep dive with worked examples: [docs/search-export.md](docs/search-export.md).*

Every inbound and outbound message — including reactions, edits, file captions, and history backfills — is indexed locally to SQLite + FTS5. Claude can full-text search your chats, pull older messages from WhatsApp on demand, and export a chat as `markdown` / `jsonl` / `csv`. The store is local-only, user-only permissions (`0600`), and safe to delete to wipe history.

### [Reply shaping](#reply-shaping)

> *Deep dive with worked examples: [docs/configuration.md#reply-shaping](docs/configuration.md#reply-shaping).*

Several knobs control how Claude's outbound messages look on WhatsApp. All set via `/whatsapp:configure`:

| Command | Effect |
| --- | --- |
| `chunk-mode newline` | Split long replies at the nearest paragraph / line / space instead of cutting at 4096 chars |
| `reply-to first` (default) / `all` / `off` | Which chunks of a long reply quote the user's original message |
| `ack 👀` | React with this emoji as soon as a message arrives, before Claude composes a reply |
| `ack off` | Disable the ack reaction |
| `document threshold 4000` | Send replies above N chars as a single `.md` / `.txt` attachment instead of many chunked messages |
| `document threshold off` | Always chunk, never auto-document |
| `document format md` / `txt` / `auto` | Force the auto-document filename / MIME (default `auto` picks based on content) |

### [Media](#media)

> *Deep dive with worked examples: [docs/media-voice.md](docs/media-voice.md).*

Inbound photos, voice messages, videos, and documents are automatically downloaded to `<channel-dir>/inbox/` — `<project>/.whatsapp/inbox/` for local-scope installs, `~/.claude/channels/whatsapp/inbox/` for the global fallback. Max 50 MB per inbound file. The file path is included in the notification so Claude can read or reference it.

Stickers, locations, and contacts are forwarded as descriptive text (`[Sticker received]`, `[Location: lat, lng]`, `[Contact: name]`) without downloading a file.

### [Voice transcription (optional)](#voice-transcription-optional)

> *Deep dive with worked examples: [docs/media-voice.md#voice-transcription-end-to-end](docs/media-voice.md#voice-transcription-end-to-end) and [docs/configuration.md#voice-transcription](docs/configuration.md#voice-transcription).*

By default, voice messages arrive as `[Voice message received]` with the audio file saved. To enable automatic local transcription:

```
/whatsapp:configure audio
```

The Whisper model (~77MB for `base`) downloads on the first voice message and is cached permanently. Runs entirely on your machine — 99+ languages supported, no API keys needed. Recommended: set your primary language explicitly (`/whatsapp:configure audio es`) for short-message accuracy.

Model size (`tiny` / `base` / `small`) and quality (`fast` / `balanced` / `best`) are configurable — full tradeoff tables in [docs/configuration.md#voice-transcription](docs/configuration.md#voice-transcription).

Disable with `/whatsapp:configure audio off`.

## [Going further](#going-further)

### [Autonomous mode + web browsing](#autonomous-mode--web-browsing)

For a fully autonomous agent that doesn't ask permission for every action and can browse the web:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions --chrome
```

| Flag | What it does |
| --- | --- |
| `--dangerously-skip-permissions` | Agent executes tools without asking for confirmation |
| `--chrome` | Agent can browse the web and interact with pages |

### [Computer use](#computer-use)

Once the agent is running, type `/mcp` inside Claude Code and enable **computer use**. This lets the agent control your computer (click, type, take screenshots) — useful for tasks that go beyond chat.

### [Migrating from another WhatsApp tool (OpenClaw, wppconnect, previous checkout)](#migrating-from-another-whatsapp-tool)

If your WhatsApp number already runs on another local Baileys-based tool — [OpenClaw](https://github.com/openclaw/openclaw), wppconnect, or a previous checkout of this plugin — you have two paths:

**Option A — Just switch at link time.** Close the other tool (or stop that agent), scan the QR here, and the number will work through Claude Code natively. Each platform re-links the WhatsApp session on startup, so they don't conflict — just don't run both at the same time on the same number.

**Option B — Import the session directly**, with no re-scan:

```
/whatsapp:configure import /path/to/other/.whatsapp/auth
```

Validates the source, backs up the current session to `auth.backup-<timestamp>/`, copies the credentials over, and tightens permissions. After import, `/reload-plugins` picks up the imported session.

> **Important**: importing creds that are also in active use elsewhere will cause both sides to fight for the WhatsApp session. Stop the source app first.

Full migration walkthrough in [docs/configuration.md#auth-migration](docs/configuration.md#auth-migration).

### [Always-on (run as a background service)](#always-on-run-as-a-background-service)

> *Full recipes (launchd, systemd, Task Scheduler) in [docs/operations.md#background-service](docs/operations.md#background-service).*

To keep your WhatsApp agent running permanently, wrap Claude Code with your platform's process manager:

**macOS (launchd)** — create a `com.whatsapp-agent.plist` under `~/Library/LaunchAgents/` that runs `claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions` with `RunAtLoad` and `KeepAlive` set.

**Linux (systemd)** — create `~/.config/systemd/user/whatsapp-agent.service` with the same command; enable with `systemctl --user enable --now whatsapp-agent`.

**Windows (Task Scheduler)** — scheduled task that runs at login, with "Start in" set to your agent folder.

### [Multiple agents](#multiple-agents)

Each agent folder has its own WhatsApp session and access control:

```
~/agent-sales/.whatsapp/     ← WhatsApp #1
~/agent-support/.whatsapp/   ← WhatsApp #2
```

Install the plugin in each folder with local scope and scan a separate QR code for each. See [docs/operations.md#multiple-agents--multiple-numbers](docs/operations.md#multiple-agents--multiple-numbers) for the caveats (one instance per number, single-instance lock).

## [Session & data](#session--data)

> *Integration details and public contract for companion plugins: [docs/state-contract.md](docs/state-contract.md).*

State is stored under a "channel directory": `<project>/.whatsapp/` for local-scope installs, otherwise `~/.claude/channels/whatsapp/`. Top-level layout:

```
<channel-dir>/
├── auth/                          # WhatsApp session keys (private)
├── inbox/                         # Downloaded inbound media + exports
├── logs/
│   ├── conversations/             # Daily .jsonl + .md transcripts
│   └── system.log                 # Server events
├── access.json                    # DM policy, allowlist, groups, pending
├── config.json                    # Plugin settings
├── recent-groups.json             # Unknown groups that dropped messages
├── messages.db                    # SQLite + FTS5 search store
├── status.json                    # Connection state
├── transcriber-status.json        # Voice transcription pipeline state
├── qr.png                         # Last QR (transient)
└── server.pid                     # Single-instance lock
```

Reset the linked session with `/whatsapp:configure reset`. Everything else (access, config, history) survives a reset.

## [Works alongside other plugins](#works-alongside-other-plugins)

This plugin is namespaced under its own plugin id (`whatsapp`) and its own MCP server name (`whatsapp`), so loading it together with other plugins does not collide on tool names, skill names, or hooks. Nothing here assumes any specific other plugin is installed.

A few companion plugins already integrate with claude-whatsapp — see [docs/state-contract.md#worked-example-clawcode-integration](docs/state-contract.md#worked-example-clawcode-integration) for how ClawCode ([crisandrews/ClawCode](https://github.com/crisandrews/ClawCode)) uses the public contract.

## [Updating, uninstalling, and cache](#updating-uninstalling-and-cache)

> *Full procedures and what-survives-what in [docs/operations.md#updating](docs/operations.md#updating).*

**Update:** `/plugin update whatsapp@claude-whatsapp`, close Claude, relaunch, wait for the deps install notification (~60s on first update), then `/reload-plugins`. Your session / access / config / message history are preserved.

**Uninstall:** `/plugin uninstall whatsapp@claude-whatsapp`. The channel directory remains — delete `<your-project>/.whatsapp/` (or `~/.claude/channels/whatsapp/`) if you also want to wipe state.

**Clear cache:** close Claude, `rm -rf ~/.claude/plugins/cache/claude-whatsapp`, reopen and reinstall.

## [Troubleshooting](#troubleshooting)

> *Full catalogue of symptoms → causes → fixes in [docs/troubleshooting.md](docs/troubleshooting.md).*

- **After `/plugin update`, the agent stops responding** — The plugin is reinstalling its dependencies in the background. Wait, don't restart. Run `/whatsapp:configure` to see live status — it'll report `deps_missing` while the install runs and transition out automatically. Once out, `/reload-plugins` brings everything cleanly online.
- **Voice messages transcribe in the wrong language** — Set your language explicitly: `/whatsapp:configure audio es`. Without it, the model often defaults to English on short clips.
- **QR code expired** — Run `/whatsapp:configure` again. The server generates a fresh QR every ~20 seconds.
- **WhatsApp disconnected after a phone-side logout** — Run `/whatsapp:configure reset` then `/whatsapp:configure` to scan a new QR.

## [Important](#important)

- **Unofficial API** — Baileys is not endorsed by WhatsApp. Use responsibly — no spam, no bulk messaging.
- **One linked device slot** — Unlink anytime from WhatsApp > Settings > Linked Devices.
- **Local-only message history** — Inbound and outbound messages (including reactions, edits, and history backfills) are indexed to a local SQLite store with FTS5; the `search_messages`, `fetch_history`, and `export_chat` tools sit on top. Nothing leaves your machine.

## [Disclaimer](#disclaimer)

This project is not affiliated with, endorsed by, or associated with WhatsApp, Meta, or Anthropic. WhatsApp is a trademark of Meta Platforms, Inc. Claude is a trademark of Anthropic, PBC. This plugin uses the unofficial Baileys library for WhatsApp Web connectivity.
