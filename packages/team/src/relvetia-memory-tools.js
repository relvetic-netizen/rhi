// Relvetia memory + daemon tools — saga 8 Phase 2.
//
// Adds four MCP tools to the relvetia-team server:
//
//   1. memory_remember   — append a single line to today's daily log
//                          (~/.claude/memory/logs/YYYY/MM/YYYY-MM-DD.md)
//   2. memory_log_recent — read structured entries from the last N days
//   3. memory_status     — summarise MEMORY.md / topics / logs / index.json
//   4. daemon_status     — pm2 process state + scheduler lock file health
//
// Design contracts (saga 7 lessons applied):
//   - memory_remember is the ONLY production-mutation path. Every other tool
//     here is strictly read-only. Production stats.json / index.json /
//     MEMORY.md / concepts/graph.json are never written.
//   - Tests must drive every code path via $RELVETIA_MEMORY_DIR override so
//     the user's real ~/.claude/memory is left untouched (sentinel test in
//     the matching test file asserts the production stats.json md5 is
//     invariant before/after the suite).
//   - daemon_status degrades gracefully when pm2 is missing or the daemon
//     is not registered: pm2State='unknown', other fields zeroed.
//   - No new npm dep: child_process / fs / os / util are Node built-ins,
//     zod ships transitively via relvetia-team.

import { appendRelvetiaLog } from './memory.js'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'

const defaultExecFile = promisify(_execFile)

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function defaultMemoryDir() {
  return process.env.RELVETIA_MEMORY_DIR || join(homedir(), '.claude', 'memory')
}

// Re-exported from fs-utils.js (saga 10 Phase 4-2 P2 #1 dedup).
// Single source of truth so admin-tools and memory-tools can't drift.
// (Local code in this file also uses `defaultDaemonDir`, so we import to
// bind it in scope, then re-export so external callers keep working.)
import { defaultDaemonDir } from './fs-utils.js'
export { defaultDaemonDir }

function isEnoent(e) {
  return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
}

// Mirrors the line shape written by appendRelvetiaLog / searched by
// searchRelvetiaLogs: `- [HH:MM] [tag1][tag2] content`.
const LOG_LINE_RE = /^-\s*\[(\d{2}:\d{2})\]\s*((?:\[[^\]]+\]\s*)*)(.+)$/

function parseLogLine(rawLine, date, file) {
  const m = LOG_LINE_RE.exec(rawLine)
  if (!m) return null
  const [, time, tagPrefix, body] = m
  const tags = []
  const tagRe = /\[([^\]]+)\]/g
  let tm
  while ((tm = tagRe.exec(tagPrefix)) !== null) tags.push(tm[1])
  const topic = tags[0] || ''
  const content = body.trim()
  return { date, time, content, tags, file, topic, timestamp: `${date}T${time}:00` }
}

// JST today in YYYY-MM-DD form. `now` injectable for tests.
function jstTodayParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  return { year: parts.year, month: parts.month, day: parts.day }
}

