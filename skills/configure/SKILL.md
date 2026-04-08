---
name: configure
description: Set up the WhatsApp channel connection. Run without arguments to see current status, or use 'reset' to clear the session and re-scan the QR code.
allowed-tools:
  - Bash
  - Read
  - Write
---

# WhatsApp Configure

You are helping the user configure the WhatsApp channel plugin for Claude Code.

## What to do

The WhatsApp plugin uses Baileys to connect directly to WhatsApp Web via QR code scanning. No bot token or API key is needed.

### Check status

If the user runs `/whatsapp:configure` with no arguments:

1. Check if auth state exists at `~/.claude/channels/whatsapp/auth/creds.json`
2. Check if access.json exists at `~/.claude/channels/whatsapp/access.json`
3. Report the current state:
   - Whether a WhatsApp session is configured (auth files exist)
   - The current DM policy (from access.json)
   - How many users are in the allowlist

### Reset session

If the user runs `/whatsapp:configure reset`:

1. Delete the auth directory at `~/.claude/channels/whatsapp/auth/`
2. Recreate it empty
3. Tell the user to restart Claude Code with `claude --channels plugin:whatsapp` to scan a new QR code

### First-time setup

If no auth state exists, guide the user:

1. Start Claude Code with: `claude --channels plugin:whatsapp`
2. A QR code will appear in the terminal
3. Open WhatsApp on your phone > Settings > Linked Devices > Link a Device
4. Scan the QR code
5. Once connected, anyone who messages will receive a pairing code
6. Use `/whatsapp:access pair <code>` to approve them

## Important

- The auth state at `~/.claude/channels/whatsapp/auth/` contains sensitive session keys. Never display their contents.
- WhatsApp Web sessions can expire. If the connection drops with a "logged out" status, the auth will be auto-cleared and a new QR scan will be needed.
