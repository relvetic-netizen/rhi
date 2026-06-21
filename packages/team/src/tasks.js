// Shared task list — modeled on Claude Code's tasks.ts
// Key patterns adopted:
//   - Dual HWM source (file + directory scan) for crash-safe ID generation (tasks.ts:271-277)
//   - Existence check before lock (tasks.ts:378-379)
//   - Schema validation on read (tasks.ts:333-339)
//   - Per-step error logging (tasks.ts:341-350)

import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { getTaskListDir, getTaskPath, getHighWaterMarkPath, getTaskLockPath, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeFileAtomic } from './fs-utils.js'
import { errorMessage, isEnoent } from './errors.js'
import { validate as validateSchema } from './schema-validator.js'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Schema validation (lightweight, no zod dependency for reads)
// ---------------------------------------------------------------------------

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed'])

function validateTask(data) {
  if (!data || typeof data !== 'object') return null
  if (typeof data.id !== 'string') return null
  if (typeof data.subject !== 'string') return null
  if (!VALID_STATUSES.has(data.status)) return null
  return {
    id: data.id,
    subject: data.subject,
    description: typeof data.description === 'string' ? data.description : '',
    owner: typeof data.owner === 'string' ? data.owner : null,
    status: data.status,
    blocks: Array.isArray(data.blocks) ? data.blocks : [],
    blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
    resultSchema: data.resultSchema && typeof data.resultSchema === 'object' ? data.resultSchema : null,
    result: data.result !== undefined ? data.result : null,
    evaluations: Array.isArray(data.evaluations) ? data.evaluations : [],
    createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
  }
}

// ---------------------------------------------------------------------------
// High water mark — crash-safe ID generation
// ---------------------------------------------------------------------------

async function getHighWaterMarkFromFile(teamName) {
  try {
    const data = await readFile(getHighWaterMarkPath(teamName), 'utf-8')
    return parseInt(data.trim(), 10) || 0
  } catch {
    return 0
  }
}

/**
 * Scan task directory for the highest existing task ID.
 * This is the crash-safety mechanism: even if the HWM file wasn't updated,
 * we find the real highest ID from disk. (Modeled on tasks.ts:246-265)
 */
async function findHighestTaskIdFromFiles(teamName) {
  const dir = getTaskListDir(teamName)
  let maxId = 0
  try {
    const files = await readdir(dir)
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const id = parseInt(f.replace('.json', ''), 10)
      if (!isNaN(id) && id > maxId) maxId = id
    }
  } catch (e) {
    if (!isEnoent(e)) {
      console.error(`[tasks] Failed to scan task directory: ${errorMessage(e)}`)
    }
  }
  return maxId
}

/**
 * Get the true highest task ID from both sources.
 * Modeled on tasks.ts:271-277: Math.max(hwmFile, directoryScan)
 */
async function findHighestTaskId(teamName) {
  const [fromFile, fromDir] = await Promise.all([
    getHighWaterMarkFromFile(teamName),
    findHighestTaskIdFromFiles(teamName),
  ])
  return Math.max(fromFile, fromDir)
}

