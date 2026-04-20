# Operations

Running the WhatsApp agent reliably over days or weeks: turning it into a background service, updating safely, clearing cache, juggling multiple numbers, and reading the logs when something looks off. If you're diagnosing a specific symptom, jump to [docs/troubleshooting.md](troubleshooting.md) — this doc is the "how it fits together" side.

- [Background service](#background-service)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Clearing cache](#clearing-cache)
- [Multi-instance and the single-instance lock](#multi-instance-and-the-single-instance-lock)
- [Multiple agents / multiple numbers](#multiple-agents--multiple-numbers)
- [Logs](#logs)
- [Reconnection behavior](#reconnection-behavior)
- [Graceful shutdown](#graceful-shutdown)

---

## Background service

To keep the agent running permanently, wrap Claude Code with your platform's process manager.

### macOS (launchd)

Create `~/Library/LaunchAgents/com.whatsapp-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.whatsapp-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>claude</string>
        <string>--dangerously-load-development-channels</string>
        <string>plugin:whatsapp@claude-whatsapp</string>
        <string>--dangerously-skip-permissions</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/my-whatsapp-agent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/whatsapp-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/whatsapp-agent.err</string>
</dict>
</plist>
```

Load it:

```sh
launchctl load ~/Library/LaunchAgents/com.whatsapp-agent.plist
```

Tail `/tmp/whatsapp-agent.log` for live output; the channel's own system log lives under `<channel-dir>/logs/system.log`.

### Linux (systemd)

Create `~/.config/systemd/user/whatsapp-agent.service`:

```ini
[Unit]
Description=WhatsApp Agent (Claude Code)

[Service]
WorkingDirectory=/home/YOUR_USER/my-whatsapp-agent
ExecStart=claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Enable and start:

```sh
systemctl --user enable --now whatsapp-agent
```

Journal logs via `journalctl --user -u whatsapp-agent -f`.

### Windows (Task Scheduler)

Create a scheduled task that runs at login:

- **Action**: `claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions`
- **Start in**: your agent folder (the one that contains `.whatsapp/`)
- **Triggers**: "At log on"
- **Conditions**: uncheck "Start only if on AC power" if it's a laptop you sometimes run unplugged.

---

## Updating

```
/plugin update whatsapp@claude-whatsapp
```

The update path is designed to be non-destructive:

1. `/plugin update` pulls the new version into the plugin cache.
2. Close Claude Code (`/exit` or Ctrl+C).
3. Relaunch with the same command you've been using.
4. **Wait for the "dependencies installed" notification** (~60s the first time after a new release that bumped deps). The plugin writes `status: "deps_missing"` while the install runs and transitions out automatically.
5. Run `/reload-plugins` — brings the new version cleanly online without needing to fully restart.
6. Optionally run `/whatsapp:configure` to check the live status.

**What survives an update** (preserved across all updates):

- `auth/` — your WhatsApp session. No QR re-scan needed.
- `access.json` — allowlists and group configs.
- `config.json` — all your settings (audio, chunking, etc.).
- `messages.db` — the indexed message history.
- `inbox/` — downloaded media and exports.
- `logs/` — conversation and system logs.

**What doesn't survive**: nothing, under normal updates. If the update path ever needs a breaking migration, that'll ship behind a major version bump with explicit notes in `CHANGELOG.md`.

> **Don't restart Claude Code while `status: "deps_missing"` is active.** That aborts the in-progress install and puts you back at step 1. Just wait.

---

## Uninstalling

```
/plugin uninstall whatsapp@claude-whatsapp
```

Removes the plugin code. What's left on disk afterward:

- `<channel-dir>/` in full — session, access, config, history.
- The plugin cache at `~/.claude/plugins/cache/claude-whatsapp/`.

To wipe your WhatsApp state entirely, delete the channel dir too:

```sh
# Local-scope install:
rm -rf <your-project>/.whatsapp

# Global fallback:
rm -rf ~/.claude/channels/whatsapp
```

Both operations are fully reversible only by re-linking WhatsApp and re-doing access setup.

---

## Clearing cache

If reinstall fails or the plugin starts behaving unexpectedly after an update, clear the plugin cache and reinstall:

```sh
# Close Claude Code first.
rm -rf ~/.claude/plugins/cache/claude-whatsapp
```

Then reopen Claude Code and install again:

```
/plugin install whatsapp@claude-whatsapp
```

Your `<channel-dir>` is untouched by this — clearing the cache wipes the plugin binaries, not your session.

---

## Multi-instance and the single-instance lock

WhatsApp Web allows only one linked device connection per account at a time. Two processes running Baileys against the same auth dir kick each other off every few seconds (status 440), looping forever and risking a temp-ban for the re-handshake rate.

The plugin guards against this with a single-instance lock at:

```
<channel-dir>/server.pid
```

On startup, the plugin tries to atomically create that file with its own PID. Three outcomes:

| Outcome | Status | Effect |
|---|---|---|
| Created cleanly | `connected` (after link) | Normal. |
| File exists, PID is alive | `idle_other_instance` | MCP server stays up for tool calls, but the WhatsApp connection is skipped. Tool calls return errors like "WhatsApp is not connected". |
| File exists, PID is stale | reclaims the lock | A previous crash; the plugin re-grabs the lock and proceeds. |
| File exists but unreadable/corrupt | reclaims the lock | Best-effort recovery. |

What this means in practice: **two Claude Code sessions in the same workspace won't fight over WhatsApp**. The second session sees `idle_other_instance` and stays idle. Close the extra session, or wait for the holder to exit — the lock is released on graceful shutdown (`SIGTERM`, stdin close) and on a parent-process-death detection (PPID-change watchdog that fires every 5 seconds).

If you see `idle_other_instance` when you genuinely have only one session open, there's a stale PID file whose holder is still technically alive (zombie, daemonized Node process). Find it:

```sh
cat <channel-dir>/server.pid
ps -p <that-pid>
```

If the listed PID isn't actually a claude-whatsapp server, stop that process (or reboot), then delete the lock file and relaunch.

---

## Multiple agents / multiple numbers

Each agent folder has its own channel directory, its own WhatsApp session, and its own access control. To run two numbers in parallel, use two folders:

```
~/agent-sales/.whatsapp/      ← WhatsApp #1
~/agent-support/.whatsapp/    ← WhatsApp #2
```

Install the plugin in each folder with **local scope** (select "Install for you, in this repo only" when prompted). Launch each with its own `cd` + `claude` command, or set up two background services (see [Background service](#background-service) above) with different `WorkingDirectory` values.

They won't collide on the lock — different `<channel-dir>` means different `server.pid` paths. Each connects to its own WhatsApp account independently.

What you **can't** do: run two instances against the *same* number. They'll knock each other off (Baileys status 440) every ~5 seconds. If you need multi-process redundancy for uptime, put one process on one machine and another on a warm standby, not both active at once.

---

## Logs

Two kinds, in two places.

### `logs/conversations/YYYY-MM-DD.jsonl` and `YYYY-MM-DD.md`

Every delivered inbound and every outbound reply is appended to two files per day:

**JSONL** — one JSON object per line, ideal for programmatic access, RAG, and memory systems:

```jsonl
{"ts":"2026-04-19T14:22:31.000Z","direction":"in","user":"Juan","text":"Hello","chat_id":"5491155556666@s.whatsapp.net"}
{"ts":"2026-04-19T14:22:58.000Z","direction":"out","user":"Claude","text":"Hi! How can I help?","chat_id":"5491155556666@s.whatsapp.net"}
```

**Markdown** — the same traffic rendered as a transcript:

```
**← Juan** (14:22:31): Hello

**→ Claude** (14:22:58): Hi! How can I help?
```

Arrows: `←` inbound, `→` outbound. Timestamps are UTC in the JSONL, `HH:MM:SS` local in the markdown header.

These files are append-only; the plugin doesn't rotate or delete them. For long-running installs, consider a periodic job that archives files older than N days (a simple `find logs/conversations -name "*.jsonl" -mtime +30 -exec gzip {} \;` is often enough).

### `logs/system.log`

Server events — connection state changes, Baileys disconnects, dropped group discoveries, transcription init, permission-request broadcasts, lock acquisitions. Plain text, one line per event:

```
[2026-04-19T14:20:01.123Z] WhatsApp connected successfully
[2026-04-19T14:22:31.456Z] connection closed (status 428), retry #1 in 2s
[2026-04-19T14:24:10.789Z] unknown group dropped a message: 120363xxx@g.us (sender push name: Juan) — allow with /whatsapp:access add-group 120363xxx@g.us
```

Don't parse this programmatically — the message text is not part of the [state contract](state-contract.md#stability-policy). Grep it for debugging, not for building UIs.

---

## Reconnection behavior

When the WhatsApp connection drops, the plugin reconnects automatically with exponential backoff + jitter:

- **Base delay**: 2 seconds.
- **Doubling** on each consecutive failure (2s → 4s → 8s → …).
- **Cap**: 5 minutes (roughly 8 failures in).
- **Jitter**: ±30% added to every delay, so colliding instances (or two agents the user forgot about) desynchronize rather than retry in lock-step forever.
- **Stable-connection reset**: if a connection lasted ≥30 seconds before closing, the failure counter resets — that disconnect is treated as the first of a fresh streak.

During reconnect, `<channel-dir>/status.json` holds:

```json
{
  "status": "reconnecting",
  "attempt": 3,
  "nextDelayMs": 8000,
  "ts": 1713543200000
}
```

**If you see a steady cadence (always retrying every ~5s, no growth)**, that's the old fixed-retry behavior or something forcing it — most likely two instances fighting over the same auth dir. Check for another running claude-whatsapp:

```sh
ps ax | grep 'plugin:whatsapp'
cat <channel-dir>/server.pid
```

Close the extra one; the survivor reconnects cleanly.

---

## Graceful shutdown

The plugin shuts down on:

- `SIGTERM` / `SIGINT` — standard process signals (Ctrl+C, `kill <pid>`).
- stdin close — Claude Code terminating its subprocess normally.
- Parent-death watchdog — PPID change detected every 5 seconds, covers the case where Claude Code crashes without closing stdin.

Shutdown releases the lock, closes the SQLite connection, ends the Baileys socket, then exits within 2 seconds. Long-running tool calls are allowed to finish within that window; anything exceeding it is aborted when the process exits.

This is why the plugin doesn't need manual "stop the bot" steps — closing Claude Code is always the right path.
