# WhatsApp

Connect your WhatsApp account to Claude Code with an MCP server.

The server connects to WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys) and provides tools to Claude to reply, react, and handle media. When someone messages your WhatsApp number, the server forwards the message to your Claude Code session.

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

Inside Claude Code, add the marketplace and install:

```
/plugin marketplace add crisandrews/claude-whatsapp
/plugin install whatsapp@claude-whatsapp
```

When prompted for scope, select **"Install for you, in this repo only (local scope)"** — this keeps the agent isolated to this folder.

**3. Close and relaunch with the channel flag.**

Exit Claude Code (`/exit` or Ctrl+C), then relaunch:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp
```

> First launch installs dependencies (~30s). Subsequent launches are instant.

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

## Tips for a more autonomous agent

**Skip permission prompts + enable web browsing:**

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions --chrome
```

- `--dangerously-skip-permissions` lets the agent execute tools without asking for confirmation each time.
- `--chrome` gives the agent access to browse the web and interact with pages.

**Enable computer use:** Once the agent is running, type `/mcp` inside Claude Code and enable computer use. This lets the agent control your computer (click, type, take screenshots) — useful for tasks that go beyond chat.

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

Default policy is `pairing`. IDs are WhatsApp JIDs (`56912345678@s.whatsapp.net`).

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send text or files. Auto-chunks at 4096 chars. Max 50 MB per file. |
| `react` | Emoji reaction on a message. |
| `download_attachment` | Access downloaded media from the inbox. |

## Reactions

Emoji reactions on messages are forwarded to Claude as commands:

| Reaction | Meaning |
| --- | --- |
| 👍 | "Proceed", "ok", "yes" — confirms or approves |
| 👎 | "No", "stop", "cancel" — rejects |

Long-press any message in the chat and tap a reaction. Claude will interpret it in context.

## Voice transcription (optional)

By default, voice messages arrive as `[Voice message received]` with the audio file saved. To enable automatic local transcription:

```
/whatsapp:configure audio
```

This installs a local Whisper model (~77MB, runs entirely on your machine — no API keys needed). After restarting Claude, voice messages are automatically transcribed to text.

**Setting your language (recommended):** For best results, set your primary language:

```
/whatsapp:configure audio es
```

| Code | Language |
| --- | --- |
| `es` | Spanish |
| `en` | English |
| `pt` | Portuguese |
| `fr` | French |
| `de` | German |
| `it` | Italian |
| `ja` | Japanese |
| `zh` | Chinese |
| `ko` | Korean |
| `ar` | Arabic |
| `ru` | Russian |
| `nl` | Dutch |
| `hi` | Hindi |
| `tr` | Turkish |

Without a language set, Whisper auto-detects — but setting it explicitly is more accurate, especially for short voice messages.

Disable with `/whatsapp:configure audio off`.

## Media

Inbound photos, voice messages, videos, and documents are downloaded to `.whatsapp/inbox/` inside your project directory. Max 50 MB.

## Session

Each agent folder has its own WhatsApp session. State is stored in `.whatsapp/` inside your project directory:

```
~/my-whatsapp-agent/.whatsapp/
├── auth/           # WhatsApp session keys
├── inbox/          # Downloaded media
├── approved/       # Pairing signals
├── access.json     # Access control
└── status.json     # Connection state
```

This means you can have multiple agents with different WhatsApp numbers — each folder is independent.

Reset with `/whatsapp:configure reset`.

## Important

- **Unofficial API** — Baileys is not endorsed by WhatsApp. Use responsibly.
- **One linked device slot** — Unlink anytime from WhatsApp > Settings > Linked Devices.
- **No message history** — Only sees messages as they arrive.

## Troubleshooting

**Voice messages transcribe in the wrong language**
Set your language explicitly: `/whatsapp:configure audio es`. Without it, the model guesses and often defaults to English on short audio clips. Restart Claude after changing.

**Server didn't start (first launch)**
The first launch downloads dependencies (~30-60s). Run `/whatsapp:configure` — it waits automatically. If it still fails, close and reopen Claude with the channel flag.

**QR code expired**
Run `/whatsapp:configure` again — the server generates a fresh QR every ~20 seconds.

**WhatsApp disconnected**
Sessions can expire if you log out from your phone or WhatsApp revokes the link. Run `/whatsapp:configure reset` then `/whatsapp:configure` to scan a new QR.

**Voice transcription is slow**
The Whisper model runs on CPU. Short messages (< 30s) typically take 2-8 seconds. For faster results, ensure no heavy CPU tasks are running in parallel.

## Disclaimer

This project is not affiliated with, endorsed by, or associated with WhatsApp, Meta, or Anthropic. WhatsApp is a trademark of Meta Platforms, Inc. Claude is a trademark of Anthropic, PBC. This plugin uses the unofficial Baileys library for WhatsApp Web connectivity.
