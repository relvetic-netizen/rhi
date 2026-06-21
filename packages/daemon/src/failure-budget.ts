/**
 * Failure budget + spawn-rate observer (Axis C + Axis F, merged per plan §S2+S3).
 *
 * Two related signals share one in-memory event log:
 *   - recordSpawn(taskId)        : every fire (success or failure)
 *   - recordFailure(taskId, ec)  : every non-zero exit
 *
 * - Rolling-window failure count >= FAILURE_THRESHOLD       → cooldown engaged
 *   (writes .dream-cooldown.json so a daemon restart still respects it)
 * - Rolling-window spawn count   >= FAILURE_THRESHOLD       → stderr warning
 *   ("HIGH SPAWN RATE: ...") — a runaway and a rapid-fail loop look identical
 *
 * Daemon restart clears the in-memory event log (acceptable trade-off — restarts
 * are rare and the cooldown file itself is persisted), so a single restart
 * after engaging cooldown doesn't lose the suppression.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJSON } from '../../extracted/util/atomicWrite.js'
import { getRelvetiaDir } from './dirs.js'

const DEFAULT_COOLDOWN_FILE = join(getRelvetiaDir(), '.dream-cooldown.json')
const DEFAULT_THRESHOLD = parseInt(process.env.RELVETIA_FAILURE_THRESHOLD ?? '3', 10)
const DEFAULT_WINDOW_MIN = parseInt(process.env.RELVETIA_FAILURE_WINDOW_MIN ?? '60', 10)
const DEFAULT_COOLDOWN_HOURS = 24

type Event = { taskId: string; ts: number; isFailure: boolean }
type Cooldown = { taskId: string; until: string; reason: string }

type Config = {
  cooldownFile: string
  threshold: number
  windowMin: number
  cooldownHours: number
  now: () => number
}

const events: Event[] = []
let cfg: Config = {
  cooldownFile: DEFAULT_COOLDOWN_FILE,
  threshold: DEFAULT_THRESHOLD,
  windowMin: DEFAULT_WINDOW_MIN,
  cooldownHours: DEFAULT_COOLDOWN_HOURS,
  now: () => Date.now(),
}

/** Test-only: override config (cooldown file path, threshold, clock, etc.). */
export function configureFailureBudget(overrides: Partial<Config>): void {
  cfg = { ...cfg, ...overrides }
}

/** Test-only: clear the in-memory event log. */
export function resetFailureBudget(): void {
  events.length = 0
}

function pruneOld(now: number): void {
  const cutoff = now - cfg.windowMin * 60 * 1000
  while (events.length > 0 && events[0].ts < cutoff) events.shift()
}

/**
 * Record a fire (success or failure). Emits a HIGH SPAWN RATE warning to
 * stderr when the rolling-window count for this task reaches the threshold —
 * gives the operator early signal before the cooldown engages, and also
 * surfaces non-failing runaway loops (e.g. retry storms that all return 0).
 */
export function recordSpawn(taskId: string): void {
  const now = cfg.now()
  events.push({ taskId, ts: now, isFailure: false })
  pruneOld(now)
  const recent = events.filter(e => e.taskId === taskId).length
  if (recent >= cfg.threshold) {
    console.error(
      `[relvetia] HIGH SPAWN RATE: ${taskId} fired ${recent} times in ${cfg.windowMin}min`,
    )
  }
}

/**
 * Record a failed fire (non-zero exit). When the rolling-window failure count
 * reaches threshold, write the cooldown sentinel — distillCheckInterval reads
 * it via isUnderCooldown() and skips spawning until `until` passes.
 */
export async function recordFailure(
  taskId: string,
  exitCode: number,
  _durationMs: number,
): Promise<void> {
  const now = cfg.now()
  events.push({ taskId, ts: now, isFailure: true })
  pruneOld(now)
  const recentFailures = events.filter(e => e.taskId === taskId && e.isFailure).length
  if (recentFailures >= cfg.threshold) {
    const until = new Date(now + cfg.cooldownHours * 3600 * 1000)
    const cooldown: Cooldown = {
      taskId,
      until: until.toISOString(),
      reason: `${recentFailures} failures (exit ${exitCode}) within ${cfg.windowMin}min`,
    }
    try {
      await atomicWriteJSON(cfg.cooldownFile, cooldown)
      console.error(
        `[relvetia] COOLDOWN engaged for ${taskId} until ${until.toISOString()} — ${cooldown.reason}`,
      )
    } catch (err) {
      console.error('[relvetia] failed to write cooldown file:', err)
    }
  }
}

/**
 * Returns true when `.dream-cooldown.json` records an unexpired cooldown for
 * the given task. distillCheckInterval calls this before firing so a runaway
 * loop is structurally suppressed until the operator clears the file.
 */
export async function isUnderCooldown(taskId: string): Promise<boolean> {
  if (!existsSync(cfg.cooldownFile)) return false
  try {
    const data = JSON.parse(readFileSync(cfg.cooldownFile, 'utf-8')) as Cooldown
    if (data.taskId !== taskId) return false
    return new Date(data.until).getTime() > cfg.now()
  } catch {
    return false
  }
}
