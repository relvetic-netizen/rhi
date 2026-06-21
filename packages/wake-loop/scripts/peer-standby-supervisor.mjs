#!/usr/bin/env node
// peer-standby-supervisor.mjs
//
// Keep-alive supervisor for a persistent orchestrator-mode worker
// ("peer-standby" by default). PM2 supervises THIS lightweight process
// (fork mode); this process keeps the heavy PTY wrapper (node
// pty-wrapper.mjs running claude in a ConPTY) alive by re-spawning it via
// the proven spawn-relay path whenever it is not running.
//
// Two-layer design (not "PM2 runs the wrapper directly") because:
//   - spawn-relay's maybeRegisterOrchestrator writes the full orchestrator
//     registry (inject_dir + inject_file + owner_pid) on every spawn, so the
//     inject sender side always resolves the right queue path. A bare wrapper
//     launched by PM2 would not register, and the wrapper deletes the registry
//     on exit — driving would break after a restart.
//   - The wrapper runs detached via Start-Process (Hidden ConPTY), the path
//     already proven to accept dev-channels and process injects.
//
// Lifecycle: boot/logon (pm2 resurrect) -> this starts -> tick() finds no
// wrapper -> spawn. Wrapper crash -> next tick (<=checkMs) re-spawns. PM2
// restarts this while a wrapper is alive -> wrapperRunning() (WMI cmdline
// ground truth) prevents a duplicate spawn.
//
// Config resolution (per key): env var  ->  ~/.claude/relvetia/peer-stack.config.json
//   -> built-in default. The JSON config is gitignored (per-PC, holds any
//   host-specific values); the committed code stays generic.
//
// Dependency-free: node builtins only. spawn-relay is invoked via CLI.

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
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
  const sup = FILE_CFG.supervisor || {}
  if (fileKey in sup && sup[fileKey] != null && `${sup[fileKey]}`.length > 0) return `${sup[fileKey]}`
  if (fileKey in FILE_CFG && FILE_CFG[fileKey] != null && `${FILE_CFG[fileKey]}`.length > 0) return `${FILE_CFG[fileKey]}`
  return dflt
}

const ORCH = cfg('PEER_ORCH_SESSION_ID', 'orchSessionId', 'peer-standby')
const CWD = cfg('PEER_CWD', 'cwd', HOME)
const TEAM = cfg('PEER_TEAM', 'team', 'sisters')
const AGENT = cfg('PEER_AGENT', 'agent', 'peer')
const CHECK_MS = Number.parseInt(cfg('PEER_CHECK_MS', 'checkMs', '30000'), 10) || 30000
const SPAWN_RELAY = path.join(HOME, '.claude', 'scripts', 'relvetia', 'spawn-relay.mjs')

// claude binary: explicit config wins; else the common native-install location
// (~/.local/bin/claude.exe), else fall through to spawn-relay's own resolver.
function resolveClaudeBin() {
  const explicit = cfg('PEER_CLAUDE_BIN', 'claudeBin', '')
  if (explicit) return explicit
  const local = path.join(HOME, '.local', 'bin', 'claude.exe')
  if (existsSync(local)) return local
  return '' // empty -> do not pass --claude-bin; spawn-relay resolves from PATH
}
const CLAUDE_BIN = resolveClaudeBin()
const ENV_JSON = JSON.stringify({ RELVETIA_TEAM: TEAM, RELVETIA_AGENT: AGENT })

// After a spawn, skip re-spawning for this long. spawn-relay launches the
// wrapper detached (Start-Process); the new node pty-wrapper process can take
// a moment to surface in WMI (worse under a boot/resurrect storm). Without a
// cooldown a transient "not seen" (WMI lag or a fail-open powershell error)
// on the next tick would spawn a SECOND wrapper that drives the same queue
// (peer review P0-1). The cooldown bridges that exposure window.
const SPAWN_COOLDOWN_MS = Number.parseInt(cfg('PEER_SPAWN_COOLDOWN_MS', 'spawnCooldownMs', '90000'), 10) || 90000
// Hard timeouts so a hung child never wedges the supervisor's event loop
// (peer review P0-2): execFileSync blocks; without a timeout a stuck powershell
// or spawn-relay would freeze ticks/logs and self-recovery dies.
const WMI_TIMEOUT_MS = 15000
const SPAWN_TIMEOUT_MS = 90000
const CRASHLOOP_ALERT_AT = 3 // consecutive (re)spawns with no "alive" tick between

