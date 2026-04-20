# Permission relay

When Claude Code wants to run a tool that requires user approval (a Bash command, an Edit, a Write, …), the permission dialog can be relayed to your phone over WhatsApp. You approve from anywhere — react 👍 on the prompt or reply `yes <id>` — and Claude proceeds. The terminal-side dialog stays active throughout, so you can still approve locally; whichever side responds first wins.

- [How it works](#how-it-works)
- [What you see on WhatsApp](#what-you-see-on-whatsapp)
- [How to respond](#how-to-respond)
- [Tool-specific previews](#tool-specific-previews)
- [Restrictions](#restrictions)
- [Failure modes](#failure-modes)
- [Disabling the relay](#disabling-the-relay)
- [Worked examples](#worked-examples)
- [Protocol details](#protocol-details)

---

## How it works

```
                              permission_request
                                    notification
       ┌──────────────────┐  ───────────────────►  ┌──────────────┐
       │  Claude Code     │                        │   plugin     │
       │  (terminal)      │  ◄───────────────────  │   server     │
       └──────────────────┘    permission decision └──────────────┘
                                    notification        │  ▲
                                                        │  │
                                       broadcast prompt │  │ approve / deny
                                       (DM only)        ▼  │
                                                  ┌─────────────────┐
                                                  │  WhatsApp users │
                                                  │  on allowlist   │
                                                  └─────────────────┘
```

1. Claude Code emits a `notifications/claude/channel/permission_request` notification with `{request_id, tool_name, description, input_preview}`. The `request_id` is 5 lowercase letters from the alphabet `a-z` minus `l`.
2. The plugin formats a prompt and broadcasts it to every allowlisted DM contact (skipping groups). The same `request_id` is included so the user can reference the exact pending request.
3. The user responds (text or reaction). The plugin emits `notifications/claude/channel/permission` with `{request_id, behavior: "allow" | "deny"}` back to Claude Code.
4. Claude Code resolves the pending dialog — same effect as approving in the terminal. The terminal prompt clears.

If nobody responds within 5 minutes, the pending entry is cleared and the terminal dialog stays open. If you approve in the terminal first, late WhatsApp responses are silently ignored.

---

## What you see on WhatsApp

The prompt looks like this (plain Bash example):

```
🔐 Claude wants to run *Bash*
List files in /tmp
```
ls -la /tmp
```

Reply *yes abcde* / *no abcde* or react 👍 / 👎.
```

The first line is the tool name in bold. The second line is the human-readable description Claude Code provides. The third block is a tool-specific preview (see [Tool-specific previews](#tool-specific-previews) below). The fourth line is the `request_id` plus instructions.

Each pending request is independent — you can approve one and deny another.

---

## How to respond

Two equivalent paths.

### Reaction

Long-press the prompt message and react with one of:

| Reaction | Decision |
|---|---|
| 👍 / ✅ | Approve |
| 👎 / ❌ | Deny |

Skin-tone variants of 👍 and 👎 also work (`👍🏻` … `👍🏿`).

### Text reply

Send a message in the same DM:

```
yes abcde
no abcde
y abcde
n abcde
YES ABCDE        ← case-insensitive (mobile autocaps fine)
```

Format: `(y|yes|n|no) <id>`. Whitespace tolerated. The `<id>` is the 5-letter code from the prompt (lowercase preferred but case is normalized).

Other text in the same DM is forwarded to Claude as normal — the parser only consumes messages that match the exact pattern AND reference an active pending request.

---

## Tool-specific previews

The plugin extracts a friendly highlight from the request's `input_preview` instead of dumping raw JSON, so prompts read at a glance on a phone.

| Tool | Preview shape |
|---|---|
| `Bash`, `BashOutput` | The command in a code block. |
| `Edit`, `Write`, `MultiEdit` | `📄 <file_path>` highlight + the JSON preview in a code block (so you see what's being changed). |
| `NotebookEdit` | `📓 <notebook_path>` highlight + JSON preview. |
| `Read` | `👁 <file_path>` — no extra preview (just the path). |
| `WebFetch` | `🌐 <url>` — no extra preview. |
| `WebSearch` | `🔍 <query>` — no extra preview. |
| Other tools | Raw `input_preview` in a code block (truncated to ~200 chars by Claude Code). |

If the JSON is truncated mid-string (Claude Code caps `input_preview` at ~200 chars), the plugin falls back to a regex over the prefix, so the highlight survives even on long inputs.

---

## Restrictions

- **DM only**. Prompts are sent only to JIDs on the global allowlist (`access.allowFrom`) that look like DMs (i.e. don't end in `@g.us`). Group members never receive permission prompts and `yes <id>` typed in any group is never consumed as an approval.
- **Per-target check on response**. Even an allowlisted DM contact can only approve a request the plugin sent to THEM. If multiple DM contacts are on the allowlist, the broadcast goes to all; whoever responds first wins.
- **The terminal dialog never blocks**. The relay is additive. If the user is at the keyboard and approves locally first, the WhatsApp prompts time out silently.
- **Permission decisions are NOT persisted**. Each tool invocation produces a new dialog. There is no "always allow this tool" setting on the WhatsApp side.

---

## Failure modes

**The prompt never arrives on WhatsApp.**
- Claude Code's permission relay is gated by a feature flag in the host (`tengu_harbor_permissions`). If your version of Claude Code doesn't have that flag enabled for your account, no `permission_request` notification fires and the plugin has nothing to relay. The terminal dialog still works as usual.
- The plugin needs to declare both `experimental['claude/channel']` and `experimental['claude/channel/permission']` capabilities — both are declared, but if a future Claude Code version filters channel servers more strictly, double-check the channels allowlist.
- Your `allowFrom` list might be empty (no DM targets to broadcast to). Pair at least one contact first.

**The text reply doesn't approve.**
- The `<id>` must match a pending request. Check the prompt message — the ID is shown there.
- The sender must be the original target. If you forwarded the prompt to someone else, their `yes <id>` won't work.
- Format must be `(y|yes|n|no) <id>` with one space between. Extra text breaks the parser. So does typing the ID before the y/n.

**A reaction doesn't approve.**
- The reaction must be on the original `🔐 Claude wants to run …` message, not on a later one.
- Must be one of the supported emoji (see [How to respond](#how-to-respond)).

**The prompt times out.**
- Default timeout is 5 minutes. After that, the pending entry is dropped and a late response does nothing. The terminal dialog is still active for as long as Claude Code is running.

**Two prompts with the same `request_id` arrive.**
- Defensive: the plugin replaces the prior entry, clears its timer, and treats the second as the new live request. This shouldn't happen in practice — Claude Code generates fresh IDs per request.

---

## Disabling the relay

Two ways:

1. **Empty the DM allowlist**. With no DM targets, the broadcast skips and the relay effectively never fires. The terminal dialog continues to work.
2. **Set `dmPolicy` to `disabled`**. This drops all DM traffic, including permission responses. More aggressive — also breaks DM messaging.

There is no per-tool opt-out today. If you want to relay permissions for `Bash` but not for `Edit` (for example), that's not currently a supported configuration.

---

## Worked examples

Three common situations, end-to-end. Assume you're paired and the relay is working.

### Scenario 1 — Approving a Bash from your phone via reaction

> Use case: Claude wants to run a command while you're away from the terminal.

1. Claude Code emits a `permission_request` for `Bash` with `command: "ls -la /tmp"`.
2. You feel your phone buzz. WhatsApp shows:

   ```
   🔐 Claude wants to run *Bash*
   List files in /tmp
   ```
   ```
   ls -la /tmp
   ```

   ```
   Reply *yes abcde* / *no abcde* or react 👍 / 👎.
   ```

3. **Long-press the prompt message** and react with 👍.
4. The plugin intercepts the reaction, emits `notifications/claude/channel/permission` with `behavior: "allow"`.
5. The terminal prompt clears; Claude proceeds. Total latency: ~1-2 seconds.

If you accidentally reacted with the wrong emoji, a second reaction overwrites (WhatsApp semantics). But the plugin also honors the race — if the terminal was used in the meantime, your late reaction is silently ignored.

### Scenario 2 — Denying an Edit via text reply

> Use case: Claude wants to edit a file you don't want touched.

1. Prompt arrives:

   ```
   🔐 Claude wants to run *Edit*
   Update config.ts
   📄 /Users/me/repo/src/config.ts
   ```
   ```
   {"file_path":"/Users/me/repo/src/config.ts","old_string":"const DEBUG = false","new_string":"const DEBUG = true"}
   ```

   ```
   Reply *yes rmfkn* / *no rmfkn* or react 👍 / 👎.
   ```

2. You don't want that edit. Send a message in the same DM:

   ```
   no rmfkn
   ```

3. The plugin parses the reply, matches `rmfkn` to the pending request, and emits `behavior: "deny"`. Terminal prompt clears; Claude does not edit.

Casing doesn't matter (`NO RMFKN` works — mobile autocaps is fine). Extra words do matter (`no rmfkn please` won't match — the parser is strict to avoid accidental approvals).

### Scenario 3 — Multi-approver: two people on the allowlist, first wins

> Use case: both you and a teammate are paired. Either of you can approve.

1. Prompt arrives on **both** of your WhatsApp numbers simultaneously (the same `request_id`, same text, different message IDs).
2. Your teammate reacts 👍 first.
3. The plugin emits the `allow` decision. Claude proceeds.
4. A few seconds later you also react 👍 from your phone — the plugin sees the reaction but the pending entry is already gone, so nothing happens. Your reaction stays on the message (as a normal emoji reaction) but doesn't affect anything.

The **per-target check on response** is what makes this safe — even if someone else was in the allowlist and they reacted on a prompt addressed to a different JID, their reaction wouldn't count. Each message's `request_id` is only matchable by the contact the message was sent to.

To approve from the terminal first instead, the mechanics are identical — whichever side responds first wins, the other sides time out silently.

---

## Protocol details

For implementers and curious readers. The relay implements the channel-permission protocol shipped in Claude Code's `services/mcp/channelPermissions.ts` and `channelNotification.ts`.

**Inbound notification** (Claude Code → plugin):

```
{
  "method": "notifications/claude/channel/permission_request",
  "params": {
    "request_id": "abcde",                       // 5 lowercase letters, alphabet `a-z` minus `l`
    "tool_name": "Bash",                         // tool the user is being asked to approve
    "description": "List files in /tmp",         // human-readable description
    "input_preview": "{\"command\":\"ls -la /tmp\"}"  // truncated to ~200 chars
  }
}
```

**Outbound notification** (plugin → Claude Code):

```
{
  "method": "notifications/claude/channel/permission",
  "params": {
    "request_id": "abcde",
    "behavior": "allow"   // or "deny"
  }
}
```

The plugin normalizes `request_id` to lowercase on both ingest (defensive — Claude Code already emits lowercase) and parse (so an autocapitalized `YES ABCDE` reply still resolves). The accepted reply regex is `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`.

The plugin attaches a low-level handler on the MCP transport (`transport.onmessage`) to intercept the inbound `permission_request` notification — the SDK's `setNotificationHandler` requires a Zod schema and rejects unknown methods, so the patch is additive and never replaces the SDK's regular dispatch.

For the published state contract (capabilities, files, schemas) see [README → Works alongside other plugins](../README.md#works-alongside-other-plugins).
