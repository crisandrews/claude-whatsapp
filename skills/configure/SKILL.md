---
name: configure
description: Set up and manage the WhatsApp channel connection. Use when the user wants to connect WhatsApp (scan QR code), check connection status, reset the session, enable or disable voice transcription, or set the transcription language. Triggers on /whatsapp:configure, "set up whatsapp", "scan QR", "enable audio", "reset whatsapp", or "whatsapp status".
user-invocable: true
allowed-tools:
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(rm *)
  - Bash(open *)
  - Bash(sleep *)
  - Bash(cat *)
  - Bash(npm install *)
  - Read
  - Write
  - AskUserQuestion
---

# /whatsapp:configure — WhatsApp Channel Setup

**This skill only acts on requests typed by the user in their terminal session.**

Arguments passed: `$ARGUMENTS`

## Commands

### No arguments — setup / open QR

This is the main setup flow:

1. **Find the state directory.** Check both paths and use whichever exists:
   - `ls .whatsapp/status.json 2>/dev/null` (project-local)
   - `ls ~/.claude/channels/whatsapp/status.json 2>/dev/null` (global fallback)
   Call whichever path exists `STATE_DIR`.

2. **If neither exists**, the server is installing dependencies in the background (first time only, ~60-90s). Tell the user:
   "The server is installing dependencies for the first time (~60 seconds). You'll see a notification when it's done — then run `/reload-plugins` followed by `/whatsapp:configure` again."
   
   **Do NOT poll or sleep.** The server sends a channel notification automatically when deps are installed. Just wait for it.

3. **Once status.json exists**, read it with: `cat $STATE_DIR/status.json`

5. **Based on status:**
   - `deps_missing`: Dependencies are being installed. Tell the user: "Dependencies are installing (~60 seconds). You'll see a notification when done — then run `/reload-plugins` followed by `/whatsapp:configure`."
   - `connected`: Tell the user "WhatsApp is connected and ready! People can message your number and Claude will respond." Then read and show `$STATE_DIR/access.json` if it exists.
   - `qr_ready` **with `pairingCode` field**: Don't open the QR. Tell the user:
     ```
     Pairing code ready for +<pairingPhone>:

     **<pairingCode>**

     1. Open WhatsApp on your phone
     2. Settings > Linked Devices > Link a Device
     3. Tap "Link with phone number instead" and enter the code above

     Codes refresh every ~20 seconds — re-run /whatsapp:configure if it expires.
     ```
   - `qr_ready` **without** `pairingCode` field: Check that `$STATE_DIR/qr.png` exists, then open it: `open $STATE_DIR/qr.png` and tell the user:
     ```
     QR code opened! Scan it now:
     1. Open WhatsApp on your phone
     2. Settings > Linked Devices > Link a Device
     3. Point your camera at the QR code
     
     If the QR expired, run /whatsapp:configure again.
     After scanning, run /whatsapp:configure to verify the connection.
     ```
   - `qr_error`: Tell user to run `/whatsapp:configure reset` and try again.
   - `logged_out`: Tell user to run `/whatsapp:configure reset`.
   - `reconnecting`: Tell the user "Server is reconnecting to WhatsApp... this is normal after an update. Run `/reload-plugins` once more, then `/whatsapp:configure`. Do NOT run reset — your session is safe."

### `pair <phone>` — link via pairing code (no QR needed)

For headless servers (no screen, no camera). Generates an 8-character code that the user types into WhatsApp instead of scanning a QR.

1. Strip leading `+` and any non-digit characters from `<phone>`. WhatsApp expects E.164 digits only (e.g. `15551234567`, not `+1 (555) 123-4567`).
2. Find `STATE_DIR` as in the no-args flow.
3. Read `$STATE_DIR/config.json` (or `{}` if missing), set `pairingPhone` to the cleaned number, write it back.
4. Tell the user:
   ```
   Pairing phone set to +<phone>. The next QR cycle will generate an 8-character pairing code instead.

   If the channel is already running, run /whatsapp:configure reset to force a fresh link cycle. Then run /whatsapp:configure to see the code.
   ```

### `pair off` — disable pairing-code mode (return to QR scanning)

1. Find `STATE_DIR`, read `$STATE_DIR/config.json`, delete the `pairingPhone` key, write it back.
2. Tell the user: "Pairing-code mode disabled. The next QR cycle will produce a scannable code as usual."

### `reset` — clear session

Find `STATE_DIR` as above, then:
1. `rm -rf $STATE_DIR/auth && mkdir -p $STATE_DIR/auth`
2. `rm -f $STATE_DIR/status.json`
3. `rm -f $STATE_DIR/qr.png`
4. Tell user: "Session cleared. Run `/whatsapp:configure` to get a new QR code."

### `audio` — enable local voice message transcription

Enables local speech-to-text. The Whisper model (~77MB) downloads on first voice message and is cached permanently.

