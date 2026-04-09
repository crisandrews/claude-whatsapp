# WhatsApp

Connect your WhatsApp account to Claude Code with an MCP server.

The server connects to WhatsApp Web via [Baileys](https://github.com/WhiskeySockets/Baileys) and provides tools to Claude to reply, react, and handle media. When someone messages your WhatsApp number, the server forwards the message to your Claude Code session.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+

## Quick Setup

**1. Install the plugin.**

```
/plugin marketplace add crisandrews/claude-whatsapp
/plugin install whatsapp@claude-whatsapp
```

**2. Launch with the channel flag.**

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp
```

> First launch installs dependencies (~30s). Subsequent launches are instant.

**3. Scan the QR code.**

```
/whatsapp:configure
```

Opens a QR code on your screen. Scan it with WhatsApp > **Settings > Linked Devices > Link a Device**.

Session is saved — you won't need to scan again unless you log out.

**4. Pair.**

Message your WhatsApp number from another phone. It replies with a 6-character code. In Claude Code:

```
/whatsapp:access pair <code>
```

**5. Lock it down.**

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

Default policy is `pairing`. IDs are WhatsApp JIDs (`56912345678@s.whatsapp.net`).

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send text or files. Auto-chunks at 4096 chars. Max 50 MB per file. |
| `react` | Emoji reaction on a message. |
| `download_attachment` | Access downloaded media from the inbox. |

## Media

Inbound photos, voice messages, videos, and documents are downloaded to `~/.claude/channels/whatsapp/inbox/`. Max 50 MB.

## Session

Saved in `~/.claude/channels/whatsapp/auth/`. Reset with `/whatsapp:configure reset`.

## Important

- **Unofficial API** — Baileys is not endorsed by WhatsApp. Use responsibly.
- **One linked device slot** — Unlink anytime from WhatsApp > Settings > Linked Devices.
- **No message history** — Only sees messages as they arrive.
