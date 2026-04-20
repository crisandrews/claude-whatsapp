# Configuration

Reference for every `/whatsapp:configure` sub-command and every key in the plugin's `config.json`. The skill is the friendly path; the file is the source of truth.

- [Linking](#linking)
- [Voice transcription](#voice-transcription)
- [Reply shaping](#reply-shaping)
- [Inbound debouncing](#inbound-debouncing)
- [Auth migration](#auth-migration)
- [Reset](#reset)
- [Status](#status)
- [The config file](#the-config-file)
- [Worked examples](#worked-examples)

---

## Linking

### `/whatsapp:configure` (no args)

Prompts for QR vs pairing code on a fresh link cycle, then opens the QR (or tells you how to request a pairing code). The most common path for a fresh install with a phone in hand.

If the channel is already linked, this reports `connected` plus the current access summary, and — while ClawCode isn't installed — surfaces a one-time invite to pair with the [ClawCode](https://github.com/crisandrews/ClawCode) companion agent.

### `/whatsapp:configure pair <phone>`

Headless linking. Generates an 8-character pairing code instead of waiting for a QR scan. Use this on servers without a screen or camera.

`<phone>` is digits-only (E.164 without the `+`). The skill strips any `+`, spaces, dashes, or parentheses you include.

Example:
```
/whatsapp:configure pair +5491155556666
```

The next QR cycle generates a code like `ABCD-EFGH`. Read it from `/whatsapp:configure` (or `<channel-dir>/status.json`'s `pairingCode` field). On WhatsApp: **Settings → Linked Devices → Link with phone number** → enter the code.

Codes refresh every ~20 seconds along with the QR. Re-run `/whatsapp:configure` if a code expires.

### `/whatsapp:configure pair off`

Disables pairing-code mode and goes back to QR-only on the next link cycle. Doesn't unlink an existing session.

---

## Voice transcription

Inbound voice notes can be auto-transcribed locally with Whisper. No API keys, no cloud — everything runs on your machine. The model downloads on the first voice message (~77 MB for the default `base` model) and is cached permanently.

### `/whatsapp:configure audio <language>`

Enable transcription. Set the primary language for accuracy.

```
/whatsapp:configure audio es     # Spanish
/whatsapp:configure audio en     # English
/whatsapp:configure audio pt     # Portuguese
```

Common ISO codes: `es`, `en`, `pt`, `fr`, `de`, `it`, `ja`, `zh`, `ko`, `ar`, `ru`, `hi`. Whisper supports 99+ languages.

Without a language set, Whisper auto-detects per message — slower and less accurate, especially for short clips. Setting an explicit language is the recommended path.

### `/whatsapp:configure audio` (no language)

Asks you to pick from Spanish / English / Portuguese / Auto-detect via an interactive prompt. Pick "Other" for any ISO code.

### `/whatsapp:configure audio model <size>`

Tradeoff between speed and accuracy.

| Size | Disk | Speed | Accuracy |
|---|---|---|---|
| `tiny` | ~39 MB | Fastest | Lower; OK for short voice messages |
| `base` | ~77 MB | Balanced | Good; the default |
| `small` | ~250 MB | Slower | Best of the local options |

Switching size triggers a download on the next voice message. Requires `/reload-plugins` to take effect.

### `/whatsapp:configure audio quality <level>`

Controls Whisper decoding parameters.

| Level | Behavior |
|---|---|
| `fast` | Quantized model, no beam search. Lowest latency. |
| `balanced` | Quantized model, standard decoding. The default. |
| `best` | Full-precision (fp32) model, 5-beam search. Slowest but most accurate. |

### `/whatsapp:configure audio off`

Disables transcription. Voice messages then arrive as the placeholder `[Voice message received]` along with the audio file in `<channel-dir>/inbox/`.

---

## Reply shaping

How Claude's outbound messages look on WhatsApp.

### `/whatsapp:configure chunk-mode <length|newline>`

WhatsApp messages are capped at 4096 characters. When Claude's reply exceeds that, the plugin splits it into multiple messages.

| Mode | Behavior |
|---|---|
| `length` | Hard cut at exactly 4096 characters. Default; preserves prior behavior. |
| `newline` | Look back from the limit for the nearest paragraph (`\n\n`), then line, then space break. Falls back to a hard cut only when nothing usable lies past the half-way point. |

`newline` produces more readable multi-message answers. `length` is predictable and slightly cheaper.

### `/whatsapp:configure reply-to <off|first|all>`

When Claude responds, WhatsApp can show a "quoted reply" pointer to the user's original message. Controls which chunks include that pointer:

| Mode | Behavior |
|---|---|
| `off` | Never quote. |
| `first` | Only the first chunk quotes. The default. |
| `all` | Every chunk quotes the original. |

`first` is usually right — the first chunk anchors the conversation, the rest read as a continuation. `all` is useful in active groups where messages from other participants might interleave.

### `/whatsapp:configure ack <emoji>` and `/whatsapp:configure ack off`

When set, the bot reacts to inbound messages from allowlisted contacts with the given emoji as soon as they arrive — before Claude composes a reply. Closes the silence gap between "user sends" and "agent responds".

```
/whatsapp:configure ack 👀
/whatsapp:configure ack 🤔
/whatsapp:configure ack off
```

Use any single emoji. Skin-tone variants supported.

### `/whatsapp:configure document threshold <N|off|always>`

When Claude's reply exceeds `N` characters, send it as a single `.md` / `.txt` attachment instead of N chunked text messages. Useful for long analyses, code reviews, or summaries that would scroll forever.

| Setting | Behavior |
|---|---|
| `0` or `off` | Disabled. Always chunk text. (Default.) |
| `N` (positive integer) | Send as a document when reply exceeds N chars. |
| `-1` or `always` | Always send as a document, regardless of length. |

```
/whatsapp:configure document threshold 4000     # 4k chars triggers document
/whatsapp:configure document threshold off      # back to chunked text
/whatsapp:configure document threshold always   # everything as a file
```

### `/whatsapp:configure document format <auto|md|txt>`

Picks the filename and MIME type for auto-document.

| Format | Effect |
|---|---|
| `auto` | Detect from content: `.md` if the text looks like markdown (headings, bold, code blocks, lists), else `.txt`. The default. |
| `md` | Always `.md` / `text/markdown`. |
| `txt` | Always `.txt` / `text/plain`. |

---

## Inbound debouncing

When someone fires several plain-text messages at the bot in quick succession ("hi" → "actually" → "can you…"), the plugin waits for a short pause before handing the batch to Claude — one agent turn for the whole thought instead of three half-started answers.

### How it works

A 2-second sliding window per `(chat, sender)` pair. Each new text resets the timer. On expiry, the plugin joins the texts with newlines and sends a single MCP notification. Reply threading points at the most recent `message_id` (so a quoted reply lines up with the last thing the user wrote).

Attachments, voice notes, reactions, and permission replies (`yes <id>`) bypass the buffer: any pending text is flushed first so ordering is preserved, then the media or reaction is delivered immediately on its own.

### Tuning

The window is controlled by the `inboundDebounceMs` key in `config.json`:

| Value | Behavior |
|---|---|
| `2000` (default) | Wait 2 seconds after the last text before flushing. |
| Any positive integer | Custom window in milliseconds. `5000` gives a more patient "let them finish typing" feel. |
| `0` | Disable — every message fires its own notification immediately, like pre-1.12 behavior. |

There's no `/whatsapp:configure` subcommand yet; edit `<channel-dir>/config.json` by hand and the file watcher picks up the change on the next message.

### Why this exists

Without debouncing, bursts of short messages each start their own agent turn, which can cause Claude to answer mid-thought or respond three times in a row when the user was still composing. Batching matches the OpenClaw gateway's `messages.inbound.debounceMs` feature so agents written against either gateway behave the same.

---

## Auth migration

### `/whatsapp:configure import <source-dir>`

Migrate an existing WhatsApp session from another local Baileys-based app (OpenClaw, wppconnect, a previous claude-whatsapp checkout) into this plugin's auth dir, so you don't have to scan a fresh QR or re-pair.

```
/whatsapp:configure import /path/to/other/.whatsapp/auth
```

The skill validates that `<source-dir>` exists and contains `creds.json` (Baileys multi-file auth format). It backs up the current session to `<channel-dir>/auth.backup-<timestamp>/`, copies the new files in, and tightens permissions to user-only.

After import, run `/reload-plugins` to reconnect with the imported credentials.

> **Important**: importing creds that are also in active use elsewhere (i.e. another running Baileys instance using the same files) will cause both sides to fight for the WhatsApp session. Stop the source app first.

To roll back, run:
```
rm -rf <channel-dir>/auth && mv <channel-dir>/auth.backup-<ts> <channel-dir>/auth
```

---

## Reset

### `/whatsapp:configure reset`

Clears the local session. Removes `auth/`, `status.json`, and `qr.png`. Next `/whatsapp:configure` produces a fresh QR (or pairing code, if `pairingPhone` is set).

Does NOT touch `access.json`, `config.json`, `messages.db`, `inbox/`, or `recent-groups.json` — your access list, configuration, and indexed history survive a reset.

Use this when:
- You want to link a different WhatsApp number.
- WhatsApp logged you out from the device list.
- The session seems stuck and you've ruled out simpler fixes.

---

## Status

### `/whatsapp:configure status`

Reports:
- Connection state (from `status.json`).
- Audio transcription state (enabled / language / model / quality, or "disabled").
- Reply shaping state if any non-default knob is set.
- Pairing-code mode if `pairingPhone` is set.

Read-only. Useful for debugging.

---

## The config file

All sub-commands above just write to `<channel-dir>/config.json`. You can edit it by hand if you prefer — the server picks up changes via a filesystem watcher (or after the next message, whichever comes first).

Field reference (all top-level, no nesting):

| Key | Type | Description |
|---|---|---|
| `audioTranscription` | boolean | Enable local Whisper transcription for inbound voice notes. |
| `audioLanguage` | string \| null | ISO 639-1 code (e.g. `"es"`, `"en"`). `null` = auto-detect. |
| `audioModel` | `"tiny"` \| `"base"` \| `"small"` | Whisper model size. Default: `"base"`. |
| `audioQuality` | `"fast"` \| `"balanced"` \| `"best"` | Decoding parameters. Default: `"balanced"`. |
| `chunkMode` | `"length"` \| `"newline"` | How long replies are split. Default: `"length"`. |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | Which chunks quote-reply the original. Default: `"first"`. |
| `ackReaction` | string \| undefined | Emoji posted on inbound from allowlisted contacts. Undefined = disabled. |
| `documentThreshold` | number | Chars; over the threshold sends as a document. `0` = disabled, `-1` = always. Default: `0`. |
| `documentFormat` | `"auto"` \| `"md"` \| `"txt"` | Filename / MIME for auto-document. Default: `"auto"`. |
| `pairingPhone` | string \| undefined | E.164 digits (no `+`). Triggers pairing-code linking on next QR cycle. |
| `inboundDebounceMs` | number | Sliding window (ms) to batch rapid plain-text messages from the same sender into one agent turn. `0` disables. Default: `2000`. |

The file is created with `0600` permissions. The skill writes it atomically (tmp + rename) so a partially-written file is never observed.

For state file paths, schemas, and the broader public contract that companion plugins can depend on, see [docs/state-contract.md](state-contract.md).

---

## Worked examples

Three end-to-end setups showing the commands working together, not in isolation.

### Scenario 1 — Headless server, no phone camera handy

> Use case: linking the agent on a cloud server or a machine behind a locked screen.

1. **Set the pairing phone** (E.164, with or without `+`):

   ```
   /whatsapp:configure pair +5491155556666
   ```

2. **Trigger a link cycle**:

   ```
   /whatsapp:configure
   ```

   Instead of (or alongside) the QR, an 8-character code appears — something like `ABCD-EFGH`. You can also read it from `<channel-dir>/status.json`'s `pairingCode` field if your terminal ate it.

3. **On your phone**: WhatsApp → **Settings → Linked Devices → Link with phone number instead** → enter the code.

4. **Confirm** with `/whatsapp:configure status` — should show `connected`.

5. **Optional**: turn pairing-code mode off so the next cycle reverts to QR-only:

   ```
   /whatsapp:configure pair off
   ```

   This doesn't unlink the session — it just stops the plugin from generating pairing codes alongside the QR.

### Scenario 2 — Low-latency Spanish voice transcription

> Use case: the bot mostly receives Spanish voice notes, you want snappy turnaround, you're OK with slightly lower accuracy for short clips.

1. **Enable with language set**:

   ```
   /whatsapp:configure audio es
   ```

2. **Smallest model** (~39 MB, fastest):

   ```
   /whatsapp:configure audio model tiny
   ```

3. **Fastest quality level** (quantized, no beam search):

   ```
   /whatsapp:configure audio quality fast
   ```

4. **Confirm**:

   ```
   /whatsapp:configure status
   ```

   Reports: audio enabled, language `es`, model `tiny`, quality `fast`.

5. **Have someone send a voice note**. The first one triggers a ~39 MB model download (~20 seconds on a typical connection); subsequent ones run transcription-only. See [docs/media-voice.md#voice-transcription-end-to-end](media-voice.md#voice-transcription-end-to-end) for what happens during that first-message warm-up.

To switch to best accuracy later: `audio model small` + `audio quality best`. You lose the speed; you gain precision.

### Scenario 3 — Long replies without flooding the chat

> Use case: Claude sometimes writes long analyses. You want them delivered as a clean file, not as 6 chunked text messages back-to-back.

1. **Chunk by paragraph, not by character count** — so that when chunking *does* happen, the seams are natural:

   ```
   /whatsapp:configure chunk-mode newline
   ```

2. **Auto-document over 4k chars**:

   ```
   /whatsapp:configure document threshold 4000
   ```

3. **Prefer markdown for structured content**:

   ```
   /whatsapp:configure document format md
   ```

   (The default `auto` would also pick `md` when the content looks markdown-like; `md` forces it.)

4. **Optional**: quote only the first chunk on long replies (default is already `first`):

   ```
   /whatsapp:configure reply-to first
   ```

5. **Test**: ask Claude from your phone for a detailed analysis. Under 4000 chars → text reply. Over 4000 → arrives as `response.md` with the full content, quote-pointed at your original message.

To go back to chunked text: `/whatsapp:configure document threshold off`.
