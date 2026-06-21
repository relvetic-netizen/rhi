/**
 * Scheduled task persistence — ported from claude-code cronTasks.ts.
 *
 * All bootstrap/state.js dependencies removed. This module operates
 * exclusively via the `dir` parameter (the daemon path). No session
 * tasks — everything is durable (file-backed).
 *
 * File format: { "tasks": [{ id, cron, prompt, createdAt, lastFiredAt?,
 *                             recurring?, permanent? }] }
 */

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { parseCronExpression, nextCronRunMs } from './cron.js'
import { atomicWriteJSON } from '../../extracted/util/atomicWrite.js'

export type CronTask = {
  id: string
  /** 5-field cron string (local time). */
  cron: string
  /** Prompt to enqueue when the task fires. */
  prompt: string
  /** Epoch ms when the task was created. */
  createdAt: number
  /** Epoch ms of the most recent fire (recurring tasks). */
  lastFiredAt?: number
  /** When true, reschedules after firing instead of being deleted. */
  recurring?: boolean
  /** When true, exempt from recurringMaxAgeMs auto-expiry. */
  permanent?: boolean
  /** When set, the task fires through a deterministic native handler in
   *  the daemon process instead of spawning Claude. The handler is looked
   *  up by name in handleFire. The `prompt` field is unused in this mode
   *  but kept for forward compatibility. */
  nativeHandler?: string
}

type CronFile = { tasks: CronTask[] }

const CRON_FILE_REL = join('.claude', 'scheduled_tasks.json')

/**
 * Path to the cron file within the given directory.
 */
export function getCronFilePath(dir: string): string {
  return join(dir, CRON_FILE_REL)
}

/**
 * Read and parse scheduled_tasks.json. Returns empty list if missing,
 * empty, or malformed. Tasks with invalid cron strings are silently
 * dropped so one bad entry never blocks the file.
 */
export async function readCronTasks(dir: string): Promise<CronTask[]> {
  let raw: string
  try {
    raw = await readFile(getCronFilePath(dir), { encoding: 'utf-8' })
  } catch (e: unknown) {
    if (isFileNotFound(e)) return []
    console.error('[relvetia] readCronTasks error:', e)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!parsed || typeof parsed !== 'object') return []
  const file = parsed as Partial<CronFile>
  if (!Array.isArray(file.tasks)) return []

  const out: CronTask[] = []
  for (const t of file.tasks) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      typeof t.cron !== 'string' ||
      typeof t.prompt !== 'string' ||
      typeof t.createdAt !== 'number'
    ) {
      console.warn('[relvetia] skipping malformed task:', JSON.stringify(t))
      continue
    }
    if (!parseCronExpression(t.cron)) {
      console.warn(`[relvetia] skipping task ${t.id} with invalid cron '${t.cron}'`)
      continue
    }
    out.push({
      id: t.id,
      cron: t.cron,
      prompt: t.prompt,
      createdAt: t.createdAt,
      ...(typeof t.lastFiredAt === 'number' ? { lastFiredAt: t.lastFiredAt } : {}),
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.permanent ? { permanent: true } : {}),
      ...(typeof (t as CronTask).nativeHandler === 'string'
        ? { nativeHandler: (t as CronTask).nativeHandler }
        : {}),
    })
  }
  return out
}

/**
 * Sync check for whether the cron file has any valid tasks.
 */
export function hasCronTasksSync(dir: string): boolean {
  let raw: string
  try {
    raw = readFileSync(getCronFilePath(dir), 'utf-8')
  } catch {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  const tasks = (parsed as Partial<CronFile>).tasks
  return Array.isArray(tasks) && tasks.length > 0
}

/**
 * Overwrite scheduled_tasks.json with the given tasks.
 * Creates .claude/ if missing.
 */
export async function writeCronTasks(
  tasks: CronTask[],
  dir: string,
): Promise<void> {
  await mkdir(join(dir, '.claude'), { recursive: true })
  const body: CronFile = { tasks }
  await atomicWriteJSON(getCronFilePath(dir), body)
}

/**
 * Append a task. Returns the generated id.
 * All tasks are durable (file-backed) in the daemon.
 *
 * @param fixedId - When provided, uses this exact id instead of generating
 *                  a random one. Used by bootstrapPermanentTasks to ensure
 *                  stable ids across daemon restarts.
 */
export async function addCronTask(
  dir: string,
  cron: string,
  prompt: string,
  recurring: boolean,
  permanent: boolean = false,
  fixedId?: string,
  nativeHandler?: string,
): Promise<string> {
  const id = fixedId ?? randomUUID().slice(0, 8)
  const task: CronTask = {
    id,
    cron,
    prompt,
    createdAt: Date.now(),
    ...(recurring ? { recurring: true } : {}),
    ...(permanent ? { permanent: true } : {}),
    ...(nativeHandler ? { nativeHandler } : {}),
  }
  const tasks = await readCronTasks(dir)
  tasks.push(task)
  await writeCronTasks(tasks, dir)
  return id
}

/**
 * Remove tasks by id. No-op if none match.
 */
export async function removeCronTasks(
  ids: string[],
  dir: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  const remaining = tasks.filter(t => !idSet.has(t.id))
  if (remaining.length === tasks.length) return
  await writeCronTasks(remaining, dir)
}

/**
 * Stamp lastFiredAt on the given recurring tasks and write back.
 * Batched so N fires in one tick = one read-modify-write.
 */
export async function markCronTasksFired(
  ids: string[],
  firedAt: number,
  dir: string,
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const tasks = await readCronTasks(dir)
  let changed = false
  for (const t of tasks) {
    if (idSet.has(t.id)) {
      t.lastFiredAt = firedAt
      changed = true
    }
  }
  if (!changed) return
  await writeCronTasks(tasks, dir)
}

/**
 * A task is "missed" when its next scheduled run (computed from createdAt)
 * is in the past. Surfaced to the user at startup.
 */
export function findMissedTasks(tasks: CronTask[], nowMs: number): CronTask[] {
  return tasks.filter(t => {
    const next = nextCronRunMs(t.cron, t.createdAt)
    return next !== null && next < nowMs
  })
}

function isFileNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
}
