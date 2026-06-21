// Relvetia admin tools — saga 9 Phase 3 (+ saga 10 Phase 4-2 P2 cleanup).
//
// Adds six MCP tools to the relvetia-team server for relvetia daemon admin
// operations. All six are pure file-based operations against the daemon's
// state file (~/.claude/relvetia/.claude/scheduled_tasks.json) and the
// walker schedule (~/.claude/relvetia/persona/walkers/schedule.json). No
// daemon process IPC is required — the daemon's chokidar file watch picks
// up scheduled_tasks.json mutations on its next 1s tick.
//
//   1. distill_mark_fired     — saga 9 Phase 3-revA P0 rename from
//                               distill_trigger. Bookkeeping only: sets
//                               lastFiredAt = now for a distill-family
//                               task. Does NOT spawn the distill
//                               subprocess AND does NOT shift the
//                               daemon's nextFireAt schedule (the
//                               in-memory cache in scheduler.ts
//                               L142-162 is NOT invalidated by an
//                               external file write).
//   2. distill_status         — read the 3 STATIC_PERMANENT_TASKS state
//                               (relvetia-dream / verify / optimize),
//                               plus saga 10 P2 #3: any non-STATIC
//                               (dynamic) entries from scheduled_tasks.json
//                               surfaced separately so an operator sees
//                               a single read-only inventory in one call.
//   3. walker_status          — read schedule.json + expand HH:MM → cron.
//   4. scheduled_task_list    — list all entries in scheduled_tasks.json.
//   5. scheduled_task_create  — append a new (non-permanent) task.
//   6. scheduled_task_cancel  — remove a non-permanent task by id.
//
// Design contracts (saga 7 + saga 8 + saga 9 + saga 10 lessons applied):
//   - scheduled_task_create / scheduled_task_cancel / distill_mark_fired are
//     the ONLY mutation paths. The other three are strictly read-only.
//     Production stats.json / index.json / MEMORY.md / concepts/graph.json
//     are NEVER written by any of the six tools (saga 8 lesson §16 — the
//     test file's production-invariant sentinel pins this).
//   - The only mutation target is scheduled_tasks.json in the daemon dir
//     (default $RELVETIA_DIR or ~/.claude/relvetia). All tests drive via
//     $RELVETIA_DIR override so user's real daemon state is left untouched.
//   - distill_mark_fired is honestly limited: it sets lastFiredAt for
//     bookkeeping. The daemon's `nextFireAt` map (relvetia-daemon/src/
//     scheduler.ts L142-162) is an in-memory cache that is NOT invalidated
//     by external file changes; the chokidar watch only refreshes the
//     tasks array (`load(false)`), not the cache. To shift the daemon's
//     schedule, restart pm2 relvetia-daemon. For real triggering, use
//     /relvetia dream. (Saga 9 §18 Lesson D NEW lived practice — call
//     graph + execution semantics 全 verify, the daemon-side semantics
//     are documented in the function header.)
//   - scheduled_task_cancel refuses to remove tasks with permanent=true
//     (bootstrap-registered tasks: relvetia-dream / verify / optimize +
//     walker family). Those are owned by relvetia-daemon/src/bootstrap.ts
//     STATIC_PERMANENT_TASKS + schedule.json — modifying them via this
//     tool would silently regress on the next daemon restart.
//   - Cron parsing for nextFireAt is deliberately delegated to the
//     daemon's in-memory cache (scheduler.ts nextFireAt map). This tool
//     surface returns nextFireAt=null and the cron string as-is — the
//     contract is "static schedule view, not predictive scheduler".
//   - No new npm dep: writeFileAtomic comes from src/fs-utils.js; cron
//     parsing for create-time validation uses isValidCronExpression here
//     (saga 9 P1 #1) and is reused by saga 10 P2 #3 cronAcceptedByLocalValidator field
//     on dynamic entries.

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic, defaultDaemonDir } from './fs-utils.js'
import { withLock } from './lockfile.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Re-exported from fs-utils.js (saga 10 Phase 4-2 P2 #1 dedup).
// Single source of truth so admin-tools and memory-tools can't drift.
export { defaultDaemonDir } from './fs-utils.js'

export function defaultWalkerSchedulePath() {
  return process.env.RELVETIA_WALKER_SCHEDULE_PATH ||
    join(defaultDaemonDir(), 'persona', 'walkers', 'schedule.json')
}

