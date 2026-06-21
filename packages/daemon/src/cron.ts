/**
 * Cron expression utilities — wraps `croner` to replace the original
 * claude-code/src/utils/cron.ts which was not extracted.
 *
 * Provides the same interface the scheduler and tasks modules expect:
 *   parseCronExpression, computeNextCronRun, cronToHuman
 */

import { Cron } from 'croner'

/**
 * Validate a 5-field cron expression. Returns true if valid.
 */
export function parseCronExpression(expr: string): boolean {
  try {
    // Cron constructor throws on invalid expressions
    new Cron(expr, { maxRuns: 0 })
    return true
  } catch {
    return false
  }
}

/**
 * Compute the next run time strictly after `from`.
 * Returns null if no match within ~366 days.
 */
export function computeNextCronRun(expr: string, from: Date): Date | null {
  try {
    const job = new Cron(expr)
    const next = job.nextRun(from)
    return next ?? null
  } catch {
    return null
  }
}

/**
 * Next fire time in epoch ms for a cron string, strictly after `fromMs`.
 * Returns null if invalid or no match in the next 366 days.
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const next = computeNextCronRun(cron, new Date(fromMs))
  return next ? next.getTime() : null
}

/**
 * Human-readable description of a cron expression.
 * Covers common patterns; falls back to the raw expression.
 */
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  const [min, hour, dom, mon, dow] = parts

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `every ${min.slice(2)} minutes`
  }

  // Every hour at minute N
  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return min === '0' ? 'every hour' : `every hour at :${min.padStart(2, '0')}`
  }

  // Daily at H:MM
  if (dom === '*' && mon === '*' && dow === '*') {
    return `daily at ${hour}:${min.padStart(2, '0')}`
  }

  // Weekdays
  if (dom === '*' && mon === '*' && dow === '1-5') {
    return `weekdays at ${hour}:${min.padStart(2, '0')}`
  }

  // Specific date (one-shot pattern)
  if (dom !== '*' && mon !== '*') {
    return `${mon}/${dom} at ${hour}:${min.padStart(2, '0')}`
  }

  return expr
}
