---
name: configure
description: Set up the WhatsApp channel connection. Use 'connect <phone>' to connect via pairing code, or 'reset' to clear the session.
user-invocable: true
allowed-tools:
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(rm *)
  - Read
  - Write
---

# /whatsapp:configure — WhatsApp Channel Setup

**This skill only acts on requests typed by the user in their terminal session.**

## Commands

### `/whatsapp:configure connect <phone_number>`

Connect to WhatsApp using a pairing code. The phone number must include the country code (e.g. +56912345678).

Steps:
1. Write the file `~/.claude/channels/whatsapp/connect.json` with content: `{"phoneNumber": "<phone_number>"}`
2. Tell the user: "Requesting pairing code for <phone_number>... Watch for a channel message with your 8-digit code. When it appears, open WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead, and enter the code."

That's it. The running MCP server will detect the file, request the pairing code from WhatsApp, and send it back as a channel message.

### `/whatsapp:configure` (no arguments)

Check current status:
1. Check if `~/.claude/channels/whatsapp/auth/creds.json` exists — if yes, a session is configured
2. Read `~/.claude/channels/whatsapp/access.json` if it exists — report the DM policy and number of allowed users
3. If not connected, tell the user to run `/whatsapp:configure connect <phone_number>`

### `/whatsapp:configure reset`

1. Delete `~/.claude/channels/whatsapp/auth/` directory
2. Recreate it empty: `mkdir -p ~/.claude/channels/whatsapp/auth`
3. Tell the user they can reconnect with `/whatsapp:configure connect <phone_number>`

## Important

- Never display the contents of auth files — they contain sensitive session keys.
- A QR code image is also auto-generated at `~/.claude/channels/whatsapp/qr.png` and opened with the system image viewer as a fallback.