// Saga 10 Phase 4-2 P2 #2 + revB P1 #3: $RELVETIA_SCHEDULED_TASKS_PATH is a
// **test/benchmark isolation hook only** — it does NOT influence the
// daemon-side read path (`relvetia-daemon/src/tasks.ts` reads from
// `<dir>/.claude/scheduled_tasks.json` directly). If a test sets the env
// and writes via this MCP surface to e.g. /tmp/foo.json, the production
// daemon will continue to read from its own daemonDir/.claude path and
// **will not see the override-written file**. Use cases: vitest / bench
// scripts that need to point at a sandbox file without rearranging the
// surrounding daemon dir layout. Production code (other than tests/bench)
// should not rely on this env var. (Saga 11+ may add a daemon-side hook
// if production-grade override becomes a real requirement; out of scope
// here per the saga 10 invariant + structural-mutation gate.)
//
// Falls back to <daemonDir>/.claude/scheduled_tasks.json (the daemon's
// own canonical path) when the env var is unset.
function scheduledTasksFilePath(daemonDir) {
  return process.env.RELVETIA_SCHEDULED_TASKS_PATH ||
    join(daemonDir, '.claude', 'scheduled_tasks.json')
}

function isEnoent(e) {
  return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')
}

// scheduled_tasks.json shape mirrors relvetia-daemon/src/tasks.ts:
//   { tasks: [{ id, cron, prompt, createdAt, lastFiredAt?,
//               recurring?, permanent?, nativeHandler? }] }
//
// Codex saga 9 P1 #3 lived practice: read-only callers tolerate malformed
// JSON via `{ tasks: [] }` fallback (so list/status return graceful empty
// rather than throwing across the MCP boundary). Mutation callers MUST
// pass `{ strict: true }` so a malformed file fails LOUD rather than being
// silently overwritten with an empty/partial state — saga 7+8 §17 + saga 9
// Lesson D NEW lived practice (call graph + execution semantics 全 verify,
// extended to "destructive-write safety surfaces an error rather than
// burying it").
class MalformedTasksFileError extends Error {
  constructor(path, reason) {
    super(`scheduled_tasks.json malformed at ${path} (${reason}); refusing ` +
      `to overwrite — please backup and fix the file manually, or remove ` +
      `it to start fresh (the daemon will bootstrap permanent tasks on ` +
      `next restart).`)
    this.code = 'MALFORMED_TASKS_FILE'
    this.path = path
  }
}

async function readCronTasksFile(daemonDir, opts = {}) {
  const strict = opts.strict === true
  const path = scheduledTasksFilePath(daemonDir)
  let raw
  try { raw = await readFile(path, 'utf-8') }
  catch (e) {
    if (isEnoent(e)) return { tasks: [] }
    throw e
  }
  let parsed
  try { parsed = JSON.parse(raw) }
  catch {
    if (strict) throw new MalformedTasksFileError(path, 'invalid JSON')
    return { tasks: [] }
  }
  if (!parsed || typeof parsed !== 'object') {
    if (strict) throw new MalformedTasksFileError(path, 'top-level not an object')
    return { tasks: [] }
  }
  if (!Array.isArray(parsed.tasks)) {
    if (strict) throw new MalformedTasksFileError(path, 'missing or non-array `tasks` field')
    return { tasks: [] }
  }
  return parsed
}

async function writeCronTasksFile(daemonDir, file) {
  const path = scheduledTasksFilePath(daemonDir)
  // mkdir -p of the actual target's parent dir on first write.
  // writeFileAtomic itself does NOT create parent dirs, so we ensure it
  // exists here so first-time scheduled_task_create from an empty target
  // path does not ENOENT.
  //
  // Saga 10 Phase 4-2 revB P1 #4: use dirname(path) (NOT
  // join(daemonDir, '.claude')) so the env override path
  // ($RELVETIA_SCHEDULED_TASKS_PATH) is honoured byte-for-byte and the
  // surrounding daemonDir/.claude is left untouched when the override is
  // set. Codex audit empirically showed the prior code touched daemonDir
  // even when the env wins, breaking the "don't touch surrounding daemon
  // dir layout" contract.
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dirname(path), { recursive: true })
  const body = JSON.stringify(file, null, 2) + '\n'
  await writeFileAtomic(path, body)
}

