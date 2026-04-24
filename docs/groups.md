# Groups

Everything you need to add the bot to a WhatsApp group, decide who in the group can talk to it, and switch the policy later. The plugin treats groups as fully independent from DMs — see [Group access vs DM access](#group-access-vs-dm-access) at the bottom.

- [Quick reference](#quick-reference)
- [Group admin from Claude](#group-admin-from-claude)
- [The four policies](#the-four-policies)
- [Worked examples](#worked-examples)
- [Discovery flow](#discovery-flow)
- [Member discovery](#member-discovery)
- [Switching policies](#switching-policies)
- [Removing a group](#removing-a-group)
- [Edge cases & gotchas](#edge-cases--gotchas)
- [Group access vs DM access](#group-access-vs-dm-access)

---

## Quick reference

| Command | Effect |
|---|---|
| `/whatsapp:access add-group <jid>` | Allow a group, mention-only (default). |
| `/whatsapp:access add-group <jid> --no-mention` | Allow a group, open delivery. |
| `/whatsapp:access group-allow <group-jid> <member-jid>` | Restrict the group to specific members. |
| `/whatsapp:access group-revoke <group-jid> <member-jid>` | Remove a member from the group's whitelist. |
| `/whatsapp:access remove-group <jid>` | Stop accepting messages from the group entirely. |
| `/whatsapp:access` | List configured groups + recently dropped (unknown) groups. |

## Group admin from Claude

Beyond the access skill commands above (which the **user** runs in their terminal to gate which groups can talk to the bot), Claude itself has MCP tools to **read and mutate** groups it's already admin of. Per-tool reference with arguments and pitfalls in [docs/tools.md](tools.md).

| Tool | What it does |
|---|---|
| `get_group_metadata` | Live participant list, admin flags, settings (announce / restrict / ephemeral). |
| `list_group_senders` | Participants who have spoken in the group (from local SQLite, with push names). Complements `get_group_metadata` (which lists all current members regardless of activity). |
| `create_group` | Create a new group. Bot becomes super admin. Auto-registers in `access.groups` open mode. |
| `join_group` | Join a group via invite code or full `chat.whatsapp.com/<code>` URL. Auto-registers. |
| `leave_group` | Bot leaves the group; auto-removes the entry from `access.groups`. |
| `update_group_subject` | Rename the group. Bot must be admin. |
| `update_group_description` | Update or clear the group description. |
| `update_group_settings` | Toggle `admins_only_messages` (announcement mode) and `admins_only_info` (locked mode). |
| `add_participants` | Add user JIDs to the group. Returns per-participant status (success / not-found / already-in / permission-denied). |
| `remove_participants` | Remove user JIDs. Same status reporting. |
| `promote_admins` / `demote_admins` | Change admin status. |
| `toggle_group_ephemeral` | Set or clear the disappearing-messages timer (24h / 7d / 30d / off). |
| `handle_join_request` | List, approve, or reject pending join requests for groups with restricted-add. |
| `get_invite_code` / `revoke_invite_code` | Read or rotate the group invite link. |

All group admin tools require the group to be in `access.groups` (use `add-group` first), and require the bot to be an admin of the group — Baileys propagates a clean error otherwise.

Group state is stored in `<channel-dir>/access.json` under the `groups` field:

```json
{
  "groups": {
    "120363xxxxxxxxx@g.us": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

`requireMention` controls whether the bot needs to be @-mentioned (or quote-replied to) for a message to reach Claude. `allowFrom` is empty for "anyone in the group can trigger" or a list of JIDs for "only these members".

---

## The four policies

Every group can be in exactly one of these four states. Pick by combining `--no-mention` (or its absence) on `add-group` with whether you call `group-allow` afterwards.

| Policy | `requireMention` | `allowFrom` | Effect |
|---|---|---|---|
| **Open** | `false` | `[]` | Every message from any group member reaches Claude. |
| **Mention-only (everyone)** | `true` | `[]` | Anyone in the group can trigger Claude, but only when they @-mention the bot or quote-reply one of its prior messages. |
| **Restricted, open** | `false` | `[<member-jid>, …]` | Only listed members can trigger Claude; their messages always reach it. Other members are silently dropped. |
| **Restricted, mention-only** | `true` | `[<member-jid>, …]` | Only listed members can trigger Claude, AND they must @-mention the bot or quote-reply. Most restrictive. |

> **Default**: `add-group <jid>` with no flags creates **mention-only (everyone)** — `requireMention: true`, `allowFrom: []`.

---

## Worked examples

Each scenario walks through the full setup end to end. Assume the bot's WhatsApp is already linked (`/whatsapp:configure` shows `connected`).

### Scenario A — Open community group

> Use case: a small focused team chat where the agent is a participant and should respond to every message, no @-mention required.

1. **WhatsApp side**: open the group → **Group info** → **Add participant** → pick the contact you saved for the bot's number.
2. **Trigger one message** in the group from any member — say "hi". The plugin sees it but drops it (the group isn't configured yet) and records the JID under "recently dropped groups".
3. **In Claude Code**:
   ```
   /whatsapp:access
   ```
   The bottom of the output now shows a "Recently dropped groups" section with a copy-paste command. Run it with `--no-mention`:
   ```
   /whatsapp:access add-group 120363xxxxxxxxx@g.us --no-mention
   ```
4. From now on, every message in that group reaches Claude.

### Scenario B — Active group with mention-only

> Use case: a busy group where the agent should only chime in when called.

1. WhatsApp side: same as Scenario A (add the bot's number to the group).
2. Trigger one message; run `/whatsapp:access` to find the JID.
3. Allow it WITHOUT `--no-mention` (mention-only is the default):
   ```
   /whatsapp:access add-group 120363xxxxxxxxx@g.us
   ```
4. From now on, only messages that @-mention the bot or quote-reply one of its messages reach Claude. The rest are silently dropped.

### Scenario C — Owner-only with mention required

> Use case: a group where the agent should respond only to one specific person (e.g. you, the maintainer), and only when explicitly @-mentioned.

1. Steps 1–3 of Scenario B (add the group as mention-only).
2. Find the owner's member JID. Either:
   - Ask Claude in plain English: *"who's been talking in `120363xxxxxxxxx@g.us`?"* — Claude calls the `list_group_senders` tool and returns each participant's push name + JID.
   - Or, look at any message they've sent: it shows up in `<channel-dir>/logs/conversations/YYYY-MM-DD.md` with their JID.
3. Whitelist that one member:
   ```
   /whatsapp:access group-allow 120363xxxxxxxxx@g.us 5491155556666@s.whatsapp.net
   ```
4. From now on, only messages from that specific JID that ALSO @-mention the bot reach Claude. Anyone else's messages — and that one person's messages without a mention — are dropped.

### Scenario D — Owner-only, open delivery

> Use case: a group where the agent should respond only to one specific person, but to every message that person sends (no mention required).

1. Add the group as **open** (with `--no-mention`):
   ```
   /whatsapp:access add-group 120363xxxxxxxxx@g.us --no-mention
   ```
2. Restrict to the one member:
   ```
   /whatsapp:access group-allow 120363xxxxxxxxx@g.us 5491155556666@s.whatsapp.net
   ```
3. From now on, every message from that one JID reaches Claude. Other members' messages are silently dropped.

---

## Discovery flow

The hard part of group setup is finding the **group JID** in the first place. WhatsApp doesn't show you JIDs in its UI — they look like `120363xxxxxxxxx@g.us` and the only way to learn them is to see them in incoming traffic. The plugin makes this painless:

1. **Add the bot to the group via WhatsApp**. Use either WhatsApp on your phone (Group info → Add participant) or any other WhatsApp client.
2. **One person sends a message in the group**. Anything works — "hi", a sticker, anything.
3. **The plugin sees it, drops it, and records it**. The group isn't allowed yet, so the message doesn't reach Claude. But the plugin writes a record to `<channel-dir>/recent-groups.json` with:
   - The group JID
   - First-seen and last-seen timestamps
   - A drop counter (so you can see how chatty the group is)
   - The most recent sender's push name (to help you recognize the chat)
4. **Run `/whatsapp:access`**. The bottom of the output now includes a **"Recently dropped groups"** section listing each unknown group with:
   - Its JID
   - The most recent sender's push name (e.g. "Juan")
   - How many messages have been dropped from it
   - A copy-pasteable command suggestion
5. **Run the suggested command**, optionally with `--no-mention` if you want open delivery (Scenario A or D).

The recent-groups list is bounded to the 50 most recently active groups (LRU). When you `add-group` a JID, it's removed from the list (it's no longer "unknown"). When you `remove-group` a JID, the next message from it will reappear in the list.

> **Tail the system log if you prefer**: `tail -f <channel-dir>/logs/system.log` shows a one-per-minute hint per unknown group with the same JID + suggested command. Same information, real-time.

---

## Member discovery

Once a group is allowed, you sometimes want to whitelist only specific people in it (Scenarios C and D). To find their JIDs without copying random strings out of a log file, ask Claude:

> *"Who's been talking in `120363xxxxxxxxx@g.us`?"*

Claude calls the `list_group_senders` MCP tool, which queries the local message store (`<channel-dir>/messages.db`) for distinct senders in that chat. The response looks like:

```
3 senders in 120363xxxxxxxxx@g.us:

• Juan — `5491155556666@s.whatsapp.net` — 42 messages, last at 2026-04-19T20:14:00.000Z
• Maria — `5491166667777@s.whatsapp.net` — 18 messages, last at 2026-04-19T19:55:00.000Z
• Pedro — `5491177778888@lid` — 7 messages, last at 2026-04-19T18:12:00.000Z
```

Pick whose JID you want to allow and run `group-allow <group-jid> <member-jid>`.

Optional: scope to a recent window — *"who's been talking in this group in the last 7 days?"* — Claude passes `since_days: 7` to the tool.

The store only contains messages the plugin has actually seen (delivered + outbound + history backfills). If a member has never sent a message during a session, they won't appear. To populate older messages, ask Claude to *"pull older messages from this chat"* — that triggers `fetch_history`.

---

## Switching policies

The configuration is overridden every time you re-run `add-group` or `group-allow`/`group-revoke`. There's no "reset" — just run the command for the policy you want.

**Flip mention setting**: re-run `add-group` with or without `--no-mention`. The whitelist (`allowFrom`) is preserved.

```
/whatsapp:access add-group 120363xxxxxxxxx@g.us --no-mention
# Group goes from mention-only to open, allowFrom unchanged.
```

**Add another whitelisted member**: run `group-allow` again with a different member JID. Append-only.

```
/whatsapp:access group-allow 120363xxxxxxxxx@g.us 5491177778888@s.whatsapp.net
```

**Open the group back up to everyone**: revoke each whitelisted member until `allowFrom` is empty. The plugin tells you when the list went empty and the group is back to "anyone in the group can trigger".

```
/whatsapp:access group-revoke 120363xxxxxxxxx@g.us 5491155556666@s.whatsapp.net
```

---

## Removing a group

```
/whatsapp:access remove-group 120363xxxxxxxxx@g.us
```

Deletes the group entry entirely. Subsequent messages from that group will be dropped and re-recorded under "Recently dropped groups" — same flow as adding it for the first time.

To stop the bot from being IN the group on the WhatsApp side, you have to remove it from the group via WhatsApp itself (the plugin doesn't manage WhatsApp group membership today; that's on the roadmap as group admin tools).

---

## Edge cases & gotchas

**The group never shows up in "Recently dropped groups".**
- No one has sent a message yet. Nudge a member to say something.
- The bot was kicked from the group before the first message arrived. Re-add it on the WhatsApp side.

**A specific member's mention isn't being detected.**
- Their client may be addressing the message in `@lid` mode while the bot's identity is captured as `@s.whatsapp.net` (or vice versa). The plugin maintains a LID↔phone resolution cache populated from per-message hints — the first one or two of their messages may drop while the cache fills, then mention detection works normally.
- If the issue persists, re-run `add-group` with `--no-mention` to test that messages flow at all, then go back to mention-only.

**`requireMention: true` but a quote-reply isn't triggering Claude.**
- The reply must quote a message Claude SENT (i.e. `fromMe: true` in WhatsApp's terms). A reply to another participant's message doesn't count, even if the bot was mentioned in that earlier message.

**The group is in `allowFrom`-restricted mode but the allowed person's mention isn't received.**
- Per-group `allowFrom` and `requireMention` are AND-combined. Both must pass. If the person sends without a mention in a mention-only group, their message drops even though they're whitelisted.

**A user removed from the group still appears in `list_group_senders`.**
- The local store records messages they sent while they were in the group; it doesn't auto-prune on group leave. Their JID will simply not generate new messages going forward.

**Multiple bots / clients fighting for the same group.**
- WhatsApp Web allows only one device per credentials. If you run two instances of the plugin against the same WhatsApp number, they'll knock each other off (status 440). Run only one instance per number.

---

## Group access vs DM access

This is the most common confusion. The two systems are **independent**.

|  | DMs | Groups |
|---|---|---|
| Who decides | `dmPolicy` (`pairing` / `allowlist` / `disabled`) and `allowFrom` | per-group `groups[<jid>]` config (`requireMention`, `allowFrom`) |
| Default | `pairing` (unknown senders get a pairing code) | drop everything from groups not in `groups{}` |
| Effect of pairing | Adds JID to global `allowFrom`. The user can DM the bot from now on. | None. Pairing for DM does NOT auto-allow the user in any group. |
| Effect of `group-allow` | None. Whitelisting a member in a group does NOT let them DM the bot. | Adds the JID to that one group's `allowFrom` so they can trigger Claude in that group. |

**Two consequences worth burning into memory**:

- Allowing someone in a group does NOT let them DM the bot. To DM, that person still has to pair separately (or be added with `/whatsapp:access allow <jid>`).
- Adding the bot to a group does NOT auto-allow your DM contacts who happen to be in the group. You opt the bot into each group explicitly.

If you want the same person to be able to BOTH DM the bot AND trigger it in a specific group, you do both:

```
/whatsapp:access allow 5491155556666@s.whatsapp.net          # lets them DM
/whatsapp:access add-group 120363xxxxxxxxx@g.us              # allows the group (mention-only)
/whatsapp:access group-allow 120363xxxxxxxxx@g.us 5491155556666@s.whatsapp.net   # restricts the group to them
```
