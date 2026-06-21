import { describe, it, expect } from 'vitest'
import {
  parseCronExpression,
  computeNextCronRun,
  nextCronRunMs,
  cronToHuman,
} from '../src/cron.js'

describe('parseCronExpression', () => {
  it('accepts valid 5-field cron', () => {
    expect(parseCronExpression('0 * * * *')).toBe(true)
    expect(parseCronExpression('*/5 * * * *')).toBe(true)
    expect(parseCronExpression('30 14 28 2 *')).toBe(true)
    expect(parseCronExpression('0 9 * * 1-5')).toBe(true)
  })

  it('rejects invalid expressions', () => {
    expect(parseCronExpression('not-a-cron')).toBe(false)
    expect(parseCronExpression('')).toBe(false)
    expect(parseCronExpression('60 * * * *')).toBe(false)
  })
})

describe('computeNextCronRun', () => {
  it('returns the next matching time', () => {
    const from = new Date('2026-04-03T10:30:00')
    const next = computeNextCronRun('0 * * * *', from)
    expect(next).not.toBeNull()
    expect(next!.getHours()).toBe(11)
    expect(next!.getMinutes()).toBe(0)
  })

  it('returns null for invalid cron', () => {
    expect(computeNextCronRun('bad', new Date())).toBeNull()
  })
})

describe('nextCronRunMs', () => {
  it('returns epoch ms', () => {
    const from = new Date('2026-04-03T10:30:00').getTime()
    const result = nextCronRunMs('0 * * * *', from)
    expect(result).not.toBeNull()
    expect(typeof result).toBe('number')
    expect(result!).toBeGreaterThan(from)
  })
})

describe('cronToHuman', () => {
  it('describes every N minutes', () => {
    expect(cronToHuman('*/5 * * * *')).toBe('every 5 minutes')
  })

  it('describes every hour', () => {
    expect(cronToHuman('0 * * * *')).toBe('every hour')
  })

  it('describes daily at time', () => {
    expect(cronToHuman('30 9 * * *')).toBe('daily at 9:30')
  })

  it('describes weekdays', () => {
    expect(cronToHuman('0 9 * * 1-5')).toBe('weekdays at 9:00')
  })

  it('falls back to raw for complex expressions', () => {
    expect(cronToHuman('0 9 1 1 *')).toBe('1/1 at 9:00')
  })
})
