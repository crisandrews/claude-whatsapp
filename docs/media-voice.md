# Media and voice

What happens when a photo, voice note, document, or other non-text message lands in the bot's inbox — how it's saved, what Claude sees, and how to send things back. The configuration side (commands for enabling voice transcription, changing model size, etc.) lives in [docs/configuration.md](configuration.md); here we focus on runtime behavior and worked examples.

- [Inbound media layout](#inbound-media-layout)
- [What Claude sees](#what-claude-sees)
- [The 50 MB inbound cap](#the-50-mb-inbound-cap)
- [Security: the `inbox/` sandbox](#security-the-inbox-sandbox)
- [Voice transcription end-to-end](#voice-transcription-end-to-end)
- [Stickers, locations, and contacts](#stickers-locations-and-contacts)
- [Sending files back](#sending-files-back)
- [Worked examples](#worked-examples)
- [What's NOT supported](#whats-not-supported)

---

## Inbound media layout

Every downloaded inbound media file lives under:

```
<channel-dir>/inbox/
```

where `<channel-dir>` is either `<project>/.whatsapp/` (local-scope install) or `~/.claude/channels/whatsapp/` (global fallback).

Filenames follow a simple, predictable pattern so Claude can reason about them without needing a directory listing:

| Kind | Filename |
|---|---|
| Image | `img_<unix_ms>.<ext>` (e.g. `img_1713543200123.jpg`) |
| Video | `video_<unix_ms>.<ext>` |
| Voice / audio | `audio_<unix_ms>.ogg` |
| Document | original filename, sanitized |
| Sticker | *(not downloaded — text placeholder only)* |

The sanitizer (`safeName`) strips `< > [ ] \r \n ;` and any path components, so `../../etc/passwd.pdf` becomes `passwd.pdf`. Extension sanitizer (`safeExt`) strips everything that isn't alphanumeric from the MIME suffix.

---

## What Claude sees

When a media message arrives, Claude receives the usual channel notification — the `content` is a short placeholder text, and the `meta` map carries the file path plus enough metadata to act on.

| Kind | `content` text | `meta` fields |
|---|---|---|
| Image | `[Image] <caption>` or `[Image received]` | `attachment_kind="image"`, `attachment_mimetype`, `image_path` |
| Video | `[Video] <caption>` or `[Video received]` | `attachment_kind="video"`, `attachment_mimetype`, `attachment_path` |
| Voice (no transcription) | `[Voice message received]` | `attachment_kind="voice"`, `attachment_mimetype`, `attachment_path` |
| Voice (transcribed) | the transcript text | `attachment_kind="voice"`, `attachment_mimetype`, `attachment_path`, `transcribed="true"` |
| Audio (music file, not PTT) | `[Audio received]` | `attachment_kind="audio"`, same path/mimetype pattern |
| Document | `[Document: <filename>]` | `attachment_kind="document"`, `attachment_mimetype`, `attachment_filename`, `attachment_path` |
| Sticker | `[Sticker received]` | `attachment_kind="sticker"` *(no file path — see below)* |
| Location | `[Location: <lat>, <lng>]` | *(none)* |
| Contact | `[Contact: <displayName>]` | *(none)* |
| Reaction on a message | `[Reacted with <emoji>]` | `reaction="<emoji>"`, `reacted_to_message_id="<id>"` |

Claude is instructed (via the MCP server's `instructions`) to use `download_attachment` to confirm media files — see [docs/tools.md#download_attachment](tools.md#download_attachment) — and can read them directly after that.

---

## The 50 MB inbound cap

The constant `MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024` guards the download step for images, videos, documents, and audio. When an inbound file exceeds it:

1. The download is aborted with an error.
2. A line lands in `<channel-dir>/logs/system.log`: `image download failed: Error: File too large` (or `media download failed` / `audio download failed` depending on kind).
3. The placeholder text still reaches Claude (`[Image received]`, etc.), but without `image_path` / `attachment_path` in meta.

**This is an inbound cap only.** `reply` with a `file_path` has no equivalent size check — outbound sends go straight through Baileys, and WhatsApp's own server-side limit (~100 MB for documents) is what governs there. If that matters for your workflow, add your own check before calling `reply`.

To raise or lower the cap, edit `server.ts` and redeploy. No config knob today.

---

## Security: the `inbox/` sandbox

Two layers protect the channel directory from being read or written unexpectedly:

**`assertSendable(path)`** — used on outbound sends. Rejects any `file_path` that resolves inside `<channel-dir>` *except* files under `<channel-dir>/inbox/`. Stops Claude from being tricked into sending `auth/creds.json`, `access.json`, a raw log file, etc.

**`download_attachment`** — the tool is sandboxed to `<channel-dir>/inbox/`. Any `attachment_path` outside it throws `attachment_path must be inside the inbox directory`. So even if a chat user somehow talked Claude into fabricating a path, the tool itself refuses to leak it.

What's *not* sandboxed: the normal Read tool. If Claude reads a file from anywhere on your disk to send it, `assertSendable` stops it only if that path happens to be inside the channel dir. If the host user wants the agent constrained elsewhere, that's a Claude Code-level permission concern, not a channel one.

---

## Voice transcription end-to-end

Inbound voice notes can be transcribed by one of three providers. The default is a fully-local Whisper pipeline (via `@huggingface/transformers`); the other two are opt-in cloud APIs.

### Providers

| Provider | Where it runs | Cost | Privacy | When to pick it |
|---|---|---|---|---|
| `local` (default) | Bundled Whisper on your machine, ONNX-quantized | Free | Audio never leaves the device | Default. Almost everyone wants this. |
| `groq` | api.groq.com — Whisper Large v3 Turbo | ~$0.006 / min audio | Audio uploaded to Groq's API | When local is too slow on your hardware or you need the higher-quality larger model. |
| `openai` | api.openai.com — Whisper-1 | ~$0.006 / min audio | Audio uploaded to OpenAI's API | When you already have an OpenAI key set up and want comparable quality to Groq through the same vendor as the rest of your stack. |

Pick a provider with `/whatsapp:configure audio provider`. The cloud options each require an environment variable: `GROQ_API_KEY` for Groq, `OPENAI_API_KEY` for OpenAI. Set the env var before starting the server (or before the next reload).

**Automatic fallback to local.** If you've selected `groq` or `openai` and a transcription request fails — missing key, network blip, rate limit, auth error — the plugin loads local Whisper on demand and retries with it, then keeps that local pipeline warm for the rest of the session. You never lose a transcription to a cloud failure. Each fallback is logged to `logs/system.log` so you can tell whether your cloud provider is reliable.

### Enabling

One line to enable local transcription with a language hint:

```
/whatsapp:configure audio es
```

To switch providers later:

```
/whatsapp:configure audio provider groq
/whatsapp:configure audio provider openai
/whatsapp:configure audio provider local
```

Full command reference — model sizes, quality levels, supported languages (99+), how to switch or disable — in [docs/configuration.md#voice-transcription](configuration.md#voice-transcription). This doc covers what happens *after* you've enabled it.

### First-message behavior

On the first voice note after enabling (or after a restart, if the model isn't cached):

1. The plugin writes `<channel-dir>/transcriber-status.json`:

   ```json
   {"status": "loading", "ts": 1713543200000}
   ```

2. The Hugging Face model downloads (~77 MB for `base`, ~39 MB for `tiny`, ~250 MB for `small`). Cached permanently under the default Transformers.js cache dir — subsequent launches don't re-download.
3. When the pipeline is ready, the file flips to:

   ```json
   {"status": "ready", "ts": 1713543215000}
   ```

4. If anything fails (missing native deps, model download errors, bad audio codec), the file flips to:

   ```json
   {"status": "error", "error": "...", "ts": 1713543215000}
   ```

   — and `transcriber` is left `null`. Voice messages still arrive, just as `[Voice message received]` placeholders with the audio file saved.

### When transcription is off

`transcriber-status.json` is not rewritten on disable — the plugin just keeps `transcriber = null` internally. In practice that means: if you see `status: "ready"` in the file but transcription isn't happening, it's probably been disabled since. The authoritative "is it on?" signal is `audioTranscription: true` in `<channel-dir>/config.json`, surfaced by `/whatsapp:configure status`.

### Where the transcript lands

When transcription succeeds, the inbound channel notification uses the transcript as the message text instead of the `[Voice message received]` placeholder. The audio file is still saved to `inbox/` and still referenced via `meta.attachment_path` — Claude can hand it to another tool (archive, longer-form transcription, etc.) if needed.

An additional meta flag is set:

```json
{"transcribed": "true"}
```

so Claude can tell "this is a transcription" apart from "this is a text message". Useful when building agents that treat the two differently (e.g. confirming "I heard you say X, correct?" only for transcripts).

### Changing model or quality mid-session

Switch model size or quality via `/whatsapp:configure audio model small` / `audio quality best`. The plugin watches `config.json` and re-initializes the transcriber on change; expect the next voice note to take longer (model reload) and subsequent ones to run with the new settings.

### Privacy

With `audioProvider: "local"` (default), all transcription runs in-process inside the same Node server. No message text or audio leaves your machine during transcription. The only network traffic is the model download (from `huggingface.co`) on first use.

With `audioProvider: "groq"` or `"openai"`, the raw OGG/Opus audio file is uploaded to the chosen provider's transcription endpoint (`api.groq.com` or `api.openai.com`) using the corresponding API key from the environment. The transcript is returned and used in place of the local Whisper output. Audio handling, retention, and any logging on the provider side are governed by that provider's own privacy policy — see https://groq.com/privacy and https://openai.com/policies/privacy-policy. The plugin only uploads audio when an inbound voice note arrives and transcription is enabled; it never proactively uploads inbox files or other media.

---

## Stickers, locations, and contacts

Three message kinds are normalized to descriptive text for Claude but have no file payload:

**Sticker** — the content is reported as `[Sticker received]` with `meta.attachment_kind: "sticker"`. Unlike images, stickers aren't downloaded — there's no `image_path` to act on. If you need the sticker image, send it as an image from the phone. (This is the plugin being conservative — stickers are almost always "reaction" content, not something Claude needs to act on.)

**Location** — rendered as `[Location: -33.4513, -70.6653]`. No meta fields. Claude can parse the lat/lng from the text if asked to, e.g. *"reverse-geocode the last location someone sent me"*.

**Contact (vCard)** — rendered as `[Contact: Juan Pérez]`. No meta fields. Claude sees only the display name; the vCard body (phone, email) isn't surfaced yet. If you want Claude to "save this contact", it'll work off the display name and ask for the number — useful as a conversational affordance but not a replacement for the phone's own contact-save action.

Roadmap: richer surfacing for locations and contacts is under consideration. File an issue if this is blocking your flow.

---

## Sending files back

`reply` with `file_path` handles outbound attachments. Image file extensions (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) go as inline WhatsApp images with the `text` as caption; anything else goes as a document.

See [docs/tools.md#reply](tools.md#reply) for the full argument list. Two behaviors worth re-flagging here:

- **`assertSendable`** refuses to send files from inside the channel dir (except `inbox/`). Stops leakage of credentials / config.
- **No outbound size cap** inside the plugin. WhatsApp's own limit applies (~100 MB for documents, less for images and videos).

There's also the **auto-document** path: when Claude's text reply exceeds `documentThreshold` chars (configured via `/whatsapp:configure document threshold <N>`), the plugin automatically writes the text to a `.md` or `.txt` file and sends it as a document instead of chunking. The filename is `response.md` or `response.txt` (MIME picked by `documentFormat`); the temp file is deleted after send.

---

## Worked examples

### Scenario A — Summarizing an inbound PDF

> Someone sends you a 20-page PDF over WhatsApp. You want Claude to summarize it.

1. Inbound notification arrives: `content = "[Document: Q1-Report.pdf]"`, `meta.attachment_path = "<channel-dir>/inbox/Q1-Report.pdf"`.
2. Tell Claude: *"Summarize that report."*
3. Claude calls `download_attachment` with the `attachment_path` (confirms existence, enforces sandbox), then reads the file directly and writes a summary.
4. Claude `reply`s with the summary.

If the document is > 50 MB, step 1's `attachment_path` will be absent (download was skipped) — Claude will see the placeholder text only and can tell you the file was too large to download.

### Scenario B — Transcribing a 2-minute voice note

> Someone sends a voice note. Transcription is already enabled (`audio es`).

1. The plugin downloads the `.ogg` to `inbox/audio_<ts>.ogg`.
2. Whisper transcribes it locally.
3. Claude receives the transcript as the `content` of the inbound notification, with `meta.transcribed = "true"`.
4. Claude can reply to the transcript like any normal text message.

What you *don't* want: asking Claude to "transcribe this voice note" while transcription is disabled. With transcription off, Claude only sees `[Voice message received]` — no transcript. Enable it first (`/whatsapp:configure audio <lang>`).

### Scenario C — Sending a generated chart

> Claude computes something in a Bash tool and writes a chart to `/tmp/chart.png`. You want it sent back over WhatsApp.

1. Claude calls `reply` with `chat_id` + `text: "here's the Q1 trend"` + `file_path: "/tmp/chart.png"`.
2. `.png` is detected as an image — sent as an inline image with the text as caption.
3. The outbound send is indexed into `messages.db` as `[File: chart.png] here's the Q1 trend` — showable later via `search_messages`.

### Scenario D — Receiving a contact and saving the number

> Someone forwards a contact card.

1. Notification arrives: `content = "[Contact: Juan Pérez]"`. No meta fields, no phone number surfaced.
2. *"Juan just sent me his contact — save it to my address book."*
3. Claude realizes it can't auto-save (no phone number in the payload) and asks the user to read back the number from the WhatsApp UI, or does it on-device via a different tool.

This is the edge case worth remembering: vCard body isn't passed through today.

---

## What's NOT supported

- **Sending voice notes.** Inbound voice is received and optionally transcribed; outbound (Claude sending a voice note) isn't exposed.
- **Viewing stickers as images.** Stickers are acknowledged by text placeholder only; no file is downloaded.
- **Full vCard parsing for contacts.** Only the display name is forwarded today.
- **GIFs as GIFs.** WhatsApp's GIF format is actually MP4 video with a GIF flag — they arrive as `[Video]` in the current pipeline.
- **Location streaming ("live location").** Only static locations.
- **View-once media.** Treated as regular media by Baileys in some versions, not in others — reliability here is a WhatsApp-side moving target; don't depend on it.
