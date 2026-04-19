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
  <a href="#going-further">Going further</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
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
- **[Voice transcription](#voice-transcription-optional)** — local Whisper, no API keys, 12+ languages.
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

## [Access control](#access-control)

| Command | Description |
| --- | --- |
| `/whatsapp:access` | List allowed users, pending pairings, and current policy |
| `/whatsapp:access pair <code>` | Approve a pending pairing |
| `/whatsapp:access deny <code>` | Reject a pending pairing |
| `/whatsapp:access allow <jid>` | Add a user directly |
| `/whatsapp:access revoke <jid>` | Remove a user |
| `/whatsapp:access policy <mode>` | Set DM policy: `pairing`, `allowlist`, or `disabled` |
| `/whatsapp:access add-group <jid>` | Allow a group |
| `/whatsapp:access remove-group <jid>` | Remove a group |

Default policy is `pairing`. IDs are WhatsApp JIDs — format depends on your Baileys version (e.g. `56912345678@s.whatsapp.net` or `199999598137448@lid`). Check `/whatsapp:access` to see the exact IDs.

## [Features](#features)

### [Tools](#tools)

| Tool | Purpose |
| --- | --- |
| `reply` | Send text or files. Auto-chunks long text at 4096 chars (configurable). Max 50 MB per file. |
| `react` | Emoji reaction on a message. |
| `edit_message` | Rewrite a previously sent message in place — no push notification, just an "edited" tag. WhatsApp's ~15-minute edit window applies. |
| `delete_message` | Revoke a message Claude sent. Both sides see the standard "This message was deleted" placeholder. |
| `send_poll` | Send a tappable poll with 2-12 options. Single-choice by default, optional multi-select. |
| `download_attachment` | Access downloaded media from the inbox. |
| `search_messages` | Full-text search the local message store. Supports `word*`, `"exact phrase"`, `NEAR(a b, 5)`, `-excluded`. Optionally scoped to a chat. |
| `fetch_history` | Ask WhatsApp to ship older messages for a chat. Anchor is the oldest known message; backfilled messages arrive in the background and are indexed automatically. |
| `export_chat` | Dump a chat from the local store as `markdown`, `jsonl`, or `csv` under the inbox directory. Optional `since_ts` / `until_ts` window. |

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

When Claude Code asks to run a tool (e.g. a Bash command), the plugin broadcasts the request to every allowlisted DM contact:

```
🔐 Claude wants to run *Bash*
ls -la /tmp

Reply *yes abcde* / *no abcde* or react 👍 / 👎.
```

You can respond from your phone in two ways:
- **Reply with text**: `yes <id>` to allow, `no <id>` to deny. Case-insensitive — mobile autocaps work.
- **React to the message**: 👍 / ✅ to allow, 👎 / ❌ to deny.

Whoever responds first wins. The terminal prompt remains active as a fallback. Pending requests expire after 5 minutes.

Tool prompts highlight the most relevant part of the request: **Bash** shows the command, **Edit / Write / MultiEdit** show the file with 📄, **Read** shows the path with 👁, **WebFetch** the URL with 🌐, **WebSearch** the query with 🔍.

### [Search, history, and export](#search-history-and-export)

Every inbound and outbound message — including reactions, edits, file captions, and history backfills — is indexed locally in `<channel-dir>/messages.db`. Three tools sit on top:

| Tool | What it does |
| --- | --- |
| `search_messages` | Full-text search with snippets. Optionally scope to one chat. |
| `fetch_history` | Pull older messages for a chat from WhatsApp. Indexed automatically as they arrive. |
| `export_chat` | Write the chat to `markdown` / `jsonl` / `csv` under the inbox. |

The store is local-only, created with user-only file permissions. Safe to delete to wipe history; it'll be recreated on next launch.

### [Reply shaping](#reply-shaping)

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

Inbound photos, voice messages, videos, and documents are automatically downloaded to `.whatsapp/inbox/` inside your project directory (max 50 MB per file). The file path is included in the notification so Claude can read or reference it.

### [Voice transcription (optional)](#voice-transcription-optional)

By default, voice messages arrive as `[Voice message received]` with the audio file saved. To enable automatic local transcription:

```
/whatsapp:configure audio
```

The Whisper model (~77MB) downloads on the first voice message and is cached permanently. Runs entirely on your machine — no API keys needed.

**Setting your language (recommended):** For best accuracy, set your primary language:

```
/whatsapp:configure audio es
```

| Code | Language | | Code | Language |
| --- | --- | --- | --- | --- |
| `es` | Spanish | | `ja` | Japanese |
| `en` | English | | `zh` | Chinese |
| `pt` | Portuguese | | `ko` | Korean |
| `fr` | French | | `ar` | Arabic |
| `de` | German | | `ru` | Russian |
| `it` | Italian | | `hi` | Hindi |

Without a language set, Whisper auto-detects — but setting it explicitly is more accurate, especially for short voice messages.

**Model size** (tradeoff: accuracy vs speed):

```
/whatsapp:configure audio model small
```

| Model | Size | Speed | Accuracy |
| --- | --- | --- | --- |
| `tiny` | ~39 MB | Fastest | Lower |
| `base` | ~77 MB | Balanced | Good (default) |
| `small` | ~250 MB | Slower | Best |

**Quality** (tradeoff: precision vs speed):

```
/whatsapp:configure audio quality best
```

| Quality | Description |
| --- | --- |
| `fast` | Quantized, no beam search |
| `balanced` | Quantized, standard decoding (default) |
| `best` | Full precision, 5-beam search. Slowest but most accurate |

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

### [Using a WhatsApp number that's already on OpenClaw](#using-a-whatsapp-number-thats-already-on-openclaw)

If you have a WhatsApp number running an agent on [OpenClaw](https://github.com/openclaw/openclaw), you can try this plugin without losing anything. Just close OpenClaw (or stop that agent), scan the QR code here, and the number will work through Claude Code natively. When you're done, close Claude Code and reopen OpenClaw — your OpenClaw agent will reconnect and respond as before. Each platform re-links the WhatsApp session on startup, so they don't conflict — just don't run both at the same time on the same number.

### [Always-on (run as a background service)](#always-on-run-as-a-background-service)

To keep your WhatsApp agent running permanently, wrap Claude Code with a process manager:

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.whatsapp-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatsapp-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>claude</string>
        <string>--dangerously-load-development-channels</string>
        <string>plugin:whatsapp@claude-whatsapp</string>
        <string>--dangerously-skip-permissions</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/my-whatsapp-agent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/whatsapp-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/whatsapp-agent.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.whatsapp-agent.plist
```

**Linux (systemd):**

Create `~/.config/systemd/user/whatsapp-agent.service`:

```ini
[Unit]
Description=WhatsApp Agent (Claude Code)

[Service]
WorkingDirectory=/home/YOUR_USER/my-whatsapp-agent
ExecStart=claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now whatsapp-agent
```

**Windows (Task Scheduler):**

Create a scheduled task that runs at login with the command:
```
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
```
Set the "Start in" directory to your agent folder.

### [Multiple agents](#multiple-agents)

Each agent folder has its own WhatsApp session and access control:

```
~/agent-sales/.whatsapp/     ← WhatsApp #1
~/agent-support/.whatsapp/   ← WhatsApp #2
```

Install the plugin in each folder with local scope and scan a separate QR code for each.

## [Session & data](#session--data)

State is stored in `.whatsapp/` inside your project directory:

```
~/my-whatsapp-agent/.whatsapp/
├── auth/                          # WhatsApp session keys
├── inbox/                         # Downloaded media
├── approved/                      # Pairing signals
├── logs/
│   ├── conversations/
│   │   ├── 2026-04-09.jsonl       # Messages (machine-readable)
│   │   └── 2026-04-09.md          # Messages (human-readable)
│   └── system.log                 # Server events (connections, errors)
├── access.json                    # Access control
├── config.json                    # Plugin settings (audio, language)
└── status.json                    # Connection state
```

**Conversation logs** are stored in two formats:
- **JSONL** — one JSON object per line, ideal for programmatic access, RAG, or memory systems
- **Markdown** — human-readable chat transcript

Reset with `/whatsapp:configure reset`.

## [Updating, uninstalling, and cache](#updating-uninstalling-and-cache)

**Update to the latest version:**

1. Inside Claude Code:
   ```
   /plugin update whatsapp@claude-whatsapp
   ```
2. Close Claude (Ctrl+C or `/exit`)
3. Reopen with the same launch command:
   ```sh
   claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
   ```
4. Wait for the "dependencies installed" notification (~60s on first update)
5. Run `/reload-plugins`, then `/whatsapp:configure`

Your WhatsApp session is preserved — no QR scan needed. The dependency install only happens once per update.

**Uninstall:**

```
/plugin uninstall whatsapp@claude-whatsapp
```

**Clear cache (if reinstall fails or behaves unexpectedly):**

Close Claude, then run in your terminal:

```sh
rm -rf ~/.claude/plugins/cache/claude-whatsapp
```

Then reopen Claude and install again.

## [Troubleshooting](#troubleshooting)

- **Voice messages transcribe in the wrong language** — Set your language explicitly: `/whatsapp:configure audio es`. Without it, the model often defaults to English on short clips.
- **Server didn't start (first launch)** — The first launch downloads dependencies (~60s). Run `/whatsapp:configure` — it waits automatically. If it still fails, close and reopen Claude with the channel flag.
- **QR code expired** — Run `/whatsapp:configure` again. The server generates a fresh QR every ~20 seconds.
- **WhatsApp disconnected** — Sessions can expire if you log out from your phone. Run `/whatsapp:configure reset` then `/whatsapp:configure` to scan a new QR.
- **Voice transcription is slow** — Whisper runs on CPU. Try `/whatsapp:configure audio model tiny` for speed, or `/whatsapp:configure audio quality fast`.
- **Reinstall fails or plugin behaves unexpectedly** — Clear the cache: close Claude, run `rm -rf ~/.claude/plugins/cache/claude-whatsapp` in terminal, reopen and install again.

## [Important](#important)

- **Unofficial API** — Baileys is not endorsed by WhatsApp. Use responsibly — no spam, no bulk messaging.
- **One linked device slot** — Unlink anytime from WhatsApp > Settings > Linked Devices.
- **No message history** — Only sees messages as they arrive. Cannot fetch older messages.

## [Disclaimer](#disclaimer)

This project is not affiliated with, endorsed by, or associated with WhatsApp, Meta, or Anthropic. WhatsApp is a trademark of Meta Platforms, Inc. Claude is a trademark of Anthropic, PBC. This plugin uses the unofficial Baileys library for WhatsApp Web connectivity.