// Codex saga 9 P1 #2 lived practice: wrap read-modify-write paths in
// `withLock` to prevent lost updates from concurrent MCP calls. Lock
// target = scheduled_tasks.json, lockfilePath = scheduled_tasks.json.lock
// (matches the approvals.js / cross-team.js pattern in this repo). The
// lock is cross-process via proper-lockfile.lock(). Note: this protects
// against concurrent MCP-side writers; the daemon itself uses
// `~/.claude/relvetia/.claude/.scheduler.lock` for its scheduler lock,
// which is a different file and a different concern — daemon vs MCP
// races are not addressed here (saga 10+ scope if real-world friction).
async function withTasksLock(daemonDir, fn) {
  const path = scheduledTasksFilePath(daemonDir)
  return withLock(path, fn, { lockfilePath: `${path}.lock` })
}

// Codex saga 9 P1 #1 lived practice: validate cron expressions at the
// MCP boundary so we don't write tasks that the daemon will silently
// drop at read time (relvetia-daemon/src/tasks.ts L88-91 logs a warn
// and skips invalid-cron entries). Mirror the daemon's parser surface
// without importing its TypeScript build output.
//
// 5-field cron format: `<minute> <hour> <dayOfMonth> <month> <dayOfWeek>`
// Field ranges:
//   minute       0-59
//   hour         0-23
//   dayOfMonth   1-31
//   month        1-12
//   dayOfWeek    0-7 (0 and 7 both Sunday)
// Allowed special characters per field:
//   `*`          any value
//   `N`          single number (in range)
//   `N-M`        range (in range, N<=M)
//   `N,M,...`    comma list (each part must independently validate)
//   `*/N`        step (N >= 1)
//   `A-B/N`      stepped range
//   `A/N`        from A, step N
// Validation is permissive — anything the daemon accepts at read time
// passes here; obviously broken inputs (wrong field count, out-of-range
// numbers, non-numeric) reject loud at create time.
function isValidCronField(field, min, max) {
  if (typeof field !== 'string' || field.length === 0) return false
  if (field === '*') return true
  if (field.includes(',')) {
    return field.split(',').every(part => isValidCronField(part, min, max))
  }
  if (field.includes('/')) {
    const slashIdx = field.indexOf('/')
    const base = field.slice(0, slashIdx)
    const step = field.slice(slashIdx + 1)
    const stepN = parseInt(step, 10)
    if (!/^\d+$/.test(step) || isNaN(stepN) || stepN < 1) return false
    if (base === '*') return true
    return isValidCronField(base, min, max)
  }
  if (field.includes('-')) {
    const [a, b] = field.split('-')
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false
    const aN = parseInt(a, 10)
    const bN = parseInt(b, 10)
    return aN >= min && aN <= max && bN >= min && bN <= max && aN <= bN
  }
  if (!/^\d+$/.test(field)) return false
  const n = parseInt(field, 10)
  return n >= min && n <= max
}

export function isValidCronExpression(cron) {
  if (typeof cron !== 'string') return false
  const trimmed = cron.trim()
  if (trimmed.length === 0) return false
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) return false
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
  for (let i = 0; i < 5; i++) {
    if (!isValidCronField(fields[i], ranges[i][0], ranges[i][1])) return false
  }
  return true
}

// Mirror of relvetia-daemon/src/bootstrap.ts STATIC_PERMANENT_TASKS at the
// id/cron level. Used by distill_status to surface the three canonical
// distill tasks even when scheduled_tasks.json has not yet been bootstrapped
// (e.g., a freshly-installed daemon dir before first start).
export const STATIC_PERMANENT_TASK_IDS = [
  'relvetia-dream',
  'relvetia-verify',
  'relvetia-optimize',
]

const STATIC_TASK_CRONS = {
  'relvetia-dream': '0 3 * * *',     // daily 03:00
  'relvetia-verify': '30 3 * * *',   // daily 03:30
  'relvetia-optimize': '0 4 * * 0',  // Sunday 04:00
}

