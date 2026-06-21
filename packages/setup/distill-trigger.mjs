/**
 * distill-trigger.mjs — SessionStart hook for Standard profile.
 *
 * Gates on profile, log volume, cooldown, and lock, then spawns
 * background distillation via `claude --print -p <prompt>`.
 *
 * Zero external dependencies — pure Node.js (ESM).
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, unlinkSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const TAG = '[rhi-distill]'

// ── Config ──────────────────────────────────────────────────────────────

const configPath = join(homedir(), '.claude', 'rhi', 'config.json')
if (!existsSync(configPath)) process.exit(0)

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch {
  process.exit(0)
}

if (config.profile !== 'standard') process.exit(0)

let memoryDir = config.memory?.dir
if (memoryDir?.startsWith('~')) {
  memoryDir = join(homedir(), memoryDir.slice(1))
}
if (!memoryDir || !existsSync(memoryDir)) {
  console.log(`${TAG} Skipping: memory dir not found (${memoryDir})`)
  process.exit(0)
}

// ── Log volume gate ─────────────────────────────────────────────────────

const logsDir = join(memoryDir, 'logs')
if (!existsSync(logsDir)) {
  console.log(`${TAG} Skipping: no logs directory`)
  process.exit(0)
}

function countLogFiles(dir) {
  let count = 0
  function walk(d) {
    for (const item of readdirSync(d, { withFileTypes: true })) {
      if (item.isDirectory()) walk(join(d, item.name))
      else if (item.name.endsWith('.md')) count++
    }
  }
  walk(dir)
  return count
}

const logFileCount = countLogFiles(logsDir)
if (logFileCount < 3) {
  console.log(`${TAG} Skipping: not enough log data yet (${logFileCount} files)`)
  process.exit(0)
}

// ── Cooldown gate ───────────────────────────────────────────────────────

const cooldownHours = config.distillation?.cooldownHours ?? 8
const lastDistillPath = join(memoryDir, '.last-distill')

if (existsSync(lastDistillPath)) {
  const mtime = statSync(lastDistillPath).mtimeMs
  const elapsedMs = Date.now() - mtime
  const cooldownMs = cooldownHours * 3600 * 1000
  if (elapsedMs < cooldownMs) {
    const remainH = ((cooldownMs - elapsedMs) / 3600000).toFixed(1)
    console.log(`${TAG} Skipping: cooldown (${remainH}h remaining)`)
    process.exit(0)
  }
}

// ── Lock gate ───────────────────────────────────────────────────────────

const lockPath = join(memoryDir, '.distill.lock')

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (existsSync(lockPath)) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (lock.pid && isProcessAlive(lock.pid)) {
      console.log(`${TAG} Skipping: distillation already running (PID ${lock.pid})`)
      process.exit(0)
    }
    // Stale lock — remove it
    unlinkSync(lockPath)
  } catch {
    // Malformed lock — remove and proceed
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
}

writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }, null, 2) + '\n', 'utf8')

// ── Read distill prompt ─────────────────────────────────────────────────

// The monorepo root is two levels up from packages/setup/
const monorepoRoot = join(__dirname, '..', '..')
const promptPath = join(monorepoRoot, 'packages', 'daemon', 'prompts', 'distill-rec.md')

let promptContent
try {
  promptContent = readFileSync(promptPath, 'utf8')
} catch (e) {
  console.log(`${TAG} Error: cannot read distill prompt at ${promptPath}: ${e.message}`)
  try { unlinkSync(lockPath) } catch { /* ignore */ }
  process.exit(1)
}

// ── Resolve claude binary ───────────────────────────────────────────────

function findClaude() {
  const isWin = process.platform === 'win32'

  if (process.env.CLAUDE_BIN) {
    return { bin: process.env.CLAUDE_BIN, shell: false }
  }

  // Try fnm-managed installs — prefer native binary
  const fnmBase = join(homedir(), '.fnm', 'node-versions')
  if (existsSync(fnmBase)) {
    try {
      const versions = readdirSync(fnmBase).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const v of versions) {
        const ccPkgDir = join(fnmBase, v, 'installation', 'node_modules', '@anthropic-ai', 'claude-code')
        if (isWin) {
          const exeBin = join(ccPkgDir, 'bin', 'claude.exe')
          if (existsSync(exeBin)) return { bin: exeBin, shell: false }
        }
        const binPath = join(ccPkgDir, 'bin', 'claude')
        if (existsSync(binPath)) return { bin: binPath, shell: false }
      }
    } catch { /* ignore */ }
  }

  // Try where/which
  try {
    const result = execFileSync(isWin ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim().split(/\r?\n/)[0]
    if (result && existsSync(result)) {
      return { bin: result, shell: isWin && result.endsWith('.cmd') }
    }
  } catch { /* ignore */ }

  return { bin: 'claude', shell: false }
}

const cli = findClaude()

// ── Spawn background distillation ───────────────────────────────────────

const model = config.distillation?.model || 'claude-sonnet-4-6'
const maxTurns = String(config.distillation?.maxTurns || 40)

// Write prompt to temp file — avoids Windows pipe buffer limits and CreateProcessW arg length limit
const tmpPromptPath = join(tmpdir(), `rhi-distill-prompt-${process.pid}.md`)
writeFileSync(tmpPromptPath, promptContent, 'utf8')
const stdinFd = openSync(tmpPromptPath, 'r')

const args = [
  '--model', model,
  '--max-turns', maxTurns,
  '--dangerously-skip-permissions',
  '--print',
]

const child = spawn(cli.bin, args, {
  detached: true,
  stdio: [stdinFd, 'ignore', 'ignore'],
  shell: cli.shell,
  env: {
    ...process.env,
    RELVETIA_DAEMON_CHILD: '1',
    DISTILL_SCOPE: 'standard',
    ECC_SKIP_OBSERVE: '1',
  },
})
child.unref()

if (!child.pid) {
  console.log(`${TAG} Error: failed to spawn distillation process`)
  try { unlinkSync(lockPath) } catch { /* ignore */ }
  process.exit(1)
}

child.on('error', () => {
  try { unlinkSync(lockPath) } catch { /* ignore */ }
  try { unlinkSync(lastDistillPath) } catch { /* ignore */ }
})

// Update lock with child PID
writeFileSync(lockPath, JSON.stringify({ pid: child.pid, timestamp: Date.now() }, null, 2) + '\n', 'utf8')

writeFileSync(lastDistillPath, new Date().toISOString() + '\n', 'utf8')

// ── Report ──────────────────────────────────────────────────────────────

console.log(`${TAG} Background distillation spawned (PID ${child.pid}, model: ${model})`)
process.exit(0)