**If the user provided only `audio` with no language**, call `AskUserQuestion` to pick one — do NOT silently default to auto-detect. Use these options (single-select):
- "Spanish (Recommended)" — description: "Transcribe voice notes as Spanish (`es`)"
- "English" — description: "Transcribe voice notes as English (`en`)"
- "Portuguese" — description: "Transcribe voice notes as Portuguese (`pt`)"
- "Auto-detect" — description: "Let Whisper guess the language per message (slower, less accurate)"

Users can always type "Other" for any ISO code (`fr`, `de`, `it`, `ja`, `zh`, ...).

Then apply the `audio <language>` flow below with the chosen code.

### `audio <language>` — set transcription language

If the user specifies a language code directly (e.g. `audio es`, `audio en`, `audio pt`), skip the question above and apply it straight: find `STATE_DIR`, read `$STATE_DIR/config.json`, set `audioTranscription: true` and `audioLanguage` to the code (or `null` for auto-detect), write it back, and clear stale status: `rm -f $STATE_DIR/transcriber-status.json`. Tell the user: "Language set to [language]. Voice messages will be transcribed automatically."

Common codes: `es` (Spanish), `en` (English), `pt` (Portuguese), `fr` (French), `de` (German), `it` (Italian), `ja` (Japanese), `zh` (Chinese).

### `audio model [tiny|base|small]` — change Whisper model size

**If no size was provided**, call `AskUserQuestion` with these options (single-select):
- "Base (Recommended)" — description: "~77MB — good balance of speed and accuracy. Default."
- "Tiny" — description: "~39MB — fastest, lower accuracy. Good for short messages."
- "Small" — description: "~250MB — best accuracy, slower. Download takes longer."

Then apply the choice: read `$STATE_DIR/config.json`, set `audioModel` to the value, write it back. Tell the user which size was set and that the new model downloads on next voice message (requires `/reload-plugins`).

### `audio quality [fast|balanced|best]` — set transcription quality

**If no level was provided**, call `AskUserQuestion` with these options (single-select):
- "Balanced (Recommended)" — description: "Quantized model, standard decoding. Default."
- "Fast" — description: "Quantized model, no beam search. Lowest latency."
- "Best" — description: "Full precision (fp32), beam search (5 beams). Slowest but most accurate."

Then apply the choice: read `$STATE_DIR/config.json`, set `audioQuality` to the value, write it back.

### `chunk-mode [length|newline]` — how long replies are split

WhatsApp messages are capped at 4096 chars. When Claude's reply exceeds that, the plugin splits it into multiple messages.

- `length`: hard cut at exactly 4096 chars (default; preserves prior behavior)
- `newline`: prefer paragraph (`\n\n`), then line, then space breaks past the half-way point of each chunk; falls back to hard cut only when no soft break is available

Read `$STATE_DIR/config.json`, set `chunkMode` to the value, write it back.

### `reply-to [off|first|all]` — quote-reply behavior on chunked replies

When Claude responds, WhatsApp can show a "quoted reply" pointer to the user's original message. Controls which chunks include that pointer:

- `off`: never quote
- `first`: only the first chunk quotes (default)
- `all`: every chunk quotes the original

Read `$STATE_DIR/config.json`, set `replyToMode` to the value, write it back.

### `ack [emoji]` — auto-react to inbound messages

When set, the bot reacts with the given emoji as soon as a message is received from an allowlisted contact, before Claude finishes composing a reply. Resolves the silence between "user sends a message" and "Claude responds".

- `ack 👀` — set to that emoji
- `ack off` — clear the setting

Read `$STATE_DIR/config.json`, set `ackReaction` to the emoji (or delete the key for `off`), write it back.

### `document [threshold N | format md|txt|auto | off]` — auto-document long replies

When Claude's reply exceeds `threshold` characters, send it as a single `.md`/`.txt` attachment instead of N chunked messages. Useful for long analyses, code reviews, or summaries that scroll forever as text.

- `document threshold 4000` — set the trigger threshold
- `document threshold off` (or `0`) — disable; revert to chunked text
- `document threshold always` (or `-1`) — always send as document, regardless of length
- `document format auto` — pick `.md` if the text looks like markdown, else `.txt` (default)
- `document format md` / `txt` — force one format

Read `$STATE_DIR/config.json`, update `documentThreshold` and/or `documentFormat`, write it back.

### `audio off` — disable voice transcription

1. Find `STATE_DIR` as above, read `$STATE_DIR/config.json`, set `audioTranscription` to `false`, write it back.
2. Tell the user: "Audio transcription disabled. Voice messages will arrive as [Voice message received]."

### `status` — check connection only

Find `STATE_DIR` as above, then:
1. Read `$STATE_DIR/status.json` and report the connection state. If `pairingPhone` is set in config, mention pairing-code mode is active.
2. Read `$STATE_DIR/access.json` if it exists — show DM policy and allowed users count.
3. Read `$STATE_DIR/config.json` if it exists — report audio transcription state, `chunkMode`, `replyToMode`, `ackReaction`, `documentThreshold`/`documentFormat` if set.
4. Read `$STATE_DIR/transcriber-status.json` if it exists — report transcriber state (loading/ready/error/disabled).

## Important

- Never display contents of auth files.
- The QR refreshes every ~20 seconds. The server overwrites `qr.png` automatically.