// "HH:MM" → "M H * * *" cron, ported from relvetia-daemon/src/bootstrap.ts
// hhmmToCron. Replicated here (not imported) so this tool does not pull in
// the daemon's TypeScript build output as a dependency.
function hhmmToCron(hhmm) {
  if (typeof hhmm !== 'string') return null
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (isNaN(hh) || isNaN(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return `${mm} ${hh} * * *`
}

// ---------------------------------------------------------------------------
// distill_mark_fired (saga 9 Phase 3-revA: was distill_trigger, renamed for
// honesty per Codex P0)
// ---------------------------------------------------------------------------
//
// File-only "mark-fired" bookkeeping. Updates lastFiredAt of the target
// distill task in scheduled_tasks.json to NOW.
//
// IMPORTANT — Codex saga 9 P0 lived practice (saga 9 §17 NEW lesson: "call
// graph + execution semantics 全 verify"): this tool does NOT trigger the
// distill subprocess AND does NOT affect when the daemon next fires.
//
//   1. No subprocess is spawned. Distill execution is owned by the daemon's
//      onFireTask wiring (relvetia-daemon/src/scheduler.ts + handle-fire.ts
//      + executor.ts) and the /relvetia dream slash command.
//
//   2. The daemon's `nextFireAt` map (relvetia-daemon/src/scheduler.ts
//      L142-162) is an in-memory cache computed once per task per process
//      lifetime. The chokidar file watch on scheduled_tasks.json only
//      refreshes the `tasks` array (`load(false)`); it does NOT invalidate
//      `nextFireAt`. An external lastFiredAt write therefore does NOT
//      change when the daemon next fires. To actually shift the daemon
//      schedule, restart the daemon (which clears the in-memory cache).
//
// Intended use = bookkeeping. Typical workflow: an operator runs /relvetia
// dream (or some other manual distill path) outside the daemon, then calls
// distill_mark_fired so distill_status reflects the manual fire. The
// daemon's own scheduled fires are unaffected by this tool.
//
// Cooldown: force=false skips the update when lastFiredAt is within 6h;
// force=true bypasses the gate. The cron `0 3 * * *` leaves ~22h between
// scheduled fires so 6h is conservative.

/**
 * @param {{ force?: boolean, taskId?: string }} input
 * @param {{ daemonDir?: string, now?: number, cooldownMs?: number }} [opts]
 * @returns {Promise<{ marked: boolean, taskId: string, lastFiredAt: number | null, message: string }>}
 */
export async function runDistillMarkFired(input, opts = {}) {
  const daemonDir = opts.daemonDir || defaultDaemonDir()
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const cooldownMs = typeof opts.cooldownMs === 'number'
    ? opts.cooldownMs
    : 6 * 60 * 60 * 1000  // 6h
  const taskId = (input && input.taskId) || 'relvetia-dream'
  const force = Boolean(input && input.force)

  // Codex saga 9 P1 #2 lived practice: withLock for read-modify-write
  // safety. P1 #3 lived practice: strict=true so a malformed file fails
  // loud rather than being silently overwritten with `{ tasks: [] }`.
  return withTasksLock(daemonDir, async () => {
    const file = await readCronTasksFile(daemonDir, { strict: true })
    const task = file.tasks.find(t => t && t.id === taskId)
    if (!task) {
      return {
        marked: false,
        taskId,
        lastFiredAt: null,
        message: `Task '${taskId}' not found in scheduled_tasks.json. ` +
          `Run \`pm2 restart relvetia-daemon\` to bootstrap permanent tasks, ` +
          `or check the daemon dir override ($RELVETIA_DIR). ` +
          `(Note: this tool only writes bookkeeping; it does NOT invoke distill.)`,
      }
    }

    if (!force && typeof task.lastFiredAt === 'number') {
      const elapsed = now - task.lastFiredAt
      if (elapsed >= 0 && elapsed < cooldownMs) {
        const hoursAgo = (elapsed / 3600000).toFixed(2)
        const cooldownHours = (cooldownMs / 3600000).toFixed(0)
        return {
          marked: false,
          taskId,
          lastFiredAt: task.lastFiredAt,
          message: `Cooldown active: '${taskId}' was marked fired ${hoursAgo}h ago ` +
            `(< ${cooldownHours}h cooldown). Pass force=true to override. ` +
            `(Note: this tool only writes bookkeeping; it does NOT invoke distill.)`,
        }
      }
    }

    task.lastFiredAt = now
    await writeCronTasksFile(daemonDir, file)

    return {
      marked: true,
      taskId,
      lastFiredAt: now,
      message: `Set lastFiredAt = ${new Date(now).toISOString()} for '${taskId}' ` +
        `in scheduled_tasks.json. ` +
        `IMPORTANT: this tool does NOT invoke the distill subprocess AND ` +
        `does NOT affect the daemon's nextFireAt schedule (the daemon's ` +
        `in-memory nextFireAt cache is not refreshed by external file changes; ` +
        `see relvetia-daemon/src/scheduler.ts L142-162). To actually run ` +
        `distillation, use the /relvetia dream slash command. To shift the ` +
        `daemon's schedule, restart pm2 relvetia-daemon.`,
    }
  })
}

export async function distillMarkFiredToolHandler(args) {
  const out = await runDistillMarkFired(args)
  return {
    content: [{ type: 'text', text: out.message }],
    structuredContent: out,
  }
}

// ---------------------------------------------------------------------------
// distill_status
// ---------------------------------------------------------------------------
//
// Read-only. Surfaces the state of the three STATIC_PERMANENT_TASKS even
// when scheduled_tasks.json has not been bootstrapped yet (returns the
// canonical cron + registered=false). Never reads /writes production memory
// files. nextFireAt is deliberately null — that value lives in the daemon's
// in-memory nextFireAt cache (relvetia-daemon/src/scheduler.ts) and would
// require a cron-parser dep to compute here; the contract is "static schedule
// view + lastFiredAt", not "predictive next-fire computation".

/**
 * @param {{}} _input
 * @param {{ daemonDir?: string }} [opts]
 */
export async function runDistillStatus(_input = {}, opts = {}) {
  const daemonDir = opts.daemonDir || defaultDaemonDir()
  const file = await readCronTasksFile(daemonDir)
  const byId = new Map(file.tasks.map(t => [t.id, t]))

  const staticTasks = STATIC_PERMANENT_TASK_IDS.map(id => {
    const t = byId.get(id)
    return {
      id,
      cron: (t && typeof t.cron === 'string') ? t.cron : (STATIC_TASK_CRONS[id] || null),
      lastFiredAt: (t && typeof t.lastFiredAt === 'number')
        ? new Date(t.lastFiredAt).toISOString()
        : null,
      nextFireAt: null,
      permanent: t ? t.permanent === true : false,
      registered: Boolean(t),
    }
  })

  // Saga 10 Phase 4-2 P2 #3: separate STATIC distill-family entries from any
  // dynamic (non-STATIC) tasks present in scheduled_tasks.json. Backward
  // compat: `tasks` keeps its prior shape (only the 3 STATIC distill entries).
  // Additive: `static` aliases `tasks` for clarity, `dynamic` surfaces every
  // other scheduled task (walkers + ad-hoc scheduled_task_create entries) so
  // an operator reading distill_status can see what else is configured in
  // scheduled_tasks.json without separately calling scheduled_task_list.
  // (revE honest scope: this comment used to say "what else the daemon
  // picks up" — the revD wording sentinel had a granularity gap and missed
  // the over-claim. See the revE sentinel restructure for the lock.)
  //
  // Saga 10 Phase 4-2 revB P1 #5 + revC P1 #1 rename + revD honest scope
  // (Codex 2nd-round + 3rd-round): each dynamic entry carries
  // `cronAcceptedByLocalValidator: boolean` = the result of
  // isValidCronExpression(cron). This is the local 5-field cron validator only,
  // NOT a full daemon-acceptance check. The previous field name
  // (pre-revC) over-claimed by suggesting daemon-pickup; revD makes the
  // honest scope explicit in every surface (croner-only syntax such as
  // `MON`/`@daily` and 6-field crons pass the daemon but fail here, and
  // entries missing prompt/createdAt/id pass here but the daemon drops):
  // the daemon (relvetia-daemon/src/tasks.ts L79 + cron.ts L14) uses the
  // `croner` library which accepts day-of-week aliases (`MON`/`TUE`/...)
  // and other forms the local validator rejects, AND it requires id/cron/
  // prompt/createdAt all present — neither of which this field captures.
  // The honest rename surfaces what we can actually back without re-importing
  // the daemon's TS build output. False = "the local daemon-parity validator
  // rejected this cron string"; true = "the cron string passed the local
  // validator; the daemon may still drop the entry on other grounds (missing
  // fields, croner-only syntax like @daily or day-of-week aliases)". Full
  // daemon-side mirror is saga 11+ scope. (Codex P1 #5 + revC P1 #1 honest
  // content. (Codex P1 #5 + Lesson §18 lived practice.)
  const staticIdSet = new Set(STATIC_PERMANENT_TASK_IDS)
  const dynamic = file.tasks
    .filter(t => t && typeof t.id === 'string' && !staticIdSet.has(t.id))
    .map(t => {
      const cron = typeof t.cron === 'string' ? t.cron : null
      return {
        id: t.id,
        cron,
        lastFiredAt: (typeof t.lastFiredAt === 'number')
          ? new Date(t.lastFiredAt).toISOString()
          : null,
        nextFireAt: null,
        permanent: t.permanent === true,
        registered: true,
        cronAcceptedByLocalValidator: typeof cron === 'string' && isValidCronExpression(cron),
      }
    })

  return { tasks: staticTasks, static: staticTasks, dynamic }
}

export async function distillStatusToolHandler(args) {
  const s = await runDistillStatus(args)
  const staticLines = s.static.map(t =>
    `${t.id.padEnd(20)} cron='${t.cron || '(unknown)'}' ` +
    `lastFiredAt=${t.lastFiredAt || '(never)'} ` +
    `permanent=${t.permanent} registered=${t.registered}`
  )
  // P2 #3 + revB P1 #5 + revD honest scope (Codex 3rd-round) + revE
  // granularity (Codex 4th-round): also surface dynamic (non-STATIC) tasks
  // under a separate heading so the text view matches the structured
  // `static` / `dynamic` split. Each dynamic line tags
  // `cronAcceptedByLocalValidator=` to show the result of the local 5-field cron validator only,
  // NOT a full daemon-acceptance check. The daemon's croner library accepts
  // croner-only syntax such as `MON` / `@daily` / 6-field crons that the
  // local validator rejects, and the daemon also requires id/cron/prompt/
  // createdAt all present, which this tag does not look at. Lesson §18 +
  // revD honest scope claim + revE 3-block sentinel.
  const dynamicSection = s.dynamic.length === 0
    ? ''
    : '\n\nDynamic tasks (non-STATIC, present in scheduled_tasks.json):\n' +
      s.dynamic.map(t =>
        `${t.id.padEnd(20)} cron='${t.cron || '(unknown)'}' ` +
        `lastFiredAt=${t.lastFiredAt || '(never)'} ` +
        `permanent=${t.permanent} cronAcceptedByLocalValidator=${t.cronAcceptedByLocalValidator}`
      ).join('\n')
  return {
    content: [{ type: 'text', text: `STATIC distill tasks:\n${staticLines.join('\n')}${dynamicSection}` }],
    structuredContent: s,
  }
}

// ---------------------------------------------------------------------------
// walker_status
// ---------------------------------------------------------------------------
//
// Read-only. Loads ~/.claude/relvetia/persona/walkers/schedule.json (override
// via $RELVETIA_WALKER_SCHEDULE_PATH), expands HH:MM lists into 5-field cron
// strings (mirror of bootstrap.ts hhmmToCron logic), and joins with
// scheduled_tasks.json lastFiredAt entries (id-matched). Returns walkers=[]
// when schedule.json is missing or malformed (graceful — never throws across
// the MCP boundary).

/**
 * @param {{}} _input
 * @param {{ schedulePath?: string, daemonDir?: string }} [opts]
 */
export async function runWalkerStatus(_input = {}, opts = {}) {
  const schedulePath = opts.schedulePath || defaultWalkerSchedulePath()
  const daemonDir = opts.daemonDir || defaultDaemonDir()

  let parsed = null
  try {
    const raw = await readFile(schedulePath, 'utf-8')
    parsed = JSON.parse(raw)
  } catch (e) {
    if (isEnoent(e)) return { walkers: [], schedulePath }
    if (e instanceof SyntaxError) {
      return { walkers: [], schedulePath, error: 'schedule.json JSON parse failed' }
    }
    throw e
  }

  const cronFile = await readCronTasksFile(daemonDir)
  const byId = new Map(cronFile.tasks.map(t => [t.id, t]))

  const walkers = []
  const walkersCfg = (parsed && typeof parsed === 'object' && parsed.walkers) || {}
  for (const [id, cfg] of Object.entries(walkersCfg)) {
    if (!cfg || typeof cfg !== 'object') continue
    const enabled = cfg.enabled !== false
    const schedule = Array.isArray(cfg.schedule)
      ? cfg.schedule.filter(s => typeof s === 'string')
      : []
    const cronExpanded = schedule.map(hhmmToCron).filter(c => c !== null)
    const task = byId.get(id)
    const entry = {
      id,
      enabled,
      schedule,
      cronExpanded,
      lastFiredAt: (task && typeof task.lastFiredAt === 'number')
        ? new Date(task.lastFiredAt).toISOString()
        : null,
    }
    if (typeof cfg.note === 'string') entry.note = cfg.note
    walkers.push(entry)
  }

  return { walkers, schedulePath }
}

export async function walkerStatusToolHandler(args) {
  const s = await runWalkerStatus(args)
  const lines = s.walkers.length === 0
    ? `(no walkers configured; schedule.json=${s.schedulePath}${s.error ? ' [' + s.error + ']' : ''})`
    : s.walkers.map(w =>
        `${w.id.padEnd(28)} enabled=${w.enabled} ` +
        `schedule=[${w.schedule.join(',')}] cron=[${w.cronExpanded.join('; ')}]` +
        (w.note ? ` note="${w.note}"` : '') +
        ` lastFiredAt=${w.lastFiredAt || '(never)'}`
      ).join('\n')
  return {
    content: [{ type: 'text', text: lines }],
    structuredContent: s,
  }
}

// ---------------------------------------------------------------------------
// scheduled_task_list
// ---------------------------------------------------------------------------
//
// Read-only. Mirrors the data shape of relvetia-daemon/src/tasks.ts CronTask.
// includePermanent=true (default) returns the full list; false filters out
// permanent=true tasks (the bootstrap-registered distill family + walkers).

/**
 * @param {{ includePermanent?: boolean }} input
 * @param {{ daemonDir?: string }} [opts]
 */
export async function runScheduledTaskList(input = {}, opts = {}) {
  const daemonDir = opts.daemonDir || defaultDaemonDir()
  const includePermanent = input.includePermanent !== false

  const file = await readCronTasksFile(daemonDir)
  const filtered = includePermanent
    ? file.tasks
    : file.tasks.filter(t => t.permanent !== true)

  return {
    tasks: filtered.map(t => {
      const out = {
        id: t.id,
        cron: t.cron,
        prompt: t.prompt,
        createdAt: t.createdAt,
        lastFiredAt: (typeof t.lastFiredAt === 'number') ? t.lastFiredAt : null,
        recurring: t.recurring === true,
        permanent: t.permanent === true,
      }
      if (typeof t.nativeHandler === 'string') out.nativeHandler = t.nativeHandler
      return out
    }),
  }
}

export async function scheduledTaskListToolHandler(args) {
  const s = await runScheduledTaskList(args)
  const lines = s.tasks.length === 0
    ? '(no scheduled tasks)'
    : s.tasks.map(t => {
        const promptPreview = (t.prompt || '').slice(0, 60)
        const lastFired = t.lastFiredAt
          ? new Date(t.lastFiredAt).toISOString()
          : '(never)'
        const flags = [
          t.recurring ? 'recurring' : 'one-shot',
          t.permanent ? 'permanent' : null,
          t.nativeHandler ? `native:${t.nativeHandler}` : null,
        ].filter(Boolean).join(',')
        const ellipsis = (t.prompt || '').length > 60 ? '…' : ''
        return `${String(t.id).padEnd(28)} cron='${t.cron}' [${flags}] lastFired=${lastFired} prompt="${promptPreview}${ellipsis}"`
      }).join('\n')
  return {
    content: [{ type: 'text', text: `${s.tasks.length} task(s):\n${lines}` }],
    structuredContent: s,
  }
}

// ---------------------------------------------------------------------------
// scheduled_task_create
// ---------------------------------------------------------------------------
//
// Append a new (non-permanent) task to scheduled_tasks.json. Saga 9 P1 #1
// lived practice: the cron string IS validated at this MCP boundary via
// isValidCronExpression (the daemon-parity 5-field parser defined in this
// file). Out-of-range or malformed input throws INVALID_CRON before any
// file write — so scheduled_tasks.json is never half-written with an entry
// the daemon would silently drop at read time (relvetia-daemon/src/tasks.ts
// L88-91 ※ this is the read-time skip the boundary-time validator is
// designed to avoid). Saga 10 Phase 4-2 revC P1 #2 atomic sync: this
// module comment + the safeTool description + the Zod field description
// all now agree that cron is rejected loud at create time, not silent at
// read time.
//
// permanent=true is NEVER set by this tool; that flag is reserved for
// bootstrap-registered tasks (relvetia-daemon/src/bootstrap.ts). Attempting
// to create a permanent task via this MCP surface would silently regress
// when the daemon next bootstraps and clobbers the entry.

/**
 * @param {{ cron: string, prompt: string, recurring?: boolean }} input
 * @param {{ daemonDir?: string, now?: number, idGen?: () => string }} [opts]
 */
export async function runScheduledTaskCreate(input, opts = {}) {
  const daemonDir = opts.daemonDir || defaultDaemonDir()
  const now = typeof opts.now === 'number' ? opts.now : Date.now()
  const idGen = typeof opts.idGen === 'function'
    ? opts.idGen
    : () => randomUUID().slice(0, 8)

  // Codex saga 9 P1 #1 lived practice: validate cron at the MCP boundary
  // so we don't write tasks the daemon will silently drop at read time
  // (relvetia-daemon/src/tasks.ts L88-91). Throw → safeTool catches →
  // isError envelope to the caller. Failure happens BEFORE we touch the
  // file system, so a bad cron leaves scheduled_tasks.json untouched.
  if (!isValidCronExpression(input.cron)) {
    const err = new Error(
      `Invalid cron expression: '${input.cron}'. ` +
      `Expected 5 fields (minute hour dayOfMonth month dayOfWeek) ` +
      `within ranges 0-59 / 0-23 / 1-31 / 1-12 / 0-7. ` +
      `Allowed: *, N, N-M, N,M,..., */N, A-B/N. ` +
      `Example: '0 9 * * *' = daily at 9:00. ` +
      `The daemon's parser (relvetia-daemon/src/tasks.ts L88-91) would ` +
      `silently drop a malformed entry at read time; we reject loud at ` +
      `create time instead.`,
    )
    err.code = 'INVALID_CRON'
    throw err
  }

  const id = idGen()
  const recurring = input.recurring !== false  // default true
  const task = {
    id,
    cron: input.cron,
    prompt: input.prompt,
    createdAt: now,
  }
  if (recurring) task.recurring = true
  // NOTE: permanent flag never set here. Walker-family nativeHandler also
  // never set here — those entries come from bootstrap.ts only.

  // Codex saga 9 P1 #2 + P1 #3 lived practice: withLock + strict read so
  // concurrent MCP writers don't lose updates and a malformed file fails
  // loud rather than being silently flattened to `{ tasks: [task] }`.
  return withTasksLock(daemonDir, async () => {
    const file = await readCronTasksFile(daemonDir, { strict: true })
    file.tasks.push(task)
    await writeCronTasksFile(daemonDir, file)

    return {
      id,
      cron: task.cron,
      recurring,
      createdAt: task.createdAt,
    }
  })
}

export async function scheduledTaskCreateToolHandler(args) {
  const out = await runScheduledTaskCreate(args)
  return {
    content: [{
      type: 'text',
      text: `Created task ${out.id} (cron='${out.cron}', recurring=${out.recurring})`,
    }],
    structuredContent: out,
  }
}

// ---------------------------------------------------------------------------
// scheduled_task_cancel
// ---------------------------------------------------------------------------
//
// Remove a non-permanent task from scheduled_tasks.json by id. Refuses to
// remove permanent=true tasks (bootstrap-registered distill family + walker
// family) — the daemon would re-create them on next restart anyway, so a
// silent cancel here would just confuse the operator. To suppress a walker,
// edit schedule.json (enabled=false or schedule=[]). To remove a distill
// task, delete its entry in relvetia-daemon/src/bootstrap.ts STATIC_PERMANENT_TASKS.

/**
 * @param {{ id: string }} input
 * @param {{ daemonDir?: string }} [opts]
 */
export async function runScheduledTaskCancel(input, opts = {}) {
  const daemonDir = opts.daemonDir || defaultDaemonDir()

  // Codex saga 9 P1 #2 + P1 #3 lived practice: withLock + strict read.
  return withTasksLock(daemonDir, async () => {
    const file = await readCronTasksFile(daemonDir, { strict: true })
    const targetIdx = file.tasks.findIndex(t => t && t.id === input.id)
    if (targetIdx < 0) {
      return {
        cancelled: false,
        removedTask: null,
        message: `Task '${input.id}' not found in scheduled_tasks.json`,
      }
    }

    const target = file.tasks[targetIdx]
    if (target.permanent === true) {
      return {
        cancelled: false,
        removedTask: null,
        message: `Task '${input.id}' is permanent (bootstrap-registered) and ` +
          `cannot be cancelled via this tool. To suppress a distill task, edit ` +
          `relvetia-daemon/src/bootstrap.ts STATIC_PERMANENT_TASKS. To suppress ` +
          `a walker, set enabled=false in schedule.json.`,
      }
    }

    const removedTask = { ...target }
    file.tasks.splice(targetIdx, 1)
    await writeCronTasksFile(daemonDir, file)

    return {
      cancelled: true,
      removedTask,
      message: `Cancelled task '${input.id}' (was ${target.recurring ? 'recurring' : 'one-shot'})`,
    }
  })
}

export async function scheduledTaskCancelToolHandler(args) {
  const out = await runScheduledTaskCancel(args)
  return {
    content: [{ type: 'text', text: out.message }],
    structuredContent: out,
  }
}
