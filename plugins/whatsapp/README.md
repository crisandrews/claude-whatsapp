# WhatsApp

Connect your WhatsApp account to Claude Code with an MCP server.

The MCP server connects to WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys) and provides tools to Claude to reply, react, and handle media. When someone messages your WhatsApp number, the server forwards the message to your Claude Code session.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+ — the MCP server runs on Node. Install from nodejs.org or via `brew install node`.

## Quick Setup

> Default pairing flow for a single-user DM bot. See `/whatsapp:access` for groups and multi-user setups.

**1. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Add the marketplace and install:

```
/plugin marketplace add crisandrews/claude-whatsapp
/plugin install whatsapp@claude-whatsapp
```

**2. Launch with the channel flag.**

Exit your session and start a new one with the channel enabled:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp
```

> The first launch installs dependencies (~30 seconds). Subsequent launches are instant.

**3. Scan the QR code.**

In your Claude Code session, run:

```
/whatsapp:configure
```

The skill waits for the server to be ready, then opens a QR code image on your screen. Scan it with your phone:

1. Open **WhatsApp**
2. Go to **Settings > Linked Devices > Link a Device**
3. Point your camera at the QR code

Once scanned, the session is saved — you won't need to scan again unless you log out or the session expires.

> The QR refreshes every ~20 seconds. If it expires, run `/whatsapp:configure` again.

**4. Pair.**

With Claude Code running from the previous step, send a message to your WhatsApp number from another phone — the bot replies with a 6-character pairing code. In your Claude Code session:

```
/whatsapp:access pair <code>
```

Your next message reaches the assistant.

**5. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies:

```
/whatsapp:access policy allowlist
```

## Access control

Managed via the `/whatsapp:access` skill. Quick reference:

| Command | Description |
| --- | --- |
| `/whatsapp:access` | List allowed users, pending pairings, and current policy |
| `/whatsapp:access pair <code>` | Approve a pending pairing request |
| `/whatsapp:access deny <code>` | Reject a pending pairing request |
| `/whatsapp:access allow <jid>` | Add a user directly to the allowlist |
| `/whatsapp:access revoke <jid>` | Remove a user from the allowlist |
| `/whatsapp:access policy <mode>` | Set DM policy: `pairing`, `allowlist`, or `disabled` |
| `/whatsapp:access add-group <jid>` | Allow a WhatsApp group |
| `/whatsapp:access remove-group <jid>` | Remove a WhatsApp group |

IDs are WhatsApp JIDs: `<countrycode><number>@s.whatsapp.net` (e.g. `56912345678@s.whatsapp.net`). Default policy is `pairing`.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` for quoting and `file_path` for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos; other types send as documents. Auto-chunks text over 4096 characters. Max 50 MB per file. |
| `react` | Add an emoji reaction to a message by ID. Any emoji works. |
| `download_attachment` | Access a media file that was downloaded from a received message. Only files inside the inbox are accessible. |

## Media

Inbound photos, voice messages, videos, documents, and audio are automatically
downloaded to `~/.claude/channels/whatsapp/inbox/` and the local path is included
in the channel notification so the assistant can read the file. Max file size: 50 MB.

## WhatsApp formatting

WhatsApp uses its own formatting — not Markdown:

- `*bold*`, `_italic_`, `~strikethrough~`, `` ```code blocks``` ``
- No clickable link syntax — URLs are pasted directly

## Session persistence

Your WhatsApp Web session is saved in `~/.claude/channels/whatsapp/auth/`. As long
as this directory is intact, you stay connected without rescanning. If WhatsApp logs
you out (e.g. from your phone), the session clears automatically — run
`/whatsapp:configure` to scan a new QR.

To manually reset: `/whatsapp:configure reset`

## No history or search

WhatsApp Web only sees messages as they arrive — the assistant cannot fetch older
messages. If it needs earlier context, it will ask you to paste or summarize.

Photos and documents are downloaded eagerly on arrival since there's no way to
fetch them later.

## Important notes

- **Unofficial API** — Baileys is not officially endorsed by WhatsApp. Use responsibly — no spam, no bulk messaging.
- **One session per slot** — Linking this replaces one of your Linked Devices slots (up to 4). You can unlink it from your phone at any time via Settings > Linked Devices.
- **Security** — Access state (`access.json`) is written with restricted permissions (0600). Auth credentials and channel state files cannot be sent as attachments. Filenames from inbound media are sanitized to prevent path traversal.
