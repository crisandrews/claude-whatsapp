# WhatsApp Channel Plugin for Claude Code

A WhatsApp messaging bridge for Claude Code, using [Baileys](https://github.com/WhiskeySockets/Baileys) for direct WhatsApp Web connectivity. Scan a QR code and chat with Claude through WhatsApp.

## Setup

### Prerequisites

- [Bun](https://bun.sh) runtime installed
- A WhatsApp account on your phone

### Installation

```bash
# Install the plugin
claude plugin install whatsapp

# Or from this repository
claude plugin install whatsapp@<your-github-org>
```

### Connect

```bash
# Start Claude Code with the WhatsApp channel
claude --channels plugin:whatsapp
```

A QR code will appear in the terminal. Scan it with your phone:
1. Open WhatsApp
2. Go to **Settings > Linked Devices > Link a Device**
3. Scan the QR code

### Pairing

Once connected, anyone who messages your WhatsApp number will receive a 6-character pairing code. To approve them:

```
/whatsapp:access pair <code>
```

## Skills

| Skill | Description |
|-------|-------------|
| `/whatsapp:configure` | Check connection status or reset the session |
| `/whatsapp:access` | Manage access control (pair, list, revoke, policy) |

## Access Control

The plugin supports three DM policies:

- **pairing** (default): Unknown senders receive a pairing code. Approve in Claude Code to allow them.
- **allowlist**: Only pre-approved users can message. Others are silently dropped.
- **disabled**: All inbound messages are dropped.

```
/whatsapp:access policy pairing    # default
/whatsapp:access policy allowlist  # strict
/whatsapp:access policy disabled   # off
```

## Architecture

This plugin follows the same architecture as the official [Telegram plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram):

- **MCP Server** on stdio with `claude/channel` experimental capability
- **Baileys** for WhatsApp Web WebSocket connection (no browser needed)
- **Inbound**: Messages arrive via Baileys events, forwarded to Claude via `notifications/claude/channel`
- **Outbound**: Claude uses `reply`, `react`, and `download_attachment` MCP tools
- **Access control**: File-based (JSON) with pairing flow
- **Session persistence**: Multi-file auth state in `~/.claude/channels/whatsapp/auth/`

## Tools

| Tool | Description |
|------|-------------|
| `reply` | Send text or files to a WhatsApp chat (auto-chunks at 4096 chars) |
| `react` | Add emoji reaction to a message |
| `download_attachment` | Download media from a received message |

## File Structure

```
~/.claude/channels/whatsapp/
├── auth/               # Baileys session keys (auto-generated)
├── inbox/              # Downloaded media files
├── approved/           # Pairing approval signals
└── access.json         # Access control state
```

## Important Notes

- **Unofficial API**: Baileys is not officially supported by WhatsApp. Use responsibly.
- **Session expiry**: WhatsApp Web sessions can expire. If disconnected, a new QR scan may be needed.
- **One session**: Only one WhatsApp Web session can be active per phone number at a time (this replaces any existing linked device in that slot).

## License

Apache 2.0
