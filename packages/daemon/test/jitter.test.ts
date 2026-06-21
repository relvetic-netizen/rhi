import { describe, it, expect } from 'vitest'
import {
  jitterFrac,
  jitteredNextCronRunMs,
  oneShotJitteredNextCronRunMs,
  DEFAULT_CRON_JITTER_CONFIG,
} from '../src/jitter.js'

describe('jitterFrac', () => {
  it('returns a value in [0, 1) for valid hex', () => {
    const frac = jitterFrac('a1b2c3d4')
    expect(frac).toBeGreaterThanOrEqual(0)
    expect(frac).toBeLessThan(1)
  })

  it('is deterministic — same input, same output', () => {
    expect(jitterFrac('deadbeef')).toBe(jitterFrac('deadbeef'))
  })

  it('returns 0 for non-hex input', () => {
    expect(jitterFrac('zzzzzzzz')).toBe(0)
  })

  it('different IDs produce different fractions', () => {
    expect(jitterFrac('00000001')).not.toBe(jitterFrac('ffffffff'))
  })

  it('00000000 returns 0', () => {
    expect(jitterFrac('00000000')).toBe(0)
  })
})

describe('jitteredNextCronRunMs (recurring)', () => {
  // Use a known cron: every hour at :00
  const cron = '0 * * * *'

  it('returns a time after the base next-run', () => {
    const from = new Date('2026-04-03T10:30:00').getTime()
    const result = jitteredNextCronRunMs(cron, from, 'a1b2c3d4')
    expect(result).not.toBeNull()
    // Should be >= the raw next run (11:00)
    const rawNext = new Date('2026-04-03T11:00:00').getTime()
    expect(result!).toBeGreaterThanOrEqual(rawNext)
  })

  it('jitter is bounded by recurringCapMs', () => {
    const from = new Date('2026-04-03T10:30:00').getTime()
    const rawNext = new Date('2026-04-03T11:00:00').getTime()
    const result = jitteredNextCronRunMs(cron, from, 'ffffffff')
    expect(result!).toBeLessThanOrEqual(
      rawNext + DEFAULT_CRON_JITTER_CONFIG.recurringCapMs,
    )
  })

  it('returns null for invalid cron', () => {
    expect(jitteredNextCronRunMs('invalid', Date.now(), 'abc')).toBeNull()
  })
})

describe('oneShotJitteredNextCronRunMs', () => {
  it('fires early (backward jitter) for :00 minute marks', () => {
    // One-shot at 3:00pm
    const cron = '0 15 3 4 *'  // April 3 at 15:00
    const from = new Date('2026-04-03T10:00:00').getTime()
    const rawNext = new Date('2026-04-03T15:00:00').getTime()
    const result = oneShotJitteredNextCronRunMs(cron, from, 'a1b2c3d4')
    expect(result).not.toBeNull()
    // Should be <= raw (fires early)
    expect(result!).toBeLessThanOrEqual(rawNext)
    // But not earlier than fromMs
    expect(result!).toBeGreaterThanOrEqual(from)
  })

  it('does not jitter non-matching minute marks', () => {
    // One-shot at 3:17pm — minute 17 is not divisible by 30
    const cron = '17 15 3 4 *'
    const from = new Date('2026-04-03T10:00:00').getTime()
    const rawNext = new Date('2026-04-03T15:17:00').getTime()
    const result = oneShotJitteredNextCronRunMs(cron, from, 'a1b2c3d4')
    expect(result).toBe(rawNext)
  })
})