let lastSpawnAtMs = 0
let respawnStreak = 0

function log(m) {
  console.log(`[${new Date().toISOString()}] [peer-standby-supervisor] ${m}`)
}

// Ground truth: is a node process running pty-wrapper.mjs for this orch id?
// WMI cmdline match avoids PID-reuse false positives across reboots. No
// double quotes in the PS command — execFileSync -> powershell escapes
// embedded `"` as `\"`, which PowerShell -Command mis-parses.
function wrapperRunning() {
  try {
    const psCmd =
      `Get-CimInstance Win32_Process | ` +
      `Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*pty-wrapper*' -and $_.CommandLine -like '*${ORCH}*' } | ` +
      `Measure-Object | Select-Object -ExpandProperty Count`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], { encoding: 'utf8', timeout: WMI_TIMEOUT_MS })
    return Number.parseInt(out.trim(), 10) > 0
  } catch (e) {
    // Fail-open to "not running". On its own that risks a spurious spawn, but
    // the SPAWN_COOLDOWN_MS gate in tick() bounds it to at most one spawn per
    // cooldown window (peer review P0-1).
    log(`wrapperRunning check error: ${e?.message || e}`)
    return false
  }
}

function spawnStandby() {
  log('spawning standby via spawn-relay...')
  const args = [
    SPAWN_RELAY, 'spawn',
    '--orchestrator-mode', '--orch-session-id', ORCH,
    '--enable-channels', '--auto-accept-dev-channels',
    '--env-json', ENV_JSON,
    '--cwd', CWD,
  ]
  if (CLAUDE_BIN) { args.push('--claude-bin', CLAUDE_BIN) }
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS })
    log(`spawn-relay output: ${out.replace(/\s+/g, ' ').trim().slice(0, 240)}`)
  } catch (e) {
    // Timeout (or spawn-relay error) is caught so the event loop never wedges
    // (peer review P0-2). Next eligible tick retries after the cooldown.
    log(`spawn error: ${e?.message || e}`)
  }
}

function tick() {
  if (wrapperRunning()) {
    if (respawnStreak > 0) log(`wrapper alive — recovered after ${respawnStreak} respawn(s)`)
    respawnStreak = 0
    log('wrapper alive — no action')
    return
  }
  // Cooldown gate (P0-1): do not re-spawn within SPAWN_COOLDOWN_MS of the last
  // spawn, so WMI lag right after a spawn cannot trigger a duplicate wrapper.
  const since = Date.now() - lastSpawnAtMs
  if (lastSpawnAtMs > 0 && since < SPAWN_COOLDOWN_MS) {
    log(`wrapper not seen but within spawn cooldown (${Math.round(since / 1000)}s/${Math.round(SPAWN_COOLDOWN_MS / 1000)}s) — skipping`)
    return
  }
  respawnStreak += 1
  if (respawnStreak >= CRASHLOOP_ALERT_AT) {
    // Crash-loop suspected: wrapper keeps dying between cooldowns (bad bin /
    // broken config). Keep trying (self-heal intent) but make it loud (P1-3).
    log(`ALERT: crash-loop suspected — ${respawnStreak} consecutive respawns with no healthy tick`)
  }
  log('wrapper NOT running — (re)spawning')
  lastSpawnAtMs = Date.now()
  spawnStandby()
}

log(`starting (orch=${ORCH}, cwd=${CWD}, team=${TEAM}, agent=${AGENT}, claudeBin=${CLAUDE_BIN || '(PATH)'}, check=${CHECK_MS}ms)`)
tick()
setInterval(tick, CHECK_MS)
