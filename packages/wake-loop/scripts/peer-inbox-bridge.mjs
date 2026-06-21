#!/usr/bin/env node
// peer-inbox-bridge.mjs
//
// Host-resident bridge that makes a persistent cross-PC orchestrator-mode
// worker auto-process team-inbox messages addressed to it WITHOUT a manual
// SSH-inject by the operator.
//
// Topology: the team inbox lives on THIS host (the relvetia-team server host),
// at ~/.claude/teams/<team>/inboxes/<agent>.json. The worker's orchestrator
// inject queue lives on a REMOTE PC. This bridge watches the local inbox and
// SSH-injects each new message into the remote worker's queue (the proven
// driving path); the worker then replies to the sender via team_send_message.
//
// Transport safety: the message text (any language / quotes / arbitrary
// chars) is written to a temp file, scp'd to the remote, and fed to
// orchestrator-inject via STDIN. Content never rides a command line, so no
// ssh->cmd->bash quoting issues and no encoding mangling.
//
// No-loop: the worker's replies go to the SENDER's inbox, never back into its
// own inbox, so relaying does not feed itself. Messages from the worker's own
// agent name are skipped defensively.
//
// Config resolution (per key): env var -> ~/.claude/relvetia/peer-stack.config.json
//   (bridge.* or top-level) -> built-in default. The JSON config is gitignored
//   (per-PC; holds the LAN-specific SSH target etc.); committed code is generic.
//
// Required config: sshTarget (e.g. "<user>@<host>"). Without it the bridge
// stays idle and logs a warning rather than crash-looping.
//
// Dependency-free: node builtins only. Runs under PM2 on the server host.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

function loadFileConfig() {
  const p = path.join(HOME, '.claude', 'relvetia', 'peer-stack.config.json')
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return {} }
}
const FILE_CFG = loadFileConfig()
function cfg(envKey, fileKey, dflt) {
  if (typeof process.env[envKey] === 'string' && process.env[envKey].length > 0) return process.env[envKey]
  const br = FILE_CFG.bridge || {}
  if (fileKey in br && br[fileKey] != null && `${br[fileKey]}`.length > 0) return `${br[fileKey]}`
  if (fileKey in FILE_CFG && FILE_CFG[fileKey] != null && `${FILE_CFG[fileKey]}`.length > 0) return `${FILE_CFG[fileKey]}`
  return dflt
}

const SSH_TARGET = cfg('PEER_SSH_TARGET', 'sshTarget', '')
const ORCH = cfg('PEER_ORCH_SESSION_ID', 'orchSessionId', 'peer-standby')
const TEAM = cfg('PEER_TEAM', 'team', 'sisters')
const AGENT = cfg('PEER_AGENT', 'agent', 'peer')
const POLL_MS = Number.parseInt(cfg('PEER_POLL_MS', 'pollMs', '5000'), 10) || 5000
const MAX_TEXT = Number.parseInt(cfg('PEER_MAX_TEXT', 'maxText', '1200'), 10) || 1200
const BASH_PATH = cfg('PEER_REMOTE_BASH', 'bashPath', 'C:\\Program Files\\Git\\bin\\bash.exe')
const REMOTE_SCRIPTS = cfg('PEER_REMOTE_SCRIPTS_DIR', 'remoteScriptsDir', '~/.claude/scripts/relvetia')
const PROMPT_NAME = 'inbox-prompt.txt'

const INBOX = path.join(HOME, '.claude', 'teams', TEAM, 'inboxes', `${AGENT}.json`)
const STATE = path.join(HOME, '.claude', 'relvetia', `.peer-inbox-bridge-${TEAM}-${AGENT}.state.json`)
const TMP_PROMPT = path.join(HOME, `.peer-inbox-bridge-${TEAM}-${AGENT}.prompt.txt`)

// Built at runtime so orch id / paths are configurable (no magic base64 const).
function buildEncodedRunner() {
  const runner =
    `& '${BASH_PATH}' -lc 'node ${REMOTE_SCRIPTS}/orchestrator-inject.mjs inject --orch ${ORCH} < ~/${PROMPT_NAME}; rm -f ~/${PROMPT_NAME}'`
  return Buffer.from(runner, 'utf16le').toString('base64')
}
const ENC_INJECT = buildEncodedRunner()

