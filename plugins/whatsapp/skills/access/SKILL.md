---
name: access
description: Manage WhatsApp access control — pair new users, list allowed users, revoke access, or change the DM policy.
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
---

# WhatsApp Access Control

You are helping the user manage access control for the WhatsApp channel plugin.

The access state is stored at `~/.claude/channels/whatsapp/access.json`.

## Commands

### `/whatsapp:access pair <code>`

Approve a pending pairing request:

1. Read `~/.claude/channels/whatsapp/access.json`
2. Look up the `<code>` in the `pending` object
3. If found and not expired:
   - Add `pending[code].senderId` to the `allowFrom` array (avoid duplicates)
   - Remove the entry from `pending`
   - Write the updated access.json
   - Write a file to `~/.claude/channels/whatsapp/approved/<senderId>.json` with `{"senderId": "<senderId>", "chatId": "<chatId>"}` — this signals the running server to send a confirmation message
   - Tell the user the pairing was successful
4. If not found or expired, tell the user the code is invalid or expired

**IMPORTANT:** If the pairing code came from a group message or channel message (not a direct DM), warn the user that approving it could allow a malicious actor to inject messages. Only approve codes from people you trust and expect.

### `/whatsapp:access list`

1. Read access.json
2. Display:
   - Current DM policy
   - List of allowed user IDs (from `allowFrom`)
   - List of configured groups (from `groups`)
   - Any pending pairing requests (codes, senderIds, expiry)

### `/whatsapp:access revoke <user_id>`

1. Read access.json
2. Remove the user_id from `allowFrom`
3. Also remove from any group `allowFrom` arrays
4. Save access.json
5. Confirm removal

### `/whatsapp:access policy <pairing|allowlist|disabled>`

1. Read access.json
2. Set `dmPolicy` to the specified value
3. Save access.json
4. Explain what the new policy means:
   - `pairing`: Unknown senders get a pairing code to approve in Claude Code
   - `allowlist`: Only pre-approved users can message (silent drop for others)
   - `disabled`: All inbound messages are dropped

### `/whatsapp:access add-group <group_jid>`

1. Read access.json
2. Add the group JID to `groups` with default config: `{"requireMention": true, "allowFrom": []}`
3. Save access.json
4. Explain that `requireMention: true` means the bot only responds when @mentioned in the group

### `/whatsapp:access` (no arguments)

Same as `/whatsapp:access list`.