// Date string n days ago in JST. Returns YYYY-MM-DD.
function jstDateBack(now, daysBack) {
  // Construct a JST midnight Date, then subtract days, then re-format in JST.
  const base = new Date(now.getTime() - daysBack * 86_400_000)
  const { year, month, day } = jstTodayParts(base)
  return `${year}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// memory_remember
// ---------------------------------------------------------------------------
//
// Wraps appendRelvetiaLog from memory.js. The ONLY tool here that writes to
// the host filesystem. Daily log path: <memoryDir>/logs/YYYY/MM/YYYY-MM-DD.md.
// Contract: writes ONLY the daily log file. Does not touch stats.json /
// index.json / MEMORY.md / concepts/graph.json (verified in the test file's
// production-invariant sentinel).

/**
 * @param {{ content: string, tags?: string[] }} input
 * @param {{ memoryDir?: string, now?: Date }} [opts]
 * @returns {Promise<{ file: string, line: string }>}
 */
export async function runMemoryRemember(input, opts = {}) {
  const memoryDir = opts.memoryDir || defaultMemoryDir()
  const root = join(memoryDir, 'logs')
  return appendRelvetiaLog(input.content, {
    tags: Array.isArray(input.tags) ? input.tags : undefined,
    root,
    now: opts.now,
  })
}

export async function memoryRememberToolHandler(args) {
  const out = await runMemoryRemember(args)
  return {
    content: [{ type: 'text', text: `Appended to ${out.file}\n  ${out.line}` }],
    structuredContent: { file: out.file, line: out.line },
  }
}

// ---------------------------------------------------------------------------
// memory_log_recent
// ---------------------------------------------------------------------------
//
// Read-only. Enumerates daily-log files under <memoryDir>/logs/YYYY/MM/, keeps
// those whose YYYY-MM-DD is within `days` of today (JST, inclusive), parses
// each `- [HH:MM] [tags] content` line, returns entries newest-first capped
// at `limit`.

async function listLogFilesInRange(logsRoot, daysBack, now = new Date()) {
  const today = jstTodayParts(now)
  const startDate = jstDateBack(now, daysBack - 1)  // days=1 → today only
  const todayStr = `${today.year}-${today.month}-${today.day}`

  let years
  try { years = await readdir(logsRoot) }
  catch (e) {
    if (isEnoent(e)) return []
    throw e
  }

  const out = []
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue
    if (y < startDate.slice(0, 4)) continue  // entire year before range
    let months
    try { months = await readdir(join(logsRoot, y)) } catch { continue }
    for (const mo of months) {
      if (!/^\d{2}$/.test(mo)) continue
      const ymo = `${y}-${mo}`
      if (ymo < startDate.slice(0, 7)) continue
      let days
      try { days = await readdir(join(logsRoot, y, mo)) } catch { continue }
      for (const d of days) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(d)
        if (!m) continue
        const date = m[1]
        if (date < startDate) continue
        if (date > todayStr) continue
        out.push({ date, file: join(logsRoot, y, mo, d) })
      }
    }
  }
  // Newest date first; if same date, file path is identical so order stable.
  out.sort((a, b) => b.date.localeCompare(a.date))
  return out
}

/**
 * @param {{ days?: number, limit?: number }} input
 * @param {{ memoryDir?: string, now?: Date }} [opts]
 * @returns {Promise<{ entries: Array<object> }>}
 */
export async function runMemoryLogRecent(input, opts = {}) {
  const days = Number.isInteger(input.days) ? input.days : 1
  const limit = Number.isInteger(input.limit) ? input.limit : 100
  const memoryDir = opts.memoryDir || defaultMemoryDir()
  const logsRoot = join(memoryDir, 'logs')
  const now = opts.now || new Date()

  const files = await listLogFilesInRange(logsRoot, days, now)
  // Each daily-log file: parse lines, attach date, accumulate newest-first.
  // Within a single day we preserve file order (chronological by HH:MM); the
  // caller can re-sort if they want strict reverse-chronological.
  const entries = []
  for (const { date, file } of files) {
    let raw
    try { raw = await readFile(file, 'utf-8') }
    catch (e) {
      if (isEnoent(e)) continue
      throw e
    }
    const dayEntries = []
    for (const line of raw.split('\n')) {
      const parsed = parseLogLine(line, date, file)
      if (parsed) dayEntries.push(parsed)
    }
    // Within a day, newest HH:MM first so the day-level ordering matches the
    // file-level ordering ("newest date first, newest time first").
    dayEntries.sort((a, b) => b.time.localeCompare(a.time))
    for (const e of dayEntries) {
      entries.push(e)
      if (entries.length >= limit) return { entries }
    }
  }
  return { entries }
}

export async function memoryLogRecentToolHandler(args) {
  const out = await runMemoryLogRecent(args)
  const lines = out.entries.length === 0
    ? '(no entries)'
    : out.entries
        .map(e => `[${e.date} ${e.time}]${e.tags.length ? ' [' + e.tags.join('][') + ']' : ''} ${e.content}`)
        .join('\n')
  return {
    content: [{ type: 'text', text: `${out.entries.length} entry(ies):\n${lines}` }],
    structuredContent: { entries: out.entries },
  }
}

// ---------------------------------------------------------------------------
// memory_status
// ---------------------------------------------------------------------------
//
// Read-only. Counts files, summarises log date range, parses index.json
// entry count, finds "Last distilled:" line in MEMORY.md (fallback to
// .last-distill file mtime). All missing-file paths return zeros / null
// rather than throwing — the user may not have a memory dir initialised.

async function countMarkdownFilesRecursive(root) {
  let count = 0
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) }
  catch (e) {
    if (isEnoent(e)) return 0
    throw e
  }
  for (const ent of entries) {
    const full = join(root, ent.name)
    if (ent.isDirectory()) {
      count += await countMarkdownFilesRecursive(full)
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      count += 1
    }
  }
  return count
}

async function summariseLogDays(logsRoot) {
  let years
  try { years = await readdir(logsRoot) }
  catch (e) {
    if (isEnoent(e)) return { firstDate: null, lastDate: null, totalDays: 0, fileCount: 0 }
    throw e
  }
  const dates = []
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue
    let months
    try { months = await readdir(join(logsRoot, y)) } catch { continue }
    for (const mo of months) {
      if (!/^\d{2}$/.test(mo)) continue
      let days
      try { days = await readdir(join(logsRoot, y, mo)) } catch { continue }
      for (const d of days) {
        const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(d)
        if (m) dates.push(m[1])
      }
    }
  }
  if (dates.length === 0) return { firstDate: null, lastDate: null, totalDays: 0, fileCount: 0 }
  dates.sort()
  return {
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    totalDays: dates.length,  // # of daily-log files present
    fileCount: dates.length,
  }
}

async function readIndexEntryCount(indexPath) {
  let raw
  try { raw = await readFile(indexPath, 'utf-8') }
  catch (e) {
    if (isEnoent(e)) return 0
    throw e
  }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch { return 0 }
  const entries = parsed && typeof parsed === 'object' ? parsed.entries : null
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    return Object.keys(entries).length
  }
  return 0
}

// Parse "Last distilled: YYYY-MM-DD HH:MM" line from MEMORY.md. Returns the
// matched portion (with or without time) or null. Fallback path is the
// .last-distill file's mtime as an ISO string.
async function readLastDistillAt(memoryMdPath, lastDistillFilePath) {
  let raw
  try { raw = await readFile(memoryMdPath, 'utf-8') }
  catch (e) {
    if (!isEnoent(e)) throw e
    raw = ''
  }
  // Match canonical line shape: "Last distilled: 2026-05-20 03:00" (date only also accepted).
  const m = raw.match(/^Last distilled:\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/m)
  if (m) return m[1]
  // Fallback: .last-distill file mtime
  try {
    const s = await stat(lastDistillFilePath)
    return s.mtime.toISOString()
  } catch (e) {
    if (isEnoent(e)) return null
    throw e
  }
}

/**
 * @param {{}} _input
 * @param {{ memoryDir?: string }} [opts]
 */
export async function runMemoryStatus(_input = {}, opts = {}) {
  const memoryDir = opts.memoryDir || defaultMemoryDir()
  const memoryMdPath = join(memoryDir, 'MEMORY.md')
  const topicsDir = join(memoryDir, 'topics')
  const logsRoot = join(memoryDir, 'logs')
  const indexPath = join(memoryDir, 'index.json')
  const lastDistillPath = join(memoryDir, '.last-distill')

  let memoryMdLines = 0
  try {
    const raw = await readFile(memoryMdPath, 'utf-8')
    memoryMdLines = raw.split('\n').length
  } catch (e) {
    if (!isEnoent(e)) throw e
  }

  const [topicFileCount, logSummary, indexEntryCount, lastDistillAt] = await Promise.all([
    countMarkdownFilesRecursive(topicsDir),
    summariseLogDays(logsRoot),
    readIndexEntryCount(indexPath),
    readLastDistillAt(memoryMdPath, lastDistillPath),
  ])

  return {
    memoryMdLines,
    topicFileCount,
    logFileCount: logSummary.fileCount,
    logDays: {
      firstDate: logSummary.firstDate,
      lastDate: logSummary.lastDate,
      totalDays: logSummary.totalDays,
    },
    indexEntryCount,
    lastDistillAt,
  }
}

export async function memoryStatusToolHandler(args) {
  const s = await runMemoryStatus(args)
  const days = s.logDays.firstDate
    ? `${s.logDays.firstDate}..${s.logDays.lastDate} (${s.logDays.totalDays} files)`
    : '(no logs)'
  const text = [
    `MEMORY.md:    ${s.memoryMdLines} lines`,
    `topics/:      ${s.topicFileCount} .md files`,
    `logs/:        ${s.logFileCount} files, range ${days}`,
    `index.json:   ${s.indexEntryCount} entries`,
    `Last distill: ${s.lastDistillAt || '(none)'}`,
  ].join('\n')
  return {
    content: [{ type: 'text', text }],
    structuredContent: s,
  }
}

// ---------------------------------------------------------------------------
// daemon_status
// ---------------------------------------------------------------------------
//
// Read-only. Probes pm2 for the `relvetia-daemon` process state and reads
// the scheduler lock file at <daemonDir>/.claude/.scheduler.lock. The PID
// alive check uses process.kill(pid, 0) (POSIX + Windows both supported by
// Node's process.kill). pm2 absence is treated as pm2State='unknown' with
// other fields zeroed — never throws back to the MCP boundary.

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = process exists but we lack signal permission (Windows can hit
    // this for processes owned by SYSTEM). Treat as alive.
    if (e && e.code === 'EPERM') return true
    return false
  }
}

async function probePm2(execFile) {
  let stdout
  try {
    const res = await execFile('pm2', ['jlist'], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,  // pm2 jlist can be large (full env per proc)
      windowsHide: true,
      // Windows: `pm2` on PATH is an extensionless shell script; execFile does
      // no PATHEXT resolution and Node 22 refuses to spawn `.cmd` without a
      // shell (EINVAL, CVE-2024-27980 hardening). shell:true routes through
      // cmd.exe so `pm2.cmd` resolves. SAFE ONLY because the args are a fixed
      // literal ('jlist') — shell:true does NOT escape arguments, so never pass
      // caller-controlled values here without quoting them yourself.
      shell: process.platform === 'win32',
    })
    stdout = res.stdout || ''
  } catch (e) {
    // ENOENT = pm2 binary missing. Non-zero exit / parse failure also lands
    // here. All collapse to pm2State='unknown' with neutral metrics.
    return { pm2State: 'unknown', uptime: 0, restartCount: 0, recentRestart: null }
  }
  let list
  try { list = JSON.parse(stdout) }
  catch { return { pm2State: 'unknown', uptime: 0, restartCount: 0, recentRestart: null } }
  if (!Array.isArray(list)) {
    return { pm2State: 'unknown', uptime: 0, restartCount: 0, recentRestart: null }
  }
  const proc = list.find(p => p && p.name === 'relvetia-daemon')
  if (!proc) {
    return { pm2State: 'unknown', uptime: 0, restartCount: 0, recentRestart: null }
  }
  const env = proc.pm2_env || {}
  const status = typeof env.status === 'string' ? env.status : 'unknown'
  // Coerce pm2 status names to the schema enum.
  const pm2State = ['online', 'stopped', 'errored'].includes(status) ? status : 'unknown'
  const pmUptime = typeof env.pm_uptime === 'number' ? env.pm_uptime : null
  const uptime = pmUptime !== null ? Math.max(0, Math.floor((Date.now() - pmUptime) / 1000)) : 0
  const restartCount = typeof env.restart_time === 'number' ? env.restart_time : 0
  const recentRestart = pmUptime !== null && restartCount > 0
    ? new Date(pmUptime).toISOString()
    : null
  return { pm2State, uptime, restartCount, recentRestart }
}

async function probeLockFile(lockPath) {
  let raw
  try { raw = await readFile(lockPath, 'utf-8') }
  catch (e) {
    if (isEnoent(e)) return { exists: false, pid: null, alive: false }
    throw e
  }
  let data
  try { data = JSON.parse(raw) }
  catch { return { exists: true, pid: null, alive: false } }
  const pid = data && typeof data.pid === 'number' ? data.pid : null
  return { exists: true, pid, alive: pid !== null ? isProcessAlive(pid) : false }
}

/**
 * @param {{}} _input
 * @param {{ daemonDir?: string, execFile?: Function }} [opts]
 */
export async function runDaemonStatus(_input = {}, opts = {}) {
  const execFile = opts.execFile || defaultExecFile
  const daemonDir = opts.daemonDir || defaultDaemonDir()
  const lockPath = join(daemonDir, '.claude', '.scheduler.lock')

  const [pm2Info, lockFile] = await Promise.all([
    probePm2(execFile),
    probeLockFile(lockPath),
  ])

  return {
    pm2State: pm2Info.pm2State,
    lockFile,
    uptime: pm2Info.uptime,
    restartCount: pm2Info.restartCount,
    recentRestart: pm2Info.recentRestart,
  }
}

export async function daemonStatusToolHandler(args) {
  const s = await runDaemonStatus(args)
  const lockText = s.lockFile.exists
    ? `pid=${s.lockFile.pid ?? '?'} alive=${s.lockFile.alive}`
    : '(absent)'
  const text = [
    `pm2State:     ${s.pm2State}`,
    `uptime:       ${s.uptime}s`,
    `restartCount: ${s.restartCount}`,
    `recentRestart:${s.recentRestart || ' (none)'}`,
    `lockFile:     ${lockText}`,
  ].join('\n')
  return {
    content: [{ type: 'text', text }],
    structuredContent: s,
  }
}
