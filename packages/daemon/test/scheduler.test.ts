import { describe, it, expect } from 'vitest'
import { isRecurringTaskAged } from '../src/scheduler.js'
import type { CronTask } from '../src/tasks.js'

describe('isRecurringTaskAged', () => {
  const baseTask: CronTask = {
    id: 'test',
    cron: '0 * * * *',
    prompt: 'test',
    createdAt: 0,
    recurring: true,
  }

  it('returns false when maxAgeMs is 0 (unlimited)', () => {
    expect(isRecurringTaskAged(baseTask, 999999999, 0)).toBe(false)
  })

  it('returns false for non-recurring tasks', () => {
    const oneShot = { ...baseTask, recurring: undefined }
    expect(isRecurringTaskAged(oneShot, 999999999, 1000)).toBe(false)
  })

  it('returns false for permanent tasks', () => {
    const permanent = { ...baseTask, permanent: true }
    expect(isRecurringTaskAged(permanent, 999999999, 1000)).toBe(false)
  })

  it('returns true when task age exceeds maxAgeMs', () => {
    const task = { ...baseTask, createdAt: 1000 }
    expect(isRecurringTaskAged(task, 5000, 3000)).toBe(true)
  })

  it('returns false when task age is within maxAgeMs', () => {
    const task = { ...baseTask, createdAt: 1000 }
    expect(isRecurringTaskAged(task, 3000, 5000)).toBe(false)
  })
})
