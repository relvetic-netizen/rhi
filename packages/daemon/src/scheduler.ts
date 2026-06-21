/**
 * Cron scheduler core — ported from claude-code cronScheduler.ts.
 *
 * Daemon-only mode: operates exclusively via `dir` parameter.
 * All bootstrap/state.js dependencies removed. No session tasks,
 * no assistantMode, no getScheduledTasksEnabled() polling.
 *
 * Lifecycle: start() → acquire lock → watch file + 1s timer →
 * check() fires tasks → stop() tears down.
 */

import type { FSWatcher } from 'chokidar'
import {
  type CronJitterConfig,
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
} from './jitter.js'
import {
  type CronTask,
  findMissedTasks,
  getCronFilePath,
  hasCronTasksSync,
  markCronTasksFired,
  readCronTasks,
  removeCronTasks,
} from './tasks.js'
import {
  tryAcquireSchedulerLock,
  releaseSchedulerLock,
} from './lock.js'

const CHECK_INTERVAL_MS = 1000
const FILE_STABILITY_MS = 300
const LOCK_PROBE_INTERVAL_MS = 5000

/**
 * True when a recurring task was created more than `maxAgeMs` ago and
 * should be deleted on its next fire. Permanent tasks never age.
 */
export function isRecurringTaskAged(
  t: CronTask,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (maxAgeMs === 0) return false
  return Boolean(t.recurring && !t.permanent && nowMs - t.createdAt >= maxAgeMs)
}

export type CronSchedulerOptions = {
  /** Called when a task fires. */
  onFire: (prompt: string) => void
  /** Receives the full CronTask on fire (if set, onFire is NOT called). */
  onFireTask?: (task: CronTask) => void
  /** Receives missed one-shot tasks on initial load. */
  onMissed?: (tasks: CronTask[]) => void
  /** Directory containing .claude/scheduled_tasks.json. Required. */
  dir: string
  /** Owner key for the lock file. Defaults to process PID as string. */
  lockIdentity?: string
  /** Returns jitter config for this tick. Defaults to DEFAULT. */
  getJitterConfig?: () => CronJitterConfig
  /** Kill switch: when true, check() bails before firing. */
  isKilled?: () => boolean
  /** Per-task visibility gate. Tasks returning false are invisible. */
  filter?: (t: CronTask) => boolean
}

export type CronScheduler = {
  start: () => void
  stop: () => void
  /** Epoch ms of the soonest fire, or null if nothing scheduled. */
  getNextFireTime: () => number | null
}

