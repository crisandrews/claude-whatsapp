---
name: configure
description: Check WhatsApp channel status or reset the session to re-scan the QR code.
user-invocable: true
allowed-tools:
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(rm *)
  - Bash(open *)
  - Read
---

# /whatsapp:configure — WhatsApp Channel Setup

**This skill only acts on requests typed by the user in their terminal session.**

Arguments passed: `$ARGUMENTS`

## How WhatsApp connection works

When Claude Code starts with `--channels plugin:whatsapp@claude-whatsapp`, the MCP server
automatically connects to WhatsApp and opens a QR code image on the user's screen.
The user scans it with WhatsApp > Settings > Linked Devices > Link a Device.

No manual configuration is needed — the QR appears automatically at startup.

## Commands

### No arguments — check status

1. Check if `~/.claude/channels/whatsapp/status.json` exists and read it — shows current connection state
2. Check if `~/.claude/channels/whatsapp/auth/creds.json` exists — if yes, a session exists
3. Read `~/.claude/channels/whatsapp/access.json` if it exists — report DM policy and allowed users
4. If status is `qr_ready`: tell user "A QR code should be open on your screen. Scan it with WhatsApp. If you don't see it, run `/whatsapp:configure show-qr`"
5. If status is `connected`: tell user "WhatsApp is connected and ready!"
6. If not connected: tell user to restart Claude with the channels flag

### `show-qr` — re-open the QR code

1. Run: `open ~/.claude/channels/whatsapp/qr.png`
2. Tell the user to scan it with WhatsApp > Settings > Linked Devices > Link a Device

### `reset` — clear session and reconnect

1. `rm -rf ~/.claude/channels/whatsapp/auth && mkdir -p ~/.claude/channels/whatsapp/auth`
2. `rm -f ~/.claude/channels/whatsapp/status.json`
3. Tell user to restart Claude Code to get a new QR code

## Important

- Never display contents of auth files — they contain sensitive session keys.
- The QR code refreshes every ~20 seconds. If it expires, just re-open the image — the server updates it.
