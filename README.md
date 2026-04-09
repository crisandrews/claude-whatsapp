# WhatsApp for Claude Code

> **Release 1.1** — Voice transcription, autonomous mode, and reliability improvements.

With Anthropic's recent policy changes, many users lost access to their AI agents through messaging platforms. While official channel plugins exist for [Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram) and Instagram, **WhatsApp — the world's most used messaging app — had no solution.**

This plugin fills that gap. It connects your WhatsApp number directly to Claude Code, turning it into a fully functional AI agent that responds through WhatsApp. This is version 1.0 with plans to evolve into a more complete and agentic platform for WhatsApp.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+

## Quick Setup

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

**4. Scan the QR code.**

```
/whatsapp:configure
```

Opens a QR code on your screen. Scan it with WhatsApp > **Settings > Linked Devices > Link a Device**.

Session is saved — you won't need to scan again unless you log out.

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

## Access control

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

## Features

### Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send text or files. Auto-chunks at 4096 chars. Max 50 MB per file. |
| `react` | Emoji reaction on a message. |
| `download_attachment` | Access downloaded media from the inbox. |

### Reactions

Emoji reactions on messages are forwarded to Claude as commands:

| Reaction | Meaning |
| --- | --- |
| 👍 | "Proceed", "ok", "yes" — confirms or approves |
| 👎 | "No", "stop", "cancel" — rejects |

Long-press any message in the chat and tap a reaction. Claude will interpret it in context.

### Media

Inbound photos, voice messages, videos, and documents are automatically downloaded to `.whatsapp/inbox/` inside your project directory (max 50 MB per file). The file path is included in the notification so Claude can read or reference it.

### Voice transcription (optional)

By default, voice messages arrive as `[Voice message received]` with the audio file saved. To enable automatic local transcription:

```
/whatsapp:configure audio
```

This installs a local Whisper model (~77MB, runs entirely on your machine — no API keys needed). Voice messages will be automatically transcribed to text within a few seconds — no restart needed.

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

Disable with `/whatsapp:configure audio off`.

## Going further

### Autonomous mode + web browsing

For a fully autonomous agent that doesn't ask permission for every action and can browse the web:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions --chrome
```

| Flag | What it does |
| --- | --- |
| `--dangerously-skip-permissions` | Agent executes tools without asking for confirmation |
| `--chrome` | Agent can browse the web and interact with pages |

### Computer use

Once the agent is running, type `/mcp` inside Claude Code and enable **computer use**. This lets the agent control your computer (click, type, take screenshots) — useful for tasks that go beyond chat.

### Using a WhatsApp number that's already on OpenClaw

If you have a WhatsApp number running an agent on [OpenClaw](https://github.com/openclaw/openclaw), you can try this plugin without losing anything. Just close OpenClaw (or stop that agent), scan the QR code here, and the number will work through Claude Code natively. When you're done, close Claude Code and reopen OpenClaw — your OpenClaw agent will reconnect and respond as before. Each platform re-links the WhatsApp session on startup, so they don't conflict — just don't run both at the same time on the same number.

### Multiple agents

Each agent folder has its own WhatsApp session and access control:

```
~/agent-sales/.whatsapp/     ← WhatsApp #1
~/agent-support/.whatsapp/   ← WhatsApp #2
```

Install the plugin in each folder with local scope and scan a separate QR code for each.

## Session & data

State is stored in `.whatsapp/` inside your project directory:

```
~/my-whatsapp-agent/.whatsapp/
├── auth/           # WhatsApp session keys
├── inbox/          # Downloaded media
├── approved/       # Pairing signals
├── access.json     # Access control
├── config.json     # Plugin settings (audio, language)
└── status.json     # Connection state
```

Reset with `/whatsapp:configure reset`.

## Troubleshooting

**Voice messages transcribe in the wrong language**
Set your language explicitly: `/whatsapp:configure audio es`. Without it, the model often defaults to English on short clips. Restart Claude after changing.

**Server didn't start (first launch)**
The first launch downloads dependencies (~60s). Run `/whatsapp:configure` — it waits automatically. If it still fails, close and reopen Claude with the channel flag.

**QR code expired**
Run `/whatsapp:configure` again — the server generates a fresh QR every ~20 seconds.

**WhatsApp disconnected**
Sessions can expire if you log out from your phone or WhatsApp revokes the link. Run `/whatsapp:configure reset` then `/whatsapp:configure` to scan a new QR.

**Voice transcription is slow**
The Whisper model runs on CPU. Short messages (< 30s) typically take 2-8 seconds. For faster results, ensure no heavy CPU tasks are running in parallel.

## Important

- **Unofficial API** — Baileys is not endorsed by WhatsApp. Use responsibly — no spam, no bulk messaging.
- **One linked device slot** — Unlink anytime from WhatsApp > Settings > Linked Devices.
- **No message history** — Only sees messages as they arrive. Cannot fetch older messages.

## Disclaimer

This project is not affiliated with, endorsed by, or associated with WhatsApp, Meta, or Anthropic. WhatsApp is a trademark of Meta Platforms, Inc. Claude is a trademark of Anthropic, PBC. This plugin uses the unofficial Baileys library for WhatsApp Web connectivity.