async function setHighWaterMark(teamName, id) {
  await writeFile(getHighWaterMarkPath(teamName), String(id))
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function resetTaskList(teamName) {
  const dir = getTaskListDir(teamName)
  await ensureDir(dir)

  const lockPath = getTaskLockPath(teamName)
  await withLock(lockPath, async () => {
    let maxId = 0
    try {
      const files = await readdir(dir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const id = parseInt(f.replace('.json', ''), 10)
        if (!isNaN(id) && id > maxId) maxId = id
        await unlink(join(dir, f))
      }
    } catch (e) {
      if (!isEnoent(e)) throw e
    }
    if (maxId > 0) await setHighWaterMark(teamName, maxId)
  })
}

export async function createTask(teamName, task) {
  const dir = getTaskListDir(teamName)
  await ensureDir(dir)

  const lockPath = getTaskLockPath(teamName)
  return await withLock(lockPath, async () => {
    // Crash-safe: read from both HWM file and directory scan
    const highestId = await findHighestTaskId(teamName)
    const newId = highestId + 1

    const taskData = {
      id: String(newId),
      subject: task.subject,
      description: task.description || '',
      owner: task.owner || null,
      status: task.status || 'pending',
      blocks: task.blocks || [],
      blockedBy: task.blockedBy || [],
      resultSchema: task.resultSchema || null,
      result: task.result !== undefined ? task.result : null,
      evaluations: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    // Write task file and HWM together under the same lock
    await writeFileAtomic(getTaskPath(teamName, newId), JSON.stringify(taskData, null, 2))
    await setHighWaterMark(teamName, newId)
    return taskData
  })
}

/**
 * Update a task. Returns updated task or null if not found.
 * Checks existence before acquiring lock (tasks.ts:378-379 pattern).
 */
export async function updateTask(teamName, taskId, updates) {
  // Existence check before lock — avoids ENOENT inside critical section
  const existing = await getTask(teamName, taskId)
  if (!existing) return null

  const lockPath = getTaskLockPath(teamName)
  return await withLock(lockPath, async () => {
    // Re-read under lock (may have changed since existence check)
    const taskPath = getTaskPath(teamName, taskId)
    let data
    try {
      data = JSON.parse(await readFile(taskPath, 'utf-8'))
    } catch (e) {
      if (isEnoent(e)) return null
      throw e
    }

    Object.assign(data, updates, { updatedAt: Date.now() })
    await writeFileAtomic(taskPath, JSON.stringify(data, null, 2))
    return data
  })
}

export async function listTasks(teamName) {
  const dir = getTaskListDir(teamName)
  let files
  try {
    files = await readdir(dir)
  } catch (e) {
    if (isEnoent(e)) return []
    throw e
  }

  const tasks = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const taskId = f.replace('.json', '')
    const task = await getTask(teamName, taskId)
    if (task) tasks.push(task)
  }
  return tasks.sort((a, b) => parseInt(a.id) - parseInt(b.id))
}

/**
 * Read and validate a single task. Returns null on missing or invalid.
 * Modeled on tasks.ts:310-350.
 */
export async function getTask(teamName, taskId) {
  try {
    const data = JSON.parse(await readFile(getTaskPath(teamName, taskId), 'utf-8'))
    const validated = validateTask(data)
    if (!validated) {
      console.error(`[tasks] Task ${taskId} failed schema validation`)
      return null
    }
    return validated
  } catch (e) {
    if (isEnoent(e)) return null
    console.error(`[tasks] Failed to read task ${taskId}: ${errorMessage(e)}`)
    return null
  }
}

/**
 * Complete a task with an optional structured result.
 *
 * If the task has a resultSchema, the result is validated against it before
 * the task is marked completed. Validation failure returns { ok: false, errors }.
 *
 * If the task has unsatisfied blockedBy dependencies, completion is refused
 * unless force=true. This enforces the dependency declaration that was
 * previously only metadata.
 *
 * Returns { ok, errors?, task? }.
 */
export async function completeTask(teamName, taskId, result, opts = {}) {
  const existing = await getTask(teamName, taskId)
  if (!existing) return { ok: false, errors: [`task ${taskId} not found`] }

  if (existing.resultSchema && result !== undefined && result !== null) {
    const v = validateSchema(existing.resultSchema, result)
    if (!v.valid) return { ok: false, errors: v.errors }
  }

  if (!opts.force && Array.isArray(existing.blockedBy) && existing.blockedBy.length > 0) {
    const unfinished = []
    for (const depId of existing.blockedBy) {
      const dep = await getTask(teamName, depId)
      if (!dep || dep.status !== 'completed') unfinished.push(depId)
    }
    if (unfinished.length > 0) {
      return { ok: false, errors: [`blocked by incomplete tasks: ${unfinished.join(', ')}`] }
    }
  }

  const task = await updateTask(teamName, taskId, {
    status: 'completed',
    result: result !== undefined ? result : existing.result,
  })
  return { ok: true, task }
}

/**
 * Append an evaluation record to a task. Used by team_evaluate_task after a
 * judge agent returns a verdict. Stores the evaluator, free-text verdict,
 * optional structured score, and a timestamp.
 */
export async function appendEvaluation(teamName, taskId, evaluation) {
  const existing = await getTask(teamName, taskId)
  if (!existing) return null

  const entry = {
    by: evaluation.by,
    text: evaluation.text || '',
    score: evaluation.score !== undefined ? evaluation.score : null,
    passed: typeof evaluation.passed === 'boolean' ? evaluation.passed : null,
    timestamp: new Date().toISOString(),
  }

  const lockPath = getTaskLockPath(teamName)
  return await withLock(lockPath, async () => {
    const taskPath = getTaskPath(teamName, taskId)
    let data
    try {
      data = JSON.parse(await readFile(taskPath, 'utf-8'))
    } catch (e) {
      if (isEnoent(e)) return null
      throw e
    }
    data.evaluations = Array.isArray(data.evaluations) ? data.evaluations : []
    data.evaluations.push(entry)
    data.updatedAt = Date.now()
    await writeFileAtomic(taskPath, JSON.stringify(data, null, 2))
    return entry
  })
}

export async function deleteTask(teamName, taskId) {
  // Update HWM before delete to prevent ID reuse (tasks.ts:400-408)
  const lockPath = getTaskLockPath(teamName)
  return await withLock(lockPath, async () => {
    const taskPath = getTaskPath(teamName, taskId)
    try {
      const id = parseInt(taskId, 10)
      if (!isNaN(id)) {
        const currentHwm = await getHighWaterMarkFromFile(teamName)
        if (id > currentHwm) await setHighWaterMark(teamName, id)
      }
      await unlink(taskPath)
      return true
    } catch (e) {
      if (isEnoent(e)) return false
      throw e
    }
  })
}
