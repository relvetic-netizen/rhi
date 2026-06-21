/**
 * Relvetia daemon entry point.
 *
 * Starts the cron scheduler, handles SIGTERM/SIGINT for graceful
 * shutdown, and routes fired tasks to `claude --model sonnet -p`.
 *
 * Environment variables:
 *   RELVETIA_DIR          — base directory (default: ~/.claude/relvetia)
 *   RELVETIA_MEMORY_DIR   — memory directory (default: ~/.claude/memory)
 *   RELVETIA_MODEL        — claude model (default: sonnet)
 *   RELVETIA_MAX_TURNS         — legacy/hier fallback max turns (default: 15)
 *   RELVETIA_HEAVY_MAX_TURNS   — heavy tier (dream / optimize) max turns (default: 80)
 *   RELVETIA_HEAVY_TIMEOUT_MS  — heavy tier timeout ms (default: 1500000 = 25min)
 *   RELVETIA_LIGHT_MAX_TURNS   — light tier (rec / verify) max turns (default: 40)
 *   RELVETIA_LIGHT_TIMEOUT_MS  — light tier timeout ms (default: 600000 = 10min)
 *   RELVETIA_KILL              — set to "1" to kill-switch the scheduler
 */

import { randomUUID } from 'crypto'
import { existsSync, readFileSync, unlinkSync } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createCronScheduler, type CronScheduler } from './scheduler.js'
import { executePrompt } from './executor.js'
import { bootstrapPermanentTasks, wireDistillVerifierToEvalStore, ensureCanonicalIndexFormat, ensureHierarchicalEntryIds } from './bootstrap.js'
import {
  attachMemoryDirWatcher,
  detachMemoryDirWatcher,
  setChokidarFactory,
  type ChokidarModule,
} from '../../extracted/screening/memoryDirWatcher.js'
import { getDefaultSearchCache } from '../../extracted/screening/searchCache.js'
import { runWalker } from './walker-executor.js'
import { verifyRunner as runVerifyNative } from './verify-runner.js'

type NativeHandlerResult = { success: boolean; summary: string; [key: string]: unknown }

/**
 * Native handlers run deterministically inside the daemon process, skipping
 * the Claude executor. Used for maintenance tasks where LLM judgement is
 * unnecessary or where a separate spawn pattern is required (walker family
 * uses its own Agent SDK invoker via runWalker).
 *
 * Signature: (memoryDir, task?) — task is optional for memoryDir-only
 * handlers. Walker handlers require task to route to the right walker.ts.
 */
const NATIVE_HANDLERS: Record<string, (memoryDir: string, task?: CronTask) => Promise<void | NativeHandlerResult>> = {
  runWalker: async (_memoryDir, task) => {
    if (!task) throw new Error('runWalker requires task argument')
    const result = await runWalker(task)
    if (result.exitCode !== 0) {
      console.warn(
        `[relvetia] walker ${task.id} exited non-zero: ${result.exitCode}` +
          (result.timedOut ? ' (timed-out)' : ''),
      )
    }
  },
  verifyRunner: (memoryDir) => runVerifyNative({ memoryDir }),
}
import { readCronTasks, type CronTask } from './tasks.js'
import { selectDistillMode } from './distill-mode.js'
import { classifyFireOutcome } from './handle-fire.js'
import { isUnderCooldown, recordFailure, recordSpawn } from './failure-budget.js'
import { atomicWrite, atomicWriteJSON } from '../../extracted/util/atomicWrite.js'
import { readResidualIndex } from '../../extracted/memory/residualIndex.js'
import { todayJST } from '../../extracted/util/jstTime.js'
import { getRelvetiaDir, getMemoryDir } from './dirs.js'