function log(m) { console.log(`[${new Date().toISOString()}] [peer-inbox-bridge] ${m}`) }

function parseInbox(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return []
  const t = raw.trimStart()
  if (t.startsWith('[')) { try { const a = JSON.parse(raw); return Array.isArray(a) ? a : [] } catch { return [] } }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { const o = JSON.parse(line); if (o && typeof o === 'object') out.push(o) } catch {}
  }
  return out
}

function cursorOf(m) {
  return (m && typeof m.timestamp === 'string' && m.timestamp) ||
         (m && typeof m.ts === 'string' && m.ts) || ''
}

function loadCursor() { try { return JSON.parse(readFileSync(STATE, 'utf8')).cursor ?? null } catch { return null } }
function saveCursor(cursor) {
  mkdirSync(path.dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify({ cursor, updated_at: new Date().toISOString() }, null, 2))
}

function buildPrompt(m) {
  const from = (typeof m.from === 'string' && m.from) ? m.from : 'unknown'
  const text = (typeof m.text === 'string' ? m.text : '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  return `[${TEAM} inbox-relay auto] You are ${AGENT}. A new ${TEAM}-team message was auto-relayed to you (no manual inject needed). from=${from}. message: ${text} . Action: handle this message and reply to the sender via the mcp__relvetia-team__team_send_message tool (team_name=${TEAM}, from=${AGENT}, to=${from}). If no action is required, send a brief acknowledgement. Then you are finished.`
}

// Hard timeouts in addition to ssh's own ConnectTimeout: execFileSync blocks
// the event loop, so a stuck scp/ssh (e.g. a half-open connection that gets
// past connect) must not wedge the poll loop forever. On timeout these throw
// and the caller leaves the cursor unadvanced to retry next tick.
const SCP_TIMEOUT_MS = 30000
const SSH_TIMEOUT_MS = 45000

function injectToRemote(prompt) {
  writeFileSync(TMP_PROMPT, prompt, 'utf8')
  execFileSync('scp', ['-q', '-o', 'ConnectTimeout=15', TMP_PROMPT, `${SSH_TARGET}:${PROMPT_NAME}`],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout: SCP_TIMEOUT_MS })
  execFileSync('ssh', ['-o', 'ConnectTimeout=20', SSH_TARGET, 'powershell', '-NoProfile', '-EncodedCommand', ENC_INJECT],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: SSH_TIMEOUT_MS })
}

let cursor = loadCursor()

function tick() {
  if (!SSH_TARGET) return // already warned at startup; stay idle until configured
  let raw
  try { raw = readFileSync(INBOX, 'utf8') }
  catch (e) { if (e.code !== 'ENOENT') log(`inbox read error: ${e.message}`); return }
  const msgs = parseInbox(raw)

  if (cursor === null) {
    let max = ''
    for (const m of msgs) { const c = cursorOf(m); if (c > max) max = c }
    cursor = max
    saveCursor(cursor)
    log(`init cursor=${cursor || '(empty)'} (skipped ${msgs.length} existing)`)
    return
  }

  const fresh = msgs
    .filter(m => cursorOf(m) > cursor && m.from !== AGENT)
    .sort((a, b) => (cursorOf(a) < cursorOf(b) ? -1 : 1))

  for (const m of fresh) {
    const c = cursorOf(m)
    try {
      log(`relaying msg from=${m.from} ts=${c}`)
      injectToRemote(buildPrompt(m))
      cursor = c
      saveCursor(cursor)
      log(`relayed + cursor -> ${c}`)
    } catch (e) {
      log(`inject failed (retry next tick): ${e.message}`)
      break // do not advance cursor
    }
  }
}

if (!SSH_TARGET) {
  log('WARNING: sshTarget not configured (env PEER_SSH_TARGET or peer-stack.config.json bridge.sshTarget). Bridge idle.')
}
log(`starting (inbox=${INBOX}, orch=${ORCH}, remote=${SSH_TARGET || '(unset)'}, poll=${POLL_MS}ms)`)
tick()
setInterval(tick, POLL_MS)
