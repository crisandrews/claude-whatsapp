# Configuration

Reference for every `/whatsapp:configure` sub-command and every key in the plugin's `config.json`. The skill is the friendly path; the file is the source of truth.

- [Linking](#linking)
- [Voice transcription](#voice-transcription)
- [Reply shaping](#reply-shaping)
- [Auth migration](#auth-migration)
- [Reset](#reset)
- [Status](#status)
- [The config file](#the-config-file)

---

## Linking

### `/whatsapp:configure` (no args)

Opens the QR code on screen and shows current connection state. The most common path for a fresh install with a phone in hand.

If the channel is already linked, this just reports `connected` plus the current access summary.

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

The file is created with `0600` permissions. The skill writes it atomically (tmp + rename) so a partially-written file is never observed.

For state file paths, schemas, and the broader public contract that companion plugins can depend on, see [README → Works alongside other plugins](../README.md#works-alongside-other-plugins).
