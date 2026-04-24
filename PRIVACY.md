# Privacy Policy

_Last updated: 2026-04-20_

claude-whatsapp is a local-first plugin for [Claude Code](https://claude.com/claude-code) that bridges your WhatsApp number to a Claude agent. It runs entirely on the user's machine. This document explains what data the plugin handles, where it is stored, and which third-party services it contacts.

## 1. Who we are

claude-whatsapp is an open-source project maintained by **Juan Cristobal Andrews** ([crisandrews](https://github.com/crisandrews) on GitHub) and distributed under the [MIT License](./LICENSE). It is **not** operated as a hosted service. There is no claude-whatsapp server, no account system, and no backend that receives user data.

- Source: https://github.com/crisandrews/claude-whatsapp
- Issues / contact: https://github.com/crisandrews/claude-whatsapp/issues

## 2. Data the plugin stores locally

All data created or managed by claude-whatsapp lives on the user's filesystem, under the channel directory (`<project>/.whatsapp/` for project-local installs, or `~/.claude/channels/whatsapp/` for the global fallback). Nothing is transmitted to the plugin author.

Typical local artifacts:

- `auth/` — Baileys multi-file session credentials (rotating cryptographic material). Created with `0700` directory perms and `0600` file perms; tightened on every server start and after every credentials update.
- `inbox/` — downloaded inbound media (photos, audio, video, documents).
- `messages.db` — local SQLite database with FTS5 index over inbound and outbound messages, used to back the `search_messages`, `fetch_history`, and `export_chat` MCP tools. Created with `0600` perms.
- `access.json` — DM and group access control configuration (allowlist, pending pairings, group settings).
- `config.json` — plugin configuration (audio transcription, reply shaping, pairing phone, etc.).
- `recent-groups.json` — discovered unknown WhatsApp groups awaiting allow/deny.
- `status.json` — current connection state.
- `logs/system.log` and `logs/conversations/*.{jsonl,md}` — local server log and per-day conversation transcripts.

The user may inspect, edit, export, or delete any of these files at any time. `/whatsapp:configure reset` removes the auth directory and status; deleting the channel directory removes everything.

## 3. Data the plugin does **not** collect

claude-whatsapp does not:

- Send telemetry, analytics, crash reports, or usage metrics to the author or any third party.
- Include tracking pixels, fingerprints, or remote loggers.
- Upload messages, media, configuration, or auth state anywhere by default.
- Require an account, email, or any form of registration.
- Store or transmit any data outside the user's own machine and the WhatsApp servers the user is already talking to.

## 4. Third-party services

The plugin communicates with two categories of third-party services. The first is mandatory for the plugin to do its job; the second is opt-in per feature.

### 4.1 Mandatory: WhatsApp (via Baileys)

claude-whatsapp uses [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys), an open-source unofficial WhatsApp Web Multi-Device client, to talk directly to WhatsApp's servers on the user's behalf. There is no intermediary.

- The plugin pairs as a "linked device" of the user's WhatsApp account, the same way WhatsApp Web or WhatsApp Desktop would.
- Messages, reactions, edits, deletes, polls, presence, and history requests are sent to and received from WhatsApp's servers directly. No claude-whatsapp service sits in between.
- WhatsApp's [Terms of Service](https://www.whatsapp.com/legal/terms-of-service) and [Privacy Policy](https://www.whatsapp.com/legal/privacy-policy) apply to all data exchanged with WhatsApp's servers.

Because Baileys is **unofficial**, this may violate WhatsApp's Terms of Service. Account bans are possible. Use only with your own personal account, at low volume, and at your own risk. See the [README disclaimer](./README.md#disclaimer) for the full warning.

### 4.2 Opt-in features

The plugin can integrate with additional services, but **only when the user explicitly enables them**. Data sent to these services is governed by each provider's own privacy policy.

| Feature | Provider | When it activates | Data sent |
|---|---|---|---|
| Local voice transcription (default) | Hugging Face (model download) | First voice message after `/whatsapp:configure audio <lang>` while `audioProvider` is `"local"` | None at runtime; the Whisper model file is downloaded once from Hugging Face's CDN, then cached locally and used offline. The audio itself never leaves the machine. |
| Cloud voice transcription — Groq (opt-in) | Groq (`api.groq.com`) | Each inbound voice note while `audioProvider` is `"groq"` and `GROQ_API_KEY` is set | The raw OGG/Opus audio file (typically a few KB to ~1 MB per voice note) is uploaded to Groq's `/audio/transcriptions` endpoint along with the configured language code. The transcript is returned in the response. Audio handling on the Groq side is governed by [Groq's privacy policy](https://groq.com/privacy). |
| Cloud voice transcription — OpenAI (opt-in) | OpenAI (`api.openai.com`) | Each inbound voice note while `audioProvider` is `"openai"` and `OPENAI_API_KEY` is set | Same as above against OpenAI's `/audio/transcriptions` endpoint with the `whisper-1` model. Governed by [OpenAI's privacy policy](https://openai.com/policies/privacy-policy). |
| Permission relay | Claude Code (host process) | When Claude Code emits a `permission_request` notification | The plugin relays the prompt to the user's allowlisted DM contacts via WhatsApp. The decision (`allow` / `deny`) is sent back to Claude Code locally. |

The cloud transcription providers are strictly opt-in: the default is `"local"` and the user must explicitly run `/whatsapp:configure audio provider groq` (or `openai`) and set the matching API key in their shell environment for any audio to be uploaded. Speech-to-text otherwise runs locally via the bundled `@huggingface/transformers` runtime against an ONNX-quantized Whisper model.

If a cloud transcription request fails (missing key, network error, rate limit, auth error), the plugin falls back to local Whisper for that message — so a transient cloud outage doesn't push audio anywhere unexpected. The fallback is logged to `logs/system.log`.

## 5. Auth credentials

When the user pairs their WhatsApp number, Baileys negotiates and stores session keys in `auth/` inside the channel directory. These keys grant access to the linked WhatsApp account.

- The directory is created with `0700` permissions; individual files with `0600`.
- The plugin re-tightens these permissions on every server start, and after every Baileys `creds.update` event.
- The keys are never transmitted to the plugin author or any third party.
- The keys are presence-only from the perspective of any other plugin that tries to detect us — the published [state contract](./README.md#state-contract-for-companion-plugins) explicitly marks `auth/` as not-for-external-reading.

If the user logs out of the linked device from their phone, the keys become invalid. `/whatsapp:configure reset` removes them locally.

## 6. Group participants

When a WhatsApp group is allowed via `/whatsapp:access add-group`, the plugin indexes inbound messages from that group's participants into `messages.db` (sender JID, push name, timestamp, message body) so the local `search_messages`, `fetch_history`, and `export_chat` tools can serve queries.

The plugin does not transmit group participant data anywhere — it stays in the local database. Users adding the bot to groups are responsible for complying with WhatsApp's terms and any local laws around recording or processing other participants' messages, including obtaining required consent.

Cross-chat boundaries are enforced server-side: the nine read/exfil tools (`search_messages`, `fetch_history`, `export_chat`, `list_group_senders`, `get_message_context`, `get_chat_analytics`, `list_chats`, `search_contact`, `forward_message`) are gated so that a user in one chat cannot have the agent surface indexed history from another chat. The owner (`ownerJids`) is the single exception with cross-chat access. Non-owner chats are sandboxed to their own history by default; configurable via per-chat `historyScope`. Full model: [docs/access.md#history-scope](docs/access.md#history-scope).

## 7. User-provided content and responsibility

The user decides what to put into the access list, what groups to allow, and how to configure transcription and indexing. The plugin does not classify, redact, or filter content.

When using claude-whatsapp on a personal WhatsApp number, the user is responsible for:
- Complying with WhatsApp's Terms of Service.
- Obtaining any consent required from other participants in conversations the bot can read.
- Not exposing the agent to chats containing material the user is not permitted to process automatically (e.g. regulated personal data, information about minors).

## 8. Children's privacy

claude-whatsapp is a developer tool and is not directed at children under 13. The plugin does not knowingly collect information from children.

## 9. Security

Because all data is local, security is primarily a function of the user's own machine: filesystem permissions, disk encryption, and the secrecy of the auth directory. Users should protect their channel directory like any other secret-bearing location.

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## 10. Changes to this policy

If this policy changes materially, the change will be reflected here and noted in the [CHANGELOG](./CHANGELOG.md).