const RELVETIA_DIR = getRelvetiaDir()
const RELVETIA_MEMORY_DIR = getMemoryDir()
const MODEL = process.env.RELVETIA_MODEL ?? 'sonnet'
const MAX_TURNS = parseInt(process.env.RELVETIA_MAX_TURNS ?? '15', 10)
// Tier-specific budgets (env 化 5/1). HEAVY falls back via RELVETIA_MAX_TURNS so
// existing PR #14 deploys (RELVETIA_MAX_TURNS=80) keep working without explicit
// HEAVY override. LIGHT has its own default since it tracks a different baseline.
const HEAVY_MAX_TURNS = parseInt(process.env.RELVETIA_HEAVY_MAX_TURNS ?? process.env.RELVETIA_MAX_TURNS ?? '80', 10)
const HEAVY_TIMEOUT_MS = parseInt(process.env.RELVETIA_HEAVY_TIMEOUT_MS ?? '1500000', 10)
const LIGHT_MAX_TURNS = parseInt(process.env.RELVETIA_LIGHT_MAX_TURNS ?? '40', 10)
const LIGHT_TIMEOUT_MS = parseInt(process.env.RELVETIA_LIGHT_TIMEOUT_MS ?? '600000', 10)

// private-distill is also a heavy distillation task (same kind of work as
// relvetia-dream, just over the private memory zone). The light tier's
// 10-min timeout is insufficient for a full distill pass (a cold-start fire
// was observed to time out at 600000ms).
const HEAVY_TASK_IDS = new Set(['relvetia-dream', 'relvetia-optimize', 'private-distill'])
function getTierBudget(taskId: string): { maxTurns: number; timeoutMs: number } {
  if (HEAVY_TASK_IDS.has(taskId)) {
    return { maxTurns: HEAVY_MAX_TURNS, timeoutMs: HEAVY_TIMEOUT_MS }
  }
  return { maxTurns: LIGHT_MAX_TURNS, timeoutMs: LIGHT_TIMEOUT_MS }
}

const DAEMON_ID = randomUUID()

/**
 * Task whitelist for this daemon process.
 *
 * `RELVETIA_DAEMON_TASKS` is a CSV of permitted task ids. When set, the
 * scheduler filter and the .distill-needed direct-fire path both restrict
 * themselves to the listed ids; when unset, all tasks are allowed
 * (backward-compatible default for the pre-Sprint-B main daemon).
 *
 * Used by the 2nd ecosystem entry `relvetia-daemon-private` to fire only
 * `private-distill` while sharing the same bootstrap/STATIC_PERMANENT_TASKS
 * list as the main daemon.
 */
const ALLOWED_TASKS: Set<string> | null = process.env.RELVETIA_DAEMON_TASKS
  ? new Set(
      process.env.RELVETIA_DAEMON_TASKS.split(',')
        .map(s => s.trim())
        .filter(Boolean),
    )
  : null
if (ALLOWED_TASKS) {
  console.log(`[relvetia] task filter active: ${[...ALLOWED_TASKS].join(',')}`)
}
function taskAllowed(task: CronTask): boolean {
  if (!ALLOWED_TASKS) return true
  return ALLOWED_TASKS.has(task.id)
}

function isNativeVerifyEnabled(): boolean {
  return process.env.RELVETIA_VERIFY_NATIVE === '1'
}

function quoteLogValue(value: string): string {
  return JSON.stringify(value)
}

// Issue 7 (shadow mode default): post-task work verifier for relvetia-dream.
// Set RELVETIA_DREAM_VERIFY_ENFORCE=1 to flip from log-only to fail-closed
// (recordFailure + skip .last-distill stamp + skip git-sync). Shadow mode is
// the safe default while the verifier's false-positive rate is unobserved.
const DREAM_VERIFY_ENFORCE = process.env.RELVETIA_DREAM_VERIFY_ENFORCE === '1'

/**
 * Post-task work verifier for relvetia-dream.
 *
 * The LLM-mediated distill task can claim completion (claude.exe exit 0) without
 * actually producing memory delta — `addedAt`/`updated` schema drift, max-turns
 * exhaustion mid-write, partial completion, or hallucinated success. The daemon
 * has no way to detect this from exit code alone (claude CLI does not propagate
 * internal tool failures to the session exit). This deterministic check fires
 * AFTER executor success and BEFORE .last-distill stamp / git-sync, asserting
 * that index.json got today-dated entries or topic files were touched within
 * the task window.
 *
 * Returns ok=true on legitimate no-op (no work to do AND no work claimed),
 * ok=false on suspected silent success.
 */