export function createCronScheduler(
  options: CronSchedulerOptions,
): CronScheduler {
  const {
    onFire,
    onFireTask,
    onMissed,
    dir,
    lockIdentity = String(process.pid),
    getJitterConfig,
    isKilled,
    filter,
  } = options
  const lockOpts = { dir, lockIdentity }

  let tasks: CronTask[] = []
  const nextFireAt = new Map<string, number>()
  const missedAsked = new Set<string>()
  const inFlight = new Set<string>()

  let checkTimer: ReturnType<typeof setInterval> | null = null
  let lockProbeTimer: ReturnType<typeof setInterval> | null = null
  let watcher: FSWatcher | null = null
  let stopped = false
  let isOwner = false

  async function load(initial: boolean) {
    const next = await readCronTasks(dir)
    if (stopped) return
    tasks = next

    if (!initial) return

    // Surface missed one-shot tasks on initial load only
    const now = Date.now()
    const missed = findMissedTasks(next, now).filter(
      t => !t.recurring && !missedAsked.has(t.id) && (!filter || filter(t)),
    )
    if (missed.length > 0) {
      for (const t of missed) {
        missedAsked.add(t.id)
        nextFireAt.set(t.id, Infinity)
      }
      if (onMissed) {
        onMissed(missed)
      } else {
        onFire(buildMissedTaskNotification(missed))
      }
      void removeCronTasks(missed.map(t => t.id), dir).catch(e =>
        console.error(`[relvetia] failed to remove missed tasks: ${e}`),
      )
      console.log(`[relvetia] surfaced ${missed.length} missed one-shot task(s)`)
    }
  }

  function check() {
    if (isKilled?.()) return
    const now = Date.now()
    const seen = new Set<string>()
    const firedFileRecurring: string[] = []
    const jitterCfg = getJitterConfig?.() ?? DEFAULT_CRON_JITTER_CONFIG

    function processTask(t: CronTask) {
      if (filter && !filter(t)) return
      seen.add(t.id)
      if (inFlight.has(t.id)) return

      let next = nextFireAt.get(t.id)
      if (next === undefined) {
        next = t.recurring
          ? (jitteredNextCronRunMs(
              t.cron,
              t.lastFiredAt ?? t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
          : (oneShotJitteredNextCronRunMs(
              t.cron,
              t.createdAt,
              t.id,
              jitterCfg,
            ) ?? Infinity)
        nextFireAt.set(t.id, next)
        console.log(
          `[relvetia] scheduled ${t.id} for ${next === Infinity ? 'never' : new Date(next).toISOString()}`,
        )
      }

      if (now < next) return

      console.log(
        `[relvetia] firing ${t.id}${t.recurring ? ' (recurring)' : ''}`,
      )
      if (onFireTask) {
        onFireTask(t)
      } else {
        onFire(t.prompt)
      }

      const aged = isRecurringTaskAged(t, now, jitterCfg.recurringMaxAgeMs)
      if (aged) {
        const ageHours = Math.floor((now - t.createdAt) / 1000 / 60 / 60)
        console.log(
          `[relvetia] recurring task ${t.id} aged out (${ageHours}h), deleting`,
        )
      }

      if (t.recurring && !aged) {
        const newNext =
          jitteredNextCronRunMs(t.cron, now, t.id, jitterCfg) ?? Infinity
        nextFireAt.set(t.id, newNext)
        firedFileRecurring.push(t.id)
      } else {
        // One-shot or aged-out: delete from disk
        inFlight.add(t.id)
        void removeCronTasks([t.id], dir)
          .catch(e =>
            console.error(`[relvetia] failed to remove task ${t.id}: ${e}`),
          )
          .finally(() => inFlight.delete(t.id))
        nextFireAt.delete(t.id)
      }
    }

    if (isOwner) {
      for (const t of tasks) processTask(t)
      if (firedFileRecurring.length > 0) {
        for (const id of firedFileRecurring) inFlight.add(id)
        void markCronTasksFired(firedFileRecurring, now, dir)
          .catch(e =>
            console.error(`[relvetia] failed to persist lastFiredAt: ${e}`),
          )
          .finally(() => {
            for (const id of firedFileRecurring) inFlight.delete(id)
          })
      }
    }

    if (seen.size === 0) {
      nextFireAt.clear()
      return
    }
    for (const id of nextFireAt.keys()) {
      if (!seen.has(id)) nextFireAt.delete(id)
    }
  }

  async function enable() {
    if (stopped) return

    const { default: chokidar } = await import('chokidar')
    if (stopped) return

    isOwner = await tryAcquireSchedulerLock(lockOpts).catch(() => false)
    if (stopped) {
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
      return
    }
    if (!isOwner) {
      lockProbeTimer = setInterval(() => {
        void tryAcquireSchedulerLock(lockOpts)
          .then(owned => {
            if (stopped) {
              if (owned) void releaseSchedulerLock(lockOpts)
              return
            }
            if (owned) {
              isOwner = true
              if (lockProbeTimer) {
                clearInterval(lockProbeTimer)
                lockProbeTimer = null
              }
              console.log('[relvetia] acquired scheduler lock (takeover)')
            }
          })
          .catch(e => console.error(String(e)))
      }, LOCK_PROBE_INTERVAL_MS)
      lockProbeTimer.unref?.()
    } else {
      console.log('[relvetia] acquired scheduler lock')
    }

    void load(true)

    const path = getCronFilePath(dir)
    watcher = chokidar.watch(path, {
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: FILE_STABILITY_MS },
      ignorePermissionErrors: true,
    })
    watcher.on('add', () => void load(false))
    watcher.on('change', () => void load(false))
    watcher.on('unlink', () => {
      if (!stopped) {
        tasks = []
        nextFireAt.clear()
      }
    })

    checkTimer = setInterval(check, CHECK_INTERVAL_MS)
    checkTimer.unref?.()
  }

  return {
    start() {
      stopped = false
      console.log(
        `[relvetia] scheduler start() — dir=${dir}, hasTasks=${hasCronTasksSync(dir)}`,
      )
      void enable()
    },
    stop() {
      stopped = true
      if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
      }
      if (lockProbeTimer) {
        clearInterval(lockProbeTimer)
        lockProbeTimer = null
      }
      void watcher?.close()
      watcher = null
      if (isOwner) {
        isOwner = false
        void releaseSchedulerLock(lockOpts)
      }
      console.log('[relvetia] scheduler stopped')
    },
    getNextFireTime() {
      let min = Infinity
      for (const t of nextFireAt.values()) {
        if (t < min) min = t
      }
      return min === Infinity ? null : min
    },
  }
}

function buildMissedTaskNotification(missed: CronTask[]): string {
  const plural = missed.length > 1
  const header =
    `The following one-shot scheduled task${plural ? 's were' : ' was'} missed while the daemon was not running. ` +
    `${plural ? 'They have' : 'It has'} already been removed from scheduled_tasks.json.\n\n` +
    `Review and execute if still relevant:`

  const blocks = missed.map(t => {
    const meta = `[created ${new Date(t.createdAt).toLocaleString()}]`
    return `${meta}\n\`\`\`\n${t.prompt}\n\`\`\``
  })

  return `${header}\n\n${blocks.join('\n\n')}`
}
