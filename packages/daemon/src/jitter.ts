/**
 * Jitter calculation — ported directly from claude-code cronTasks.ts.
 *
 * Deterministic per-task jitter to prevent thundering herd when many
 * sessions schedule the same cron string (e.g. `0 * * * *` → everyone
 * hits inference at :00).
 */

import { nextCronRunMs } from './cron.js'

/**
 * Cron scheduler tuning knobs. Sourced at runtime from remote config
 * in the original implementation (GrowthBook). Here we use static defaults
 * with optional env-var overrides.
 */
export type CronJitterConfig = {
  /** Recurring-task forward delay as a fraction of the interval between fires. */
  recurringFrac: number
  /** Upper bound on recurring forward delay regardless of interval length. */
  recurringCapMs: number
  /** One-shot backward lead: maximum ms a task may fire early. */
  oneShotMaxMs: number
  /** One-shot backward lead: minimum ms a task fires early. */
  oneShotFloorMs: number
  /** Jitter fires landing on minutes where `minute % N === 0`. */
  oneShotMinuteMod: number
  /**
   * Recurring tasks auto-expire this many ms after creation (unless marked
   * permanent). Default 7 days.
   */
  recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * taskId is an 8-hex-char UUID slice → parse as u32 → [0, 1).
 * Stable across restarts, uniformly distributed across the fleet.
 * Non-hex ids fall back to 0 = no jitter.
 */
export function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * Next cron run with a deterministic per-task delay (forward jitter).
 * Used for recurring tasks only. The delay is proportional to the gap
 * between fires, capped at recurringCapMs.
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  const t2 = nextCronRunMs(cron, t1)
  // No second match → nothing to proportion against, fire on t1.
  if (t2 === null) return t1
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  )
  return t1 + jitter
}

/**
 * Next cron run with a deterministic per-task lead (backward jitter).
 * Used for one-shot tasks only — firing early is invisible while
 * late breaks user trust.
 *
 * Only jitters fires landing on minute boundaries matching
 * oneShotMinuteMod (default: :00 and :30 — the human-rounding hotspots).
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs)
  if (t1 === null) return null
  // Local time minute check — cron is in local time.
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  return Math.max(t1 - lead, fromMs)
}
