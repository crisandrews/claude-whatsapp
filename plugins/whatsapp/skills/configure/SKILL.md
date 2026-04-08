---
name: configure
description: Set up the WhatsApp channel connection. Use 'connect <phone>' to connect via pairing code, or 'reset' to clear the session.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__whatsapp__connect
---

# WhatsApp Configure

You are helping the user configure the WhatsApp channel plugin for Claude Code.

## What to do

The WhatsApp plugin uses Baileys to connect directly to WhatsApp Web. No bot token or API key is needed.

### Connect with phone number (recommended)

If the user runs `/whatsapp:configure connect <phone_number>`:

1. Use the `connect` MCP tool with the provided phone number (include country code, e.g. +56912345678)
2. The tool will return an 8-digit pairing code
3. Tell the user to:
   - Open WhatsApp on their phone
   - Go to Settings > Linked Devices > Link a Device
   - Tap "Link with phone number instead"
   - Enter their phone number
   - Enter the 8-digit pairing code

### Check status

If the user runs `/whatsapp:configure` with no arguments:

1. Check if auth state exists at `~/.claude/channels/whatsapp/auth/creds.json`
2. Check if access.json exists at `~/.claude/channels/whatsapp/access.json`
3. Report the current state:
   - Whether a WhatsApp session is configured (auth files exist)
   - The current DM policy (from access.json)
   - How many users are in the allowlist
4. If not connected, tell the user to run `/whatsapp:configure connect <phone_number>`

### Reset session

If the user runs `/whatsapp:configure reset`:

1. Delete the auth directory at `~/.claude/channels/whatsapp/auth/`
2. Recreate it empty
3. Tell the user they can reconnect with `/whatsapp:configure connect <phone_number>`

### QR code fallback

A QR code image is also generated automatically at `~/.claude/channels/whatsapp/qr.png` and opened with the system image viewer. The user can scan it with WhatsApp if they prefer.

## Important

- The auth state at `~/.claude/channels/whatsapp/auth/` contains sensitive session keys. Never display their contents.
- WhatsApp Web sessions can expire. If the connection drops with a "logged out" status, the auth will be auto-cleared and reconnection will be needed.