async function verifyDreamWork(
  memoryDir: string,
  taskStartMs: number,
  todayJSTAtStart: string,
): Promise<{ ok: boolean; reason: string }> {
  // 1. index.json entries written today (JST anchored at task start to avoid
  //    midnight straddle). Match both the post-d9edcbc `updated` and the
  //    pre-fix `addedAt` since the 91-entry legacy data still uses `addedAt`.
  let todayEntries = 0
  try {
    const idx = await readResidualIndex(memoryDir)
    for (const e of Object.values(idx.entries) as Array<{ updated?: string; addedAt?: string }>) {
      const dateField = e.updated ?? e.addedAt
      if (dateField === todayJSTAtStart) todayEntries++
    }
  } catch (e) {
    return { ok: false, reason: `index.json read failed: ${e}` }
  }

  // 2. topic files touched since task start (mtime > taskStartMs).
  let topicTouched = false
  try {
    const topicsDir = join(memoryDir, 'topics')
    const files = await readdir(topicsDir)
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      try {
        const s = await stat(join(topicsDir, f))
        if (s.mtimeMs > taskStartMs) {
          topicTouched = true
          break
        }
      } catch {
        // ignore individual file stat errors
      }
    }
  } catch {
    // topicsDir missing — treat as not touched
  }

  if (todayEntries > 0 || topicTouched) {
    return {
      ok: true,
      reason: `verified todayEntries=${todayEntries} topicTouched=${topicTouched}`,
    }
  }

  // 3. Legitimate no-op edge case: distill.md invariant says "if no new entries
  //    since last distillation, exit cleanly". Detect by comparing log file
  //    mtimes against .last-distill. If no log file was modified after the
  //    last distill timestamp, the LLM correctly had nothing to do.
  let lastDistillMs = 0
  try {
    const lastDistillContent = await readFile(join(memoryDir, '.last-distill'), 'utf-8')
    lastDistillMs = new Date(lastDistillContent.trim()).getTime()
  } catch {
    // missing → treat as 0, never-distilled state, anything counts as new
  }
  let newLogsExist = false
  try {
    const logsBase = join(memoryDir, 'logs')
    const years = await readdir(logsBase)
    outer: for (const y of years) {
      const yearDir = join(logsBase, y)
      let months: string[] = []
      try {
        months = await readdir(yearDir)
      } catch {
        continue
      }
      for (const m of months) {
        const monthDir = join(yearDir, m)
        let days: string[] = []
        try {
          days = await readdir(monthDir)
        } catch {
          continue
        }
        for (const d of days) {
          if (!d.endsWith('.md')) continue
          try {
            const s = await stat(join(monthDir, d))
            if (s.mtimeMs > lastDistillMs) {
              newLogsExist = true
              break outer
            }
          } catch {
            // ignore
          }
        }
      }
    }
  } catch {
    // logs/ missing — treat as no new logs
  }

  if (!newLogsExist) {
    return { ok: true, reason: 'legitimate no-op (no new logs since last distill)' }
  }

  return {
    ok: false,
    reason: `no today-dated index entries AND no topic file touched, but ${'new logs exist since last distill'} — suspected silent success`,
  }
}

let scheduler: CronScheduler | null = null
let firing = false

function isKilled(): boolean {
  return process.env.RELVETIA_KILL === '1'
}

