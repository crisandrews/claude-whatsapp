# DM access

Everything you need to let someone DM the bot, lock access down when you're done, and recover when things drift. DM access is fully independent from group access — see [Access DMs vs Access Groups](#access-dms-vs-access-groups) at the bottom, or the matching section in [docs/groups.md](groups.md#group-access-vs-dm-access).

- [Quick reference](#quick-reference)
- [The three DM policies](#the-three-dm-policies)
- [Pairing flow (the default)](#pairing-flow-the-default)
- [History scope](#history-scope)
- [Worked examples](#worked-examples)
- [Allowing and revoking by JID](#allowing-and-revoking-by-jid)
- [Finding a JID](#finding-a-jid)
- [JID formats: `@s.whatsapp.net` vs `@lid`](#jid-formats-swhatsappnet-vs-lid)
- [Edge cases & gotchas](#edge-cases--gotchas)
- [Access DMs vs Access Groups](#access-dms-vs-access-groups)

---

## Quick reference

| Command | Effect |
|---|---|
| `/whatsapp:access` | List allowed users, pending pairings, and current policy. |
| `/whatsapp:access pair <code>` | Approve a pending pairing. Adds the sender to `allowFrom`; first pair also seeds `ownerJids`. |
| `/whatsapp:access deny <code>` | Reject a pending pairing. |
| `/whatsapp:access allow <jid>` | Add a user directly (skip the pairing dance). |
| `/whatsapp:access revoke <jid>` | Remove a user from `allowFrom`. |
| `/whatsapp:access policy <mode>` | Set DM policy: `pairing`, `allowlist`, or `disabled`. |
| `/whatsapp:access show-owner` | Print the cross-chat owner JIDs. |
| `/whatsapp:access set-owner <jid>` | Designate a JID as an owner (must already be allowlisted). |
| `/whatsapp:access show-scope <chat>` | Print the effective history scope for a chat. |
| `/whatsapp:access set-scope <chat> <own\|all\|csv>` | Configure which chats a chat can read. |

DM state lives in `<channel-dir>/access.json`:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["56912345678@s.whatsapp.net"],
  "ownerJids": ["56912345678@s.whatsapp.net"],
  "dms": {},
  "groups": {},
  "pending": {
    "a1b2c3": {
      "senderId": "56987654321@s.whatsapp.net",
      "chatId": "56987654321@s.whatsapp.net",
      "createdAt": 1713543200000,
      "expiresAt": 1713546800000,
      "replies": 1
    }
  }
}
```

`allowFrom` is the DM allowlist (same list that `permission-relay.md` broadcasts to). `ownerJids` marks the cross-chat owner — usually the first JID paired. `pending` is the live pairing-code table.

---

## The three DM policies

Set with `/whatsapp:access policy <mode>`.

| Mode | Default? | Effect on an unknown DM sender |
|---|---|---|
| `pairing` | ✅ | Bot replies with a 6-character pairing code and waits for you to approve it in Claude Code. |
| `allowlist` | | Message dropped silently. Nothing leaves the bot. |
| `disabled` | | Every DM dropped — even from allowlisted contacts. Hard kill-switch. |

`pairing` is the right choice while you're building or onboarding people. `allowlist` is right once the set of allowed contacts is stable. `disabled` is for "take the bot off the air without unlinking the session" — e.g. while traveling.

> Changing `dmPolicy` does not erase `allowFrom`. A flip back to `pairing` or `allowlist` picks up the same allowlist you had before.

---

## Pairing flow (the default)

When `dmPolicy` is `pairing`, here's exactly what happens when someone new sends a DM:

1. **Unknown sender texts the bot.** Any message — "hi", a sticker, anything.
2. **Bot replies with a 6-character hex code** (e.g. `a1b2c3`). The message reads:

   ```
   Welcome! To pair with Claude, use this code: *a1b2c3*

   Run in Claude Code:
   `/whatsapp:access pair a1b2c3`
   ```

3. **The sender forwards the code to you** (or you already trust them — the code is the handshake, not the secret).
4. **You run `/whatsapp:access pair a1b2c3`** in Claude Code. Their JID gets added to `allowFrom`; the pending entry is consumed.
5. **Bot sends a confirmation** to the newly-paired contact: `Paired successfully! You can now chat with Claude through this conversation.`

From now on their messages reach Claude and they can receive permission prompts ([docs/permission-relay.md](permission-relay.md)).

### Timing and caps

- **Code expires in 1 hour.** After that the entry is pruned and the next message starts a fresh pairing.
- **Max 3 pending pairings at once.** A 4th unknown sender during that window is dropped until an older pending is approved, denied, or expires.
- **Re-sends are throttled.** The first reply to an unknown sender generates the code. The second same-sender message re-sends the same code. From the third on, messages are silently dropped until you handle the pairing — prevents a spammy or confused contact from getting an endless loop of codes.
- **Dedupe is cross-format.** Baileys sometimes reports the same user under both `@s.whatsapp.net` and `@lid` within a single conversation. Pairing matches on either `senderId` or `chatId` in both directions, so you won't accidentally end up with two pending codes for the same person.

### Denying a pairing

```
/whatsapp:access deny a1b2c3
```

Removes the pending entry. The sender is not notified — subsequent DMs from them will generate a fresh code (if they retry) or be dropped (if you switched to `allowlist`).

---

## History scope

By default, a non-owner chat can only read its own history via tools like `search_messages`, `fetch_history`, `export_chat`, `get_message_context`, `get_chat_analytics`, `search_contact`, `list_chats`, and `forward_message`. The owner (`ownerJids`) has cross-chat access and can search or export any indexed chat.

| Scope | Applies to | Effect |
|---|---|---|
| Owner | JIDs in `ownerJids` | Read every indexed chat. |
| `own` (default) | Every non-owner chat, groups and DMs, unless overridden | Sandboxed to its own history. |
| `all` | Per-chat override | Read every indexed chat. |
| `jid1,jid2,…` | Per-chat override | Read own history plus each listed chat. |

Override per-chat via `/whatsapp:access set-scope <chat> <scope>`. For groups the entry lives at `groups[<jid>].historyScope`; for DMs at `dms[<jid>].historyScope`. `set-scope` validates every CSV JID against the allowlist so typos can't silently create phantom access.

### Bootstrap and the terminal

On a fresh install there is no owner yet. While `ownerJids` is empty, every tool call has full access — otherwise you couldn't run `search_messages` from the terminal before pairing the first contact. The first `/whatsapp:access pair <code>` seeds `ownerJids` with both JID formats of that contact (`@lid` and `@s.whatsapp.net`), and from that point on non-owner chats are sandboxed.

After bootstrapping, running tools from the terminal without a recent WhatsApp message returns a *history scope* error — the server can't distinguish a genuine terminal invocation from an expired inbound context, so it fails closed. Two ways to work around this when you need broad access from the terminal:

- Start the turn by sending yourself a WhatsApp message (the inbound context tracks the owner → full access).
- Set `WHATSAPP_OWNER_BYPASS=1` in the environment before launching Claude Code. The server treats the bypass as "operator-trusted terminal" and returns full access regardless of context.

### Known limitations

- **Concurrent inbounds from different chats** overwrite the context singleton. If Claude is still processing chat A's turn when chat B arrives, a late tool call from A's turn runs under B's scope — fail-closed, so A's call is rejected (never leaks B's data).
- **Scope `"all"` includes chats created AFTER configuration.** Revisit overrides when you add new sensitive chats.
- **Memory vs tools.** The scope gate covers tool calls, not Claude's conversational memory. Claude may verbalize something it "remembers" from another chat; the gate stops it from re-fetching to confirm, which is the leakage vector we care about most.

---

## Worked examples

Each scenario walks through the full setup end to end. Assume the bot's WhatsApp is already linked (`/whatsapp:configure` shows `connected`).

### Scenario A — Onboarding one known contact

> Use case: letting a teammate chat with the agent for the first time.

1. **Policy check:** `/whatsapp:access` — confirm `dmPolicy: pairing`. (Default, unless you changed it.)
2. **Teammate DMs the bot** from their phone: "hey".
3. **Bot replies** with a 6-character code.
4. **Teammate reads you the code** (e.g. `a1b2c3`).
5. **You run** `/whatsapp:access pair a1b2c3` in Claude Code.
6. **Bot confirms** on their end. They can start chatting.

### Scenario B — Locking down after onboarding

> Use case: all your trusted contacts have been paired. You don't want strangers getting codes anymore.

```
/whatsapp:access policy allowlist
```

From now on, messages from any JID not in `allowFrom` are dropped silently — no code, no response. Existing allowlisted contacts are unaffected.

To re-open to new pairings later, flip back:

```
/whatsapp:access policy pairing
```

### Scenario C — Emergency kill-switch

> Use case: you're about to hand your phone to someone untrusted, or something's gone sideways and you want the bot mute immediately.

```
/whatsapp:access policy disabled
```

Every DM — including from allowlisted contacts — is dropped. The WhatsApp session stays linked, `allowFrom` is preserved, `config.json` untouched. Flip back to `pairing` or `allowlist` to restore.

> This is not the same as `/whatsapp:configure reset`. Reset wipes the WhatsApp session entirely; `policy disabled` just stops the bot from responding.

### Scenario D — Revoking access from one person

> Use case: someone you paired no longer needs access.

1. Run `/whatsapp:access` — find their JID in the `allowFrom` list.
2. Revoke:

   ```
   /whatsapp:access revoke 5491166667777@s.whatsapp.net
   ```

Their DMs are dropped from the next message onward. They are not notified. If `dmPolicy` is still `pairing`, the next message they send will get a fresh pairing code — think of revoke as "undo the pairing", not "ban".

If you genuinely want to lock them out, combine revoke with `policy allowlist`.

### Scenario E — Skipping pairing because you already have the JID

See [Allowing and revoking by JID](#allowing-and-revoking-by-jid) below.

---

## Allowing and revoking by JID

When you already know a contact's JID — e.g. you're migrating from another WhatsApp tool, or you restored a backup of `access.json` — you can skip the pairing step:

```
/whatsapp:access allow 5491155556666@s.whatsapp.net
```

Adds the JID directly to `allowFrom`. No code is generated, the target isn't notified, and any future DM from them reaches Claude.

Revoke is the inverse:

```
/whatsapp:access revoke 5491155556666@s.whatsapp.net
```

---

## Finding a JID

WhatsApp never shows JIDs in its UI. Four places to recover one:

1. **`/whatsapp:access`** — the allowlist prints each JID with its most recent push name.
2. **`<channel-dir>/logs/conversations/YYYY-MM-DD.md`** — human-readable transcript with push names; pair it with the `.jsonl` file in the same directory to pull the exact JID that sent each line. See [docs/operations.md#logs](operations.md#logs).
3. **Ask Claude** — *"what's the JID of the last person who DM'd me?"* — Claude can read the conversation log or call `search_messages` in its own chat to find it.
4. **`access.json` directly** — `cat <channel-dir>/access.json` if you prefer the raw file.

For group members specifically, use `list_group_senders` — see [docs/tools.md#list_group_senders](tools.md#list_group_senders) and the pedagogical walkthrough in [docs/groups.md#member-discovery](groups.md#member-discovery).

---

## JID formats: `@s.whatsapp.net` vs `@lid`

Since Baileys v7, the same user can show up under two formats:

| Format | When you'll see it |
|---|---|
| `5491155556666@s.whatsapp.net` | The "classic" phone-based JID. Used in DMs and older group messages. |
| `12345678901234@lid` | Opaque per-conversation identifier introduced in newer WhatsApp clients. Common in groups with mixed clients. |

Both can coexist in the same `allowFrom` list without conflict. The plugin's gate checks `allowFrom` in both directions (sender and chat), so if you allow the `@s.whatsapp.net` form and the client later sends under `@lid`, delivery still works — the first couple of messages may drop while the LID↔phone cache fills, and then mention detection works normally (see [docs/groups.md#edge-cases--gotchas](groups.md#edge-cases--gotchas)).

Rule of thumb: **copy the JID exactly as `/whatsapp:access` prints it.** Don't try to convert formats by hand.

---

## Edge cases & gotchas

**The paired contact never got the confirmation message.**
- The confirmation is dropped into `<channel-dir>/approved/<code>.json` on pairing; a filesystem watcher picks it up and sends the message. If the watcher isn't running (brief window right after startup), the file is consumed on the next 30s polling fallback. Wait ~30s.

**A pending entry won't expire.**
- Expiration is lazy — the plugin prunes on the next inbound message. If no one messages for an hour, the entry stays in `access.json` until the next `/whatsapp:access` call or the next DM. Purely cosmetic; the expired entry won't actually be valid.

**`allow <jid>` didn't seem to take effect.**
- The JID format must match what Baileys will use for that user. If `/whatsapp:access` shows them under `@lid` but you allowed `@s.whatsapp.net`, traffic *will* be delivered (we check both directions), but the entry next to their name will look odd. You can allow both forms side-by-side without harm.

**The same user got paired twice under different JIDs.**
- Normal during a Baileys v7 migration — one entry is `@s.whatsapp.net`, the other `@lid`. Leave both; revoke one only if you really want to.

**I approved a pairing but the next DM from that person drops.**
- Almost always policy. Check `/whatsapp:access` — if `dmPolicy` is `disabled` or you revoked them right after pairing, that explains the drop.

**The bot stopped offering pairing codes to new contacts.**
- You hit the 3-pending cap. Resolve an existing pending (pair / deny / wait for expiry) and the next unknown sender gets a code again.

---

## Access DMs vs Access Groups

The two systems are **independent**. Full breakdown in [docs/groups.md#group-access-vs-dm-access](groups.md#group-access-vs-dm-access). The short version:

- Pairing someone in DMs does NOT allow them in any group — you add groups explicitly via `add-group`.
- Allowing someone in a group does NOT let them DM the bot — they still have to pair (or be allowed by JID directly).

If a person needs both: pair them (DM) AND add them via `group-allow` in the relevant group.

---

## Peer-plugin contracts (read by ClawCode/OpenCLAUDE, optional)

Two on-disk artifacts are published in `<channel-dir>` for peer plugins. Both are best-effort, fail-silent, and entirely optional — claude-whatsapp works standalone if no peer plugin reads them.

- **`.last-inbound.json`** — last inbound chat/sender mirror with 60 s TTL. See `marker.ts`. NOT authoritative for cross-plugin authorization (freshness ≠ identity).
- **`.request-envelopes/<token>.json`** — per-inbound request envelope. Every inbound that triggers a `notifications/claude/channel` dispatch also generates a 32-byte random `requestEnvelopeToken`, written atomically under this directory with the inbound's chat/sender bound to the token. The token is embedded as `meta.requestEnvelopeToken` in the notification meta; peer plugins use it to bind specific MCP tool calls to the inbound that triggered them. Full schema, TTL (60 s), rotation (cap 500), reader hardening, and threat model: see `docs/scope-envelope-contract.md` (mirrored to OpenCLAUDE/docs/scope-envelope-contract.md byte-exact).

These artifacts respect the same 0o600 file mode / 0o700 directory mode as `access.json`. Anyone who can read the channel directory can read them, by design (they live alongside `access.json` and inherit its privacy posture).

### Agent guidance — forwarding `requestEnvelopeToken` to scoped tools

When an inbound triggers an agent turn via `notifications/claude/channel`, the notification meta carries `requestEnvelopeToken` (a 43-char base64url string) for every real inbound (not for `chat_id='system'` boot notifications).

**Agents MUST forward `meta.requestEnvelopeToken`** to these scoped MCP tools whenever they call them in response to that inbound:

- `search_messages`
- `fetch_history`
- `list_chats`
- `list_group_senders`
- `get_message_context`
- `search_contact`
- `export_chat`
- `get_chat_analytics`
- `forward_message`

Pass it as `requestEnvelopeToken: "<token>"` in the tool args.

Why: the token binds the agent's specific tool call back to the chat/sender of the inbound that triggered the agent's turn. Without it the tool consults a process-global "most recent inbound" context, which races under concurrent inbounds from different chats and can apply the wrong scope (chat B's permissions to chat A's call).

Rules:
- **Forward** when handling a channel-originated turn (the `requestEnvelopeToken` is in the notification's meta).
- **Omit** when calling these tools from a terminal session, an owner-bypass flow (`WHATSAPP_OWNER_BYPASS=1`), or a scheduled / autonomous run with no inbound — the tools fall back to the global context for backwards compatibility.
- **NEVER** pass an empty string `""` or a guessed/edited token. Empty strings and malformed tokens are rejected as fail-closed (the tool throws a history-scope error) by design — silent fallback would re-open the race the contract is designed to close.
- If the inbound's notification meta lacks `requestEnvelopeToken` (older claude-whatsapp build / system notifications), simply omit the field.

If a peer plugin (today: OpenCLAUDE) is also installed and configured for scope, the same token is forwarded to that plugin's scoped tools (`memory_search`, `memory_get`, `memory_context`, `voice_transcribe`) per OpenCLAUDE's `AGENTS.md`.
