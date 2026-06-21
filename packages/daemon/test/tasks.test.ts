import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readCronTasks,
  writeCronTasks,
  addCronTask,
  removeCronTasks,
  markCronTasksFired,
  findMissedTasks,
  hasCronTasksSync,
} from '../src/tasks.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'relvetia-test-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('readCronTasks', () => {
  it('returns empty array when file does not exist', async () => {
    const tasks = await readCronTasks(testDir)
    expect(tasks).toEqual([])
  })

  it('reads valid tasks', async () => {
    await writeCronTasks([
      { id: 'abc', cron: '0 * * * *', prompt: 'test', createdAt: 1000 },
    ], testDir)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('abc')
  })

  it('skips tasks with invalid cron', async () => {
    await writeCronTasks([
      { id: 'good', cron: '0 * * * *', prompt: 'test', createdAt: 1000 },
      { id: 'bad', cron: 'not-a-cron', prompt: 'test', createdAt: 1000 },
    ], testDir)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('good')
  })
})

describe('addCronTask', () => {
  it('creates a task with generated id', async () => {
    const id = await addCronTask(testDir, '0 * * * *', 'hello', true)
    expect(id).toHaveLength(8)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].prompt).toBe('hello')
    expect(tasks[0].recurring).toBe(true)
  })
})

describe('removeCronTasks', () => {
  it('removes tasks by id', async () => {
    await writeCronTasks([
      { id: 'a', cron: '0 * * * *', prompt: 'keep', createdAt: 1000 },
      { id: 'b', cron: '0 * * * *', prompt: 'remove', createdAt: 1000 },
    ], testDir)
    await removeCronTasks(['b'], testDir)
    const tasks = await readCronTasks(testDir)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('a')
  })
})

describe('markCronTasksFired', () => {
  it('updates lastFiredAt for matching tasks', async () => {
    await writeCronTasks([
      { id: 'x', cron: '0 * * * *', prompt: 'test', createdAt: 1000, recurring: true },
    ], testDir)
    await markCronTasksFired(['x'], 5000, testDir)
    const tasks = await readCronTasks(testDir)
    expect(tasks[0].lastFiredAt).toBe(5000)
  })
})

describe('findMissedTasks', () => {
  it('finds tasks whose next run is in the past', () => {
    const past = Date.now() - 86400000  // 24h ago
    const tasks = [
      { id: 'missed', cron: '0 12 * * *', prompt: 'test', createdAt: past },
    ]
    const missed = findMissedTasks(tasks, Date.now())
    expect(missed).toHaveLength(1)
  })
})

describe('hasCronTasksSync', () => {
  it('returns false when no file', () => {
    expect(hasCronTasksSync(testDir)).toBe(false)
  })

  it('returns true after writing tasks', async () => {
    await addCronTask(testDir, '0 * * * *', 'test', false)
    expect(hasCronTasksSync(testDir)).toBe(true)
  })
})