async function handleFire(task: CronTask): Promise<void> {
  if (firing) {
    console.log(`[relvetia] skipping fire for ${task.id} — already executing a task`)
    return
  }

  firing = true
  const start = Date.now()
  // Short trace id for cross-stream correlation. Failure summaries also go to
  // stdout so PM2 out.log readers see them without tailing the error log
  // (the 5/17 03:00 API-500 incident was invisible in out.log because the
  // FAILURE summary was console.error-only).
  const runId = randomUUID().slice(0, 8)

  // Native-handler tasks run deterministically inside the daemon process,
  // skipping the Claude executor entirely. Used for maintenance tasks where
  // LLM judgement is unnecessary.
  //
  // PR-2 cutover: relvetia-verify is env-gated. RELVETIA_VERIFY_NATIVE unset
  // keeps the old Claude spawn path even if scheduled_tasks.json has a stale
  // nativeHandler=verifyRunner from a prior rollout. Set RELVETIA_VERIFY_NATIVE=1
  // to bypass the Claude CLI exit-code propagation gap; after 3 green cron
  // cycles the spawn path and flag can be removed in a follow-up commit.
  if (task.id === 'relvetia-verify' && isNativeVerifyEnabled()) {
    console.log(`[relvetia] executing task ${task.id} (native:verifyRunner) runId=${runId}`)
    try {
      const result = await runVerifyNative({ memoryDir: RELVETIA_MEMORY_DIR })
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      const status = result.success ? 'success' : 'failure'
      console.log(
        `[relvetia] task ${task.id} native summary runId=${runId} status=${status} ` +
        `hitRate=${Math.round(result.hitRate * 100)}% found=${result.foundEntries}/${result.totalEntries} ` +
        `missing=${result.missingCount} scope=${result.scope} elapsed=${elapsed}s summary=${quoteLogValue(result.summary)}`,
      )
      console.log(`[relvetia] task ${task.id} finished status=${status} runId=${runId} elapsed=${elapsed}s`)
      if (!result.success) {
        await recordFailure(task.id, -1, Date.now() - start)
      }
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.error(`[relvetia] task ${task.id} native verify threw unexpectedly:`, e)
      console.log(`[relvetia] task ${task.id} finished status=failure runId=${runId} reason=native_throw elapsed=${elapsed}s`)
      await recordFailure(task.id, -1, Date.now() - start)
    } finally {
      firing = false
    }
    return
  }

  if (task.nativeHandler && !(task.id === 'relvetia-verify' && task.nativeHandler === 'verifyRunner')) {
    const handler = NATIVE_HANDLERS[task.nativeHandler]
    if (!handler) {
      console.error(
        `[relvetia] task ${task.id} has unknown nativeHandler '${task.nativeHandler}'`,
      )
      console.log(`[relvetia] task ${task.id} finished status=failure runId=${runId} reason=unknown_native_handler elapsed=0s`)
      firing = false
      return
    }
    console.log(`[relvetia] executing task ${task.id} (native:${task.nativeHandler}) runId=${runId}`)
    try {
      await handler(RELVETIA_MEMORY_DIR, task)
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[relvetia] task ${task.id} completed (${elapsed}s)`)
      console.log(`[relvetia] task ${task.id} finished status=success runId=${runId} elapsed=${elapsed}s`)
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.error(`[relvetia] task ${task.id} native handler failed:`, e)
      console.log(`[relvetia] task ${task.id} finished status=failure runId=${runId} reason=native_throw elapsed=${elapsed}s`)
    } finally {
      firing = false
    }
    return
  }

  // Phase 15: for relvetia-dream, swap the prompt to distill-rec.md when the
  // drift report is healthy and HierGen was run recently. The swap is
  // logged so daily logs show which path was taken.
  let effectivePrompt = task.prompt
  let distillMode: 'hier' | 'rec' = 'hier'
  if (task.id === 'relvetia-dream') {
    try {
      const decision = await selectDistillMode(RELVETIA_MEMORY_DIR)
      distillMode = decision.mode
      console.log(`[relvetia] distill mode=${decision.mode} — ${decision.reason}`)
      if (decision.mode === 'rec') {
        const __dirname = dirname(fileURLToPath(import.meta.url))
        const recPath = join(__dirname, '..', 'prompts', 'distill-rec.md')
        effectivePrompt = await readFile(recPath, 'utf-8')
      }
    } catch (e) {
      console.warn(`[relvetia] distill mode selection failed (falling back to hier): ${e}`)
    }
  }

  const budget = getTierBudget(task.id)
  console.log(`[relvetia] executing task ${task.id}: ${effectivePrompt.slice(0, 80)}... (tier=${HEAVY_TASK_IDS.has(task.id) ? 'heavy' : 'light'} maxTurns=${budget.maxTurns} timeoutMs=${budget.timeoutMs})`)

  try {
    const result = await executePrompt(effectivePrompt, {
      model: MODEL,
      maxTurns: budget.maxTurns,
      timeoutMs: budget.timeoutMs,
      cwd: RELVETIA_DIR,
    })
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    const outcome = classifyFireOutcome(task.id, result.exitCode, distillMode)

    if (outcome.kind === 'failure') {
      // Treat non-zero exit as an explicit failure even when stdout was produced.
      // The executor resolves (rather than rejects) to preserve partial output,
      // but here we must not stamp .last-distill or run git sync — those would
      // falsify the historical record (no memory delta produced) and mask the
      // failure from the failure-budget gate.
      console.error(
        `[relvetia] task ${task.id} FAILURE (exit: ${outcome.exitCode}, ${elapsed}s)`,
      )
      // Mirror to stdout so PM2 out.log readers see failures without tailing
      // the error log (the 5/17 03:00 API-500 incident was console.error-only
      // and appeared as silent disappearance in out.log).
      console.log(`[relvetia] task ${task.id} finished status=failure runId=${runId} exit=${outcome.exitCode} elapsed=${elapsed}s`)
      // Feed the failure-budget so repeated failures can engage cooldown.
      // Only the distill-family tasks are budgeted — user cron tasks fail in
      // their own envelope.
      if (['relvetia-dream', 'relvetia-verify', 'relvetia-optimize'].includes(task.id)) {
        await recordFailure(task.id, outcome.exitCode, Date.now() - start)
      }
      return
    }

    console.log(
      `[relvetia] task ${task.id} completed (exit: ${result.exitCode}, ${elapsed}s)`,
    )
    console.log(`[relvetia] task ${task.id} finished status=success runId=${runId} exit=${result.exitCode} elapsed=${elapsed}s`)

    // Issue 7: post-task work verifier for relvetia-dream. The LLM-mediated
    // distill can claim completion (exit 0) without actual memory delta —
    // claude CLI does not propagate internal tool failures to session exit
    // code, so the executor cannot distinguish real success from silent
    // success. verifyDreamWork checks index.json today-entries + topic mtime.
    // Default mode is shadow (log only) controlled by RELVETIA_DREAM_VERIFY_ENFORCE
    // so the false-positive rate can be observed before flipping to fail-closed.
    if (task.id === 'relvetia-dream') {
      const todayAtStart = todayJST(new Date(start))
      const verifyResult = await verifyDreamWork(RELVETIA_MEMORY_DIR, start, todayAtStart)
      const mode = DREAM_VERIFY_ENFORCE ? 'enforce' : 'shadow'
      if (verifyResult.ok) {
        console.log(`[relvetia] task ${task.id} post-verify ${mode}=ok runId=${runId} reason="${verifyResult.reason}"`)
      } else if (DREAM_VERIFY_ENFORCE) {
        console.error(`[relvetia] task ${task.id} POST-VERIFY FAILED runId=${runId} reason="${verifyResult.reason}"`)
        console.log(`[relvetia] task ${task.id} finished status=failure runId=${runId} reason=post_verify elapsed=${elapsed}s`)
        await recordFailure(task.id, -1, Date.now() - start)
        return  // skip .last-distill stamp + git sync
      } else {
        console.warn(`[relvetia] task ${task.id} post-verify shadow=fail runId=${runId} reason="${verifyResult.reason}" — would have failed under RELVETIA_DREAM_VERIFY_ENFORCE=1`)
      }
    }

    if (outcome.stampDistill) {
      try {
        await atomicWrite(
          join(RELVETIA_MEMORY_DIR, '.last-distill'),
          new Date().toISOString() + '\n',
        )
      } catch (err) {
        console.error('[relvetia] failed to write .last-distill:', err)
      }
    }
    if (outcome.stampHiergen) {
      try {
        await atomicWriteJSON(
          join(RELVETIA_MEMORY_DIR, '.last-hiergen.json'),
          { timestamp: new Date().toISOString() },
        )
      } catch (err) {
        console.error('[relvetia] failed to write .last-hiergen.json:', err)
      }
    }
    if (outcome.gitSync) {
      await gitSync('commit-and-push', `relvetia: ${task.id} ${new Date().toISOString()}`)
    }
  } catch (e) {
    console.error(`[relvetia] task ${task.id} failed:`, e)
  } finally {
    firing = false
  }
}

async function start(): Promise<void> {
  console.log(`[relvetia] daemon starting`)

  // Bootstrap permanent tasks (dream, etc.) on first run
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const promptsDir = join(__dirname, '..', 'prompts')
  await bootstrapPermanentTasks(RELVETIA_DIR, promptsDir)
  // Memory Hardening Phase 5 T5-5: pipe distillVerifier misses into evalStore
  await wireDistillVerifierToEvalStore()
  // memory-hardening-followup Phase D: normalize residual index shape on startup
  try {
    await ensureCanonicalIndexFormat(RELVETIA_MEMORY_DIR)
  } catch (e) {
    console.error('[relvetia] ensureCanonicalIndexFormat failed:', e)
  }
  // memory-hardening-followup Phase A: rewrite any numeric entry id → hierarchical
  try {
    await ensureHierarchicalEntryIds(RELVETIA_MEMORY_DIR)
  } catch (e) {
    console.error('[relvetia] ensureHierarchicalEntryIds failed:', e)
  }
  console.log(`[relvetia]   dir: ${RELVETIA_DIR}`)
  console.log(`[relvetia]   memory: ${RELVETIA_MEMORY_DIR}`)
  console.log(`[relvetia]   model: ${MODEL}`)
  console.log(`[relvetia]   id: ${DAEMON_ID}`)

  // saga 11 engine-cache-layer: register the chokidar factory (so
  // extracted resolves the module from the daemon's node_modules
  // rather than its own — chokidar is a daemon-side dep), then attach the
  // in-process search cache invalidator to RELVETIA_MEMORY_DIR. Polling
  // fallback engages if chokidar fails to load.
  setChokidarFactory(async (): Promise<ChokidarModule> => {
    // Resolve chokidar from THIS file's location (daemon-side node_modules
    // has chokidar) — extracted's resolution path does not.
    const moduleName = 'chokidar' as string
    return (await import(moduleName)) as unknown as ChokidarModule
  })
  try {
    const watcher = await attachMemoryDirWatcher(RELVETIA_MEMORY_DIR, getDefaultSearchCache())
    console.log(`[relvetia]   search-cache watcher mode: ${watcher.mode}`)
  } catch (e) {
    console.error('[relvetia] attachMemoryDirWatcher failed:', e)
  }

  scheduler = createCronScheduler({
    onFire: (prompt) => {
      void executePrompt(prompt, { model: MODEL, maxTurns: MAX_TURNS, cwd: RELVETIA_DIR })
        .catch(e => console.error('[relvetia] fire failed:', e))
    },
    onFireTask: (task) => void handleFire(task),
    onMissed: (tasks) => {
      console.log(`[relvetia] ${tasks.length} missed task(s) on startup:`)
      for (const t of tasks) {
        console.log(`  - ${t.id}: ${t.prompt.slice(0, 60)}`)
      }
    },
    dir: RELVETIA_DIR,
    lockIdentity: DAEMON_ID,
    isKilled,
    filter: taskAllowed,
  })

  scheduler.start()
}

function stop(): void {
  console.log('[relvetia] daemon shutting down...')
  scheduler?.stop()
  scheduler = null
  // Explicit detach: chokidar 4.x close() is Promise-based; fire-and-forget on
  // shutdown is acceptable since the process is about to exit anyway. The
  // catch keeps any close error from unhandled-rejecting on the way out.
  void detachMemoryDirWatcher(RELVETIA_MEMORY_DIR).catch(() => {})
}

// Graceful shutdown
process.on('SIGTERM', () => { stop(); process.exit(0) })
process.on('SIGINT', () => { stop(); process.exit(0) })

// Keep the process alive
const keepAlive = setInterval(() => {
  const next = scheduler?.getNextFireTime()
  if (next) {
    const inSec = ((next - Date.now()) / 1000).toFixed(0)
    console.log(`[relvetia] heartbeat — next fire in ${inSec}s`)
  }
}, 60_000)

// Don't let the heartbeat timer prevent shutdown
keepAlive.unref?.()
// But DO keep the process alive with a ref'd interval
const ref = setInterval(() => {}, 60_000)
void ref

// ---------------------------------------------------------------------------
// Git sync helper — calls relvetia-git-sync.sh for memory repo operations
// ---------------------------------------------------------------------------
function gitSync(action: string, message?: string): Promise<void> {
  const syncScript = join(homedir(), '.claude', 'scripts', 'relvetia-git-sync.sh')
  const args = [syncScript, action]
  if (message) args.push(message)
  return new Promise((resolve) => {
    execFile('bash', args, {
      timeout: 30_000,
      cwd: RELVETIA_MEMORY_DIR,
      env: { ...process.env, RELVETIA_MEMORY_DIR },
    }, (err) => {
      if (err) console.warn(`[relvetia] git sync failed (non-fatal): ${err.message}`)
      else console.log(`[relvetia] git sync: ${action} completed`)
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// First-session-of-day trigger — watches for .distill-needed file
// ---------------------------------------------------------------------------
const DISTILL_TRIGGER = join(RELVETIA_MEMORY_DIR, '.distill-needed')

const distillCheckInterval = setInterval(async () => {
  if (firing) return
  // The private daemon (RELVETIA_DAEMON_TASKS=private-distill) must not
  // direct-fire relvetia-dream from private memoryDir. The trigger file path
  // (DISTILL_TRIGGER = RELVETIA_MEMORY_DIR/.distill-needed) is already
  // RELVETIA_MEMORY_DIR-scoped, so a private-side trigger file would not
  // collide with the main-side one, but defending here as well keeps the
  // direct-fire path consistent with the scheduler filter.
  if (ALLOWED_TASKS && !ALLOWED_TASKS.has('relvetia-dream')) return
  if (!existsSync(DISTILL_TRIGGER)) return

  // Read trigger payload BEFORE unlink so we can log the source PID/PPID
  // (written by relvetia-memory-load.sh) — surfaces which process queued the
  // distillation, invaluable for diagnosing future runaway sources.
  let triggerPayload = ''
  try {
    triggerPayload = readFileSync(DISTILL_TRIGGER, 'utf-8').trim()
  } catch { /* empty/unreadable — proceed without the source breadcrumb */ }

  try {
    unlinkSync(DISTILL_TRIGGER)
  } catch { return }

  // Cooldown gate (Axis C): if the failure-budget has engaged a cooldown,
  // suppress the fire. We still unlinked the trigger above so it won't pile up
  // and re-fire 5s later.
  if (await isUnderCooldown('relvetia-dream')) {
    console.warn(
      `[relvetia] dream trigger skipped — under cooldown` +
        (triggerPayload ? ` (trigger: ${triggerPayload})` : ''),
    )
    return
  }

  console.log(
    `[relvetia] First session of day detected — triggering morning distillation` +
      (triggerPayload ? ` (trigger: ${triggerPayload})` : ''),
  )

  // Record the spawn before firing so HIGH SPAWN RATE warning fires even if
  // handleFire hangs/throws.
  recordSpawn('relvetia-dream')

  const tasks = await readCronTasks(RELVETIA_DIR)
  const dreamTask = tasks.find(t => t.id === 'relvetia-dream')
  if (dreamTask) {
    await handleFire(dreamTask)
  } else {
    console.warn('[relvetia] relvetia-dream task not found, skipping morning distillation')
  }
}, 5_000)
distillCheckInterval.unref?.()

void start()
