# Security Policy

claude-whatsapp is a local-first plugin for Claude Code. It runs entirely on the user's machine and does not operate any hosted service. Security reports are still very welcome.

## Reporting a vulnerability

If you find a security issue in this plugin, please report it via:

- **GitHub Security Advisories** (preferred): https://github.com/crisandrews/claude-whatsapp/security/advisories/new — opens a private channel with the maintainer.
- **GitHub Issues**: https://github.com/crisandrews/claude-whatsapp/issues — for non-sensitive reports, or as a fallback if the security advisory flow is unavailable. Please prefix the title with `[security]` and avoid posting exploit details in the issue body until a fix is available.

Please give the maintainer a reasonable window to respond (target: first acknowledgement within 7 days, fix or mitigation within 30 days for high-severity issues) before public disclosure.

## What's in scope

The code in this repository:

- `server.ts`, `lib.ts`, `db.ts`, `bootstrap.mjs`
- The `skills/` directory
- The published `<channel-dir>/*` state contract (`access.json`, `config.json`, `recent-groups.json`, `status.json`, etc.) — bugs that let an attacker bypass access control, read auth credentials from outside the plugin, or exfiltrate state via the channel surface.
- The MCP tool surface (`reply`, `react`, `edit_message`, `delete_message`, `send_poll`, `download_attachment`, `search_messages`, `fetch_history`, `list_group_senders`, `export_chat`) — bugs that let untrusted channel input trigger unintended tool calls, file access outside the inbox directory, or other privilege escalation.
- The permission relay protocol implementation — bugs that let an attacker approve or deny a tool decision without authorization.

## What's out of scope

- **Baileys upstream** ([@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)). Vulnerabilities in the WhatsApp Web client itself should be reported to that project. We pin a specific Baileys version in `package.json` and pull updates as they ship — security fixes flow through to users via plugin version bumps.
- **WhatsApp itself** (Meta). Vulnerabilities in WhatsApp's protocol, server, or apps are not in scope here.
- **Claude Code** (the host). Vulnerabilities in the Claude Code CLI, MCP framework, or skill loader belong upstream.
- **Other plugins** — including, but not limited to, [ClawCode](https://github.com/crisandrews/ClawCode). If a bug only manifests when claude-whatsapp interacts with another plugin and the root cause is in that other plugin, route the report there. Cross-plugin coordination bugs that require both sides to fix are welcome here.

## What is *not* a security bug

- A user's WhatsApp number being banned by Meta for using an unofficial client. This is a known, documented risk — see the [README disclaimer](./README.md#disclaimer).
- Inability to use the plugin on a WhatsApp Business account. The plugin only supports personal accounts (Baileys is a WhatsApp Web client).
- Loss of session if the user logs out of the linked device from their phone. Re-pair to restore.
- Behavior changes when running multiple instances against the same WhatsApp number. WhatsApp Web allows only one device per credentials. Run only one instance per number.

## Disclosure

Once a fix is available, the security advisory (or issue, if used as a fallback) will be made public with credit to the reporter (unless they prefer to remain anonymous). The fix will be noted in `CHANGELOG.md` under a `### Security` group and announced in the corresponding GitHub release.
