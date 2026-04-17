#!/usr/bin/env node

// Bootstrap: installs deps on first launch while keeping the MCP connection alive.
// Written in vanilla JS (zero deps) — never crashes, even without node_modules.
// After deps install, tells Claude to /reload-plugins to start the real server.

import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const marker = join(__dirname, 'node_modules', '@modelcontextprotocol')

// Capture the cwd Claude Code launched us from — this is the user's project dir.
// We forward it to server.ts so detectProjectDir() can pick the right entry when
// the plugin is installed in more than one project.
const launchCwd = process.cwd()

if (existsSync(marker)) {
  // Deps exist — launch real server, pass through stdin/stdout
  const tsx = join(__dirname, 'node_modules', '.bin', 'tsx')
  const child = spawn(tsx, [join(__dirname, 'server.ts')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_WHATSAPP_LAUNCH_CWD: launchCwd },
  })
  child.on('exit', (code) => process.exit(code ?? 0))
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  process.on('SIGINT', () => child.kill('SIGINT'))

  // Parent-death watchdog. With stdio: 'inherit' we share the parent's stdin
  // FD, but no one in this branch reads it, so 'end'/'close' never emit.
  // PPID change is the bulletproof signal that Claude Code exited and we got
  // reparented — without this, an orphaned bootstrap+server pair lingers
  // forever, fighting any new instance for the WhatsApp auth.
  const ORIGINAL_PPID = process.ppid
  setInterval(() => {
    if (process.ppid !== ORIGINAL_PPID) {
      process.stderr.write(`whatsapp bootstrap: parent exited (ppid ${ORIGINAL_PPID} → ${process.ppid}), terminating child\n`)
      child.kill('SIGTERM')
      setTimeout(() => process.exit(0), 2000).unref()
    }
  }, 5000).unref()
} else {
  // First launch — handle MCP protocol while installing deps in background
  const rl = createInterface({ input: process.stdin })
  let installing = true

  // Respond to MCP messages
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
            serverInfo: { name: 'whatsapp', version: '1.1.0' },
            instructions: 'WhatsApp plugin is installing dependencies for the first time. Tell the user to wait ~60 seconds, then run /reload-plugins to activate.',
          },
        })
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } })
      } else if (msg.id) {
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
    } catch { /* ignore */ }
  })

  rl.on('close', () => process.exit(0))

  function send(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }

  // Install deps in background
  process.stderr.write('whatsapp: installing dependencies (first time only)...\n')
  const npm = spawn('npm', ['install', '--silent'], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  npm.on('close', (code) => {
    installing = false
    if (code === 0) {
      process.stderr.write('whatsapp: dependencies installed!\n')
      // Send channel notification so Claude tells the user
      send({
        method: 'notifications/claude/channel',
        params: {
          content: 'WhatsApp dependencies installed! Tell the user to run /reload-plugins to activate, then /whatsapp:configure.',
          meta: {
            chat_id: 'system',
            message_id: 'deps-ready-' + Date.now(),
            user: 'system',
            user_id: 'system',
            ts: new Date().toISOString(),
          },
        },
        jsonrpc: '2.0',
      })
      // Exit so /reload-plugins launches a fresh bootstrap that finds deps and runs server.ts
      setTimeout(() => process.exit(0), 2000)
    } else {
      process.stderr.write('whatsapp: npm install failed\n')
    }
  })
}
