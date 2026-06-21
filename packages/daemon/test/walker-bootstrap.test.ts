/**
 * walker-bootstrap.test.ts — schedule.json → permanent task expansion.
 *
 * Tests cover:
 *   - hhmmToCron correctly converts HH:MM to 5-field cron
 *   - hhmmToCron rejects malformed / out-of-range / non-string input
 *   - walkerScheduleToTasks aggregates same-minute hours into one cron
 *   - walkerScheduleToTasks splits mixed-minute schedules into separate tasks
 *   - loadWalkerPermanentTasks reads schedule.json and skips disabled walkers
 *   - loadWalkerPermanentTasks gracefully degrades on missing / malformed file
 *   - bootstrapPermanentTasks registers walker tasks and removes stale ones
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  hhmmToCron,
  walkerScheduleToTasks,
  loadWalkerPermanentTasks,
  bootstrapPermanentTasks,
} from '../src/bootstrap.js'
import { readCronTasks } from '../src/tasks.js'

describe('hhmmToCron', () => {
  it('converts standard HH:MM to "<MM> <HH> * * *"', () => {
    expect(hhmmToCron('09:00')).toBe('0 9 * * *')
    expect(hhmmToCron('21:00')).toBe('0 21 * * *')
    expect(hhmmToCron('00:30')).toBe('30 0 * * *')
    expect(hhmmToCron('13:45')).toBe('45 13 * * *')
    expect(hhmmToCron('23:59')).toBe('59 23 * * *')
  })

  it('returns null for malformed strings', () => {
    expect(hhmmToCron('9:00')).toBe('0 9 * * *')   // single-digit hour allowed (\d{1,2})
    expect(hhmmToCron('25:00')).toBeNull()
    expect(hhmmToCron('09:60')).toBeNull()
    expect(hhmmToCron('-1:00')).toBeNull()
    expect(hhmmToCron('09:5')).toBeNull()
    expect(hhmmToCron('abc')).toBeNull()
    expect(hhmmToCron('')).toBeNull()
  })

  it('returns null for non-string input', () => {
    expect(hhmmToCron(null)).toBeNull()
    expect(hhmmToCron(undefined)).toBeNull()
    expect(hhmmToCron(900)).toBeNull()
    expect(hhmmToCron({})).toBeNull()
  })
})

describe('walkerScheduleToTasks', () => {
  it('aggregates same-minute hours into a single cron expression', () => {
    const tasks = walkerScheduleToTasks('private-walker-x', ['09:00', '21:00'])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      id: 'private-walker-x',
      cron: '0 9,21 * * *',
      nativeHandler: 'runWalker',
      recurring: true,
      permanent: true,
    })
  })

  it('handles single-time schedule', () => {
    const tasks = walkerScheduleToTasks('private-walker-discord', ['12:00'])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].cron).toBe('0 12 * * *')
    expect(tasks[0].id).toBe('private-walker-discord')
  })

  it('splits mixed-minute schedules into separate tasks with suffixed ids', () => {
    const tasks = walkerScheduleToTasks('private-walker-x', ['09:00', '13:30'])
    expect(tasks).toHaveLength(2)
    const ids = tasks.map(t => t.id).sort()
    expect(ids).toEqual([
      'private-walker-x-09-00',
      'private-walker-x-13-30',
    ])
    const crons = tasks.map(t => t.cron).sort()
    expect(crons).toEqual(['0 9 * * *', '30 13 * * *'])
  })

  it('returns empty array for empty schedule', () => {
    expect(walkerScheduleToTasks('private-walker-x', [])).toEqual([])
  })

  it('skips invalid HH:MM entries silently (graceful degrade)', () => {
    const tasks = walkerScheduleToTasks('private-walker-x', ['09:00', 'invalid', '25:00', '21:00'])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].cron).toBe('0 9,21 * * *')
  })

  it('skips non-string entries (e.g. object form, reserved for v2)', () => {
    const tasks = walkerScheduleToTasks(
      'private-walker-x',
      ['09:00', { time: '21:00', days: ['mon'] } as unknown as string],
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0].cron).toBe('0 9 * * *')
  })

  it('marks walker tasks as recurring + permanent + nativeHandler=runWalker', () => {
    const tasks = walkerScheduleToTasks('private-walker-x', ['09:00'])
    expect(tasks[0].recurring).toBe(true)
    expect(tasks[0].permanent).toBe(true)
    expect(tasks[0].nativeHandler).toBe('runWalker')
  })
})

describe('loadWalkerPermanentTasks', () => {
  let dir: string
  let schedulePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'walker-bootstrap-'))
    schedulePath = join(dir, 'schedule.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('expands enabled walkers from schedule.json', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': {
          enabled: true,
          schedule: ['09:00', '21:00'],
        },
        'private-walker-discord': {
          enabled: true,
          schedule: ['12:00'],
        },
      },
    }))
    const tasks = await loadWalkerPermanentTasks(schedulePath)
    expect(tasks).toHaveLength(2)
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]))
    expect(byId['private-walker-x'].cron).toBe('0 9,21 * * *')
    expect(byId['private-walker-discord'].cron).toBe('0 12 * * *')
  })

  it('skips walkers with enabled=false', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: false, schedule: ['09:00'] },
        'private-walker-discord': { enabled: true, schedule: ['12:00'] },
      },
    }))
    const tasks = await loadWalkerPermanentTasks(schedulePath)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].id).toBe('private-walker-discord')
  })

  it('skips walkers with empty schedule (suppressed)', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: [] },
      },
    }))
    expect(await loadWalkerPermanentTasks(schedulePath)).toEqual([])
  })

  it('returns empty array when schedule.json does not exist', async () => {
    const result = await loadWalkerPermanentTasks(join(dir, 'nonexistent.json'))
    expect(result).toEqual([])
  })

  it('returns empty array on malformed JSON (graceful degrade, daemon must not crash)', async () => {
    await writeFile(schedulePath, '{ this is not valid json')
    const result = await loadWalkerPermanentTasks(schedulePath)
    expect(result).toEqual([])
  })

  it('treats missing walkers field as no walkers', async () => {
    await writeFile(schedulePath, JSON.stringify({ _meta: {} }))
    expect(await loadWalkerPermanentTasks(schedulePath)).toEqual([])
  })
})

describe('bootstrapPermanentTasks (integration with walker schedule)', () => {
  let root: string
  let dir: string
  let promptsDir: string
  let schedulePath: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'walker-bootstrap-int-'))
    dir = join(root, 'rel')
    promptsDir = join(root, 'prompts')
    schedulePath = join(root, 'schedule.json')
    await mkdir(join(dir, '.claude'), { recursive: true })
    await mkdir(promptsDir, { recursive: true })
    // distill family の prompt-file は最小限のスタブ
    for (const f of ['distill.md', 'verify-prompt.md', 'optimize-prompt.md']) {
      await writeFile(join(promptsDir, f), `# stub ${f}\n`)
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('registers walker tasks alongside distill family', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: ['09:00', '21:00'] },
        'private-walker-discord': { enabled: true, schedule: ['12:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    const tasks = await readCronTasks(dir)
    const ids = tasks.map(t => t.id).sort()
    expect(ids).toContain('private-walker-x')
    expect(ids).toContain('private-walker-discord')
    expect(ids).toContain('relvetia-dream')
    const xTask = tasks.find(t => t.id === 'private-walker-x')!
    expect(xTask.cron).toBe('0 9,21 * * *')
    expect(xTask.nativeHandler).toBe('runWalker')
    expect(xTask.recurring).toBe(true)
    expect(xTask.permanent).toBe(true)
  })

  it('removes stale walker tasks when schedule is removed (本人 disable / suppress)', async () => {
    // First: register both
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: ['09:00'] },
        'private-walker-discord': { enabled: true, schedule: ['12:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    let tasks = await readCronTasks(dir)
    expect(tasks.find(t => t.id === 'private-walker-x')).toBeDefined()
    expect(tasks.find(t => t.id === 'private-walker-discord')).toBeDefined()

    // Then: private suppresses x-walker
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: false, schedule: ['09:00'] },
        'private-walker-discord': { enabled: true, schedule: ['12:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    tasks = await readCronTasks(dir)
    expect(tasks.find(t => t.id === 'private-walker-x')).toBeUndefined()
    expect(tasks.find(t => t.id === 'private-walker-discord')).toBeDefined()
  })

  it('refreshes walker cron when schedule changes (HH:MM 改変が pm2 restart で反映)', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: ['09:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    let xTask = (await readCronTasks(dir)).find(t => t.id === 'private-walker-x')!
    expect(xTask.cron).toBe('0 9 * * *')

    // 本人が朝抜きにして夜だけにした
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: ['22:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    xTask = (await readCronTasks(dir)).find(t => t.id === 'private-walker-x')!
    expect(xTask.cron).toBe('0 22 * * *')
  })

  it('preserves lastFiredAt across reload when only cron changes (recurring state intact)', async () => {
    await writeFile(schedulePath, JSON.stringify({
      walkers: {
        'private-walker-x': { enabled: true, schedule: ['09:00'] },
      },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    // Stamp a fake lastFiredAt by editing the file directly
    const cronFile = join(dir, '.claude', 'scheduled_tasks.json')
    const data = JSON.parse(await readFile(cronFile, 'utf8'))
    const t = data.tasks.find((x: { id: string }) => x.id === 'private-walker-x')
    t.lastFiredAt = 1234567890
    await writeFile(cronFile, JSON.stringify(data))
    // Update schedule
    await writeFile(schedulePath, JSON.stringify({
      walkers: { 'private-walker-x': { enabled: true, schedule: ['10:00'] } },
    }))
    await bootstrapPermanentTasks(dir, promptsDir, schedulePath)
    const xTask = (await readCronTasks(dir)).find(t => t.id === 'private-walker-x')!
    expect(xTask.cron).toBe('0 10 * * *')
    expect(xTask.lastFiredAt).toBe(1234567890)
  })

  it('still bootstraps distill family when walker schedule.json is missing', async () => {
    // No schedule file
    await bootstrapPermanentTasks(dir, promptsDir, join(root, 'missing.json'))
    const tasks = await readCronTasks(dir)
    expect(tasks.find(t => t.id === 'relvetia-dream')).toBeDefined()
    expect(tasks.find(t => t.id === 'private-walker-x')).toBeUndefined()
  })

  it('removes deprecated relvetia-recover task left over from earlier daemon versions', async () => {
    // Seed scheduled_tasks.json with the legacy entry as a prior daemon
    // would have left it.
    const cronFile = join(dir, '.claude', 'scheduled_tasks.json')
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(cronFile, JSON.stringify({
      tasks: [{
        id: 'relvetia-recover',
        cron: '30 2 * * *',
        prompt: '<native:recoverMissedSessions>',
        recurring: true,
        permanent: true,
        nativeHandler: 'recoverMissedSessions',
        createdAt: Date.now(),
      }],
    }))
    await bootstrapPermanentTasks(dir, promptsDir, join(root, 'missing.json'))
    const tasks = await readCronTasks(dir)
    expect(tasks.find(t => t.id === 'relvetia-recover')).toBeUndefined()
    expect(tasks.find(t => t.id === 'relvetia-dream')).toBeDefined()
  })
})
