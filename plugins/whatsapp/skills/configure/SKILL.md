---
name: configure
description: Connect WhatsApp by scanning a QR code. Run this after starting Claude with the whatsapp channel to set up your connection.
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

## Commands

### No arguments — open QR and connect

This is the main setup flow. Do these steps in order:

1. Check if `~/.claude/channels/whatsapp/status.json` exists and read it.

2. **If status is `connected`**: Tell the user "WhatsApp is already connected! People can message your number and Claude will respond." Then check `~/.claude/channels/whatsapp/access.json` and show DM policy and allowed users.

3. **If status is `qr_ready` or file doesn't exist**: Check if `~/.claude/channels/whatsapp/qr.png` exists.
   - If the QR file exists: Open it with `open ~/.claude/channels/whatsapp/qr.png` and tell the user:
     ```
     QR code opened! Scan it now with your phone:
     1. Open WhatsApp
     2. Settings > Linked Devices > Link a Device  
     3. Point your camera at the QR code on screen
     
     The QR refreshes automatically. If it expires, run /whatsapp:configure again.
     ```
   - If QR doesn't exist: Tell the user "The server is still starting up. Wait a few seconds and run `/whatsapp:configure` again."

4. **If status is `logged_out` or `reconnecting`**: Tell the user to run `/whatsapp:configure reset` and then `/whatsapp:configure` again.

### `reset` — clear session

1. `rm -rf ~/.claude/channels/whatsapp/auth && mkdir -p ~/.claude/channels/whatsapp/auth`
2. `rm -f ~/.claude/channels/whatsapp/status.json`
3. `rm -f ~/.claude/channels/whatsapp/qr.png`
4. Tell user: "Session cleared. Run `/whatsapp:configure` to scan a new QR code."

### `status` — check connection status only

1. Read `~/.claude/channels/whatsapp/status.json` and report the current state.
2. Read `~/.claude/channels/whatsapp/access.json` if it exists — report DM policy and allowed users count.

## Important

- Never display contents of auth files — they contain sensitive session keys.
- The QR code refreshes every ~20 seconds. The server overwrites `qr.png` each time.
- After scanning successfully, the status changes to `connected` and `qr.png` is deleted.
