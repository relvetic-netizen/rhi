import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTask, listTasks, getTask, updateTask, deleteTask, resetTaskList } from '../tasks.js'

const TEST_TEAM = '__test-tasks__'

// Override CLAUDE_CONFIG_DIR for test isolation.
// Unique dir per test file so parallel `node --test *.test.js` runs don't
// collide (Windows + slow FS surfaces the race most reliably).
const TMP = join(process.cwd(), '.test-tmp-tasks')
const origDir = process.env.CLAUDE_CONFIG_DIR
before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('createTask', () => {
  it('returns monotonically increasing IDs', async () => {
    const TEAM = '__test-mono__'
    const t1 = await createTask(TEAM, { subject: 'Task 1' })
    const t2 = await createTask(TEAM, { subject: 'Task 2' })
    const t3 = await createTask(TEAM, { subject: 'Task 3' })
    assert.equal(t1.id, '1')
    assert.equal(t2.id, '2')
    assert.equal(t3.id, '3')
  })

  it('produces unique IDs under concurrent calls', async () => {
    const TEAM = '__test-concurrent__'
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createTask(TEAM, { subject: `Concurrent ${i}` })
      )
    )
    const ids = results.map(t => t.id)
    const unique = new Set(ids)
    assert.equal(unique.size, 10, `Expected 10 unique IDs, got ${unique.size}: ${ids}`)
  })

  it('does not reuse deleted task IDs', async () => {
    const TEAM = '__test-noreuse__'
    const t1 = await createTask(TEAM, { subject: 'Will delete' })
    const t2 = await createTask(TEAM, { subject: 'Keep' })
    await deleteTask(TEAM, t2.id)
    const t3 = await createTask(TEAM, { subject: 'After delete' })
    assert.ok(parseInt(t3.id) > parseInt(t2.id), `New ID ${t3.id} should be > deleted ${t2.id}`)
  })

  it('sets default values correctly', async () => {
    const TEAM = '__test-defaults__'
    const t = await createTask(TEAM, { subject: 'Test' })
    assert.equal(t.status, 'pending')
    assert.equal(t.owner, null)
    assert.equal(t.description, '')
    assert.deepEqual(t.blocks, [])
    assert.deepEqual(t.blockedBy, [])
    assert.equal(typeof t.createdAt, 'number')
  })
})

describe('getTask', () => {
  it('returns null for nonexistent task', async () => {
    const result = await getTask(TEST_TEAM, '999')
    assert.equal(result, null)
  })

  it('validates required fields', async () => {
    // Write a corrupt task file directly
    const { getTaskListDir, ensureDir } = await import('../paths.js')
    const dir = getTaskListDir(TEST_TEAM)
    await ensureDir(dir)
    await writeFile(join(dir, '1.json'), '{"broken": true}')

    const result = await getTask(TEST_TEAM, '1')
    assert.equal(result, null, 'Should return null for invalid schema')
  })

  it('returns null on corrupt JSON', async () => {
    const { getTaskListDir, ensureDir } = await import('../paths.js')
    const dir = getTaskListDir(TEST_TEAM)
    await ensureDir(dir)
    await writeFile(join(dir, '1.json'), 'not json{{{')

    const result = await getTask(TEST_TEAM, '1')
    assert.equal(result, null, 'Should return null for corrupt JSON')
  })
})

describe('updateTask', () => {
  it('returns null for nonexistent task', async () => {
    const result = await updateTask(TEST_TEAM, '999', { status: 'completed' })
    assert.equal(result, null)
  })

  it('updates status and owner', async () => {
    const t = await createTask(TEST_TEAM, { subject: 'Update me' })
    const updated = await updateTask(TEST_TEAM, t.id, {
      status: 'in_progress',
      owner: 'researcher',
    })
    assert.equal(updated.status, 'in_progress')
    assert.equal(updated.owner, 'researcher')
    assert.ok(updated.updatedAt >= t.updatedAt)
  })
})

describe('listTasks', () => {
  it('returns empty array for nonexistent team', async () => {
    const tasks = await listTasks('nonexistent-team-xyz')
    assert.deepEqual(tasks, [])
  })

  it('skips corrupt files gracefully', async () => {
    const TEAM = '__test-corrupt__'
    const t1 = await createTask(TEAM, { subject: 'Good task' })
    const { getTaskListDir } = await import('../paths.js')
    const dir = getTaskListDir(TEAM)
    await writeFile(join(dir, '999.json'), 'corrupt{{')

    const tasks = await listTasks(TEAM)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].subject, 'Good task')
  })

  it('returns tasks sorted by ID', async () => {
    const TEAM = '__test-sorted__'
    await createTask(TEAM, { subject: 'First' })
    await createTask(TEAM, { subject: 'Second' })
    await createTask(TEAM, { subject: 'Third' })

    const tasks = await listTasks(TEAM)
    assert.deepEqual(tasks.map(t => t.subject), ['First', 'Second', 'Third'])
  })
})

describe('resetTaskList', () => {
  it('preserves high water mark', async () => {
    const TEAM = '__test-reset__'
    await createTask(TEAM, { subject: 'T1' })
    await createTask(TEAM, { subject: 'T2' })
    await createTask(TEAM, { subject: 'T3' })

    await resetTaskList(TEAM)
    const tasks = await listTasks(TEAM)
    assert.equal(tasks.length, 0)

    const t4 = await createTask(TEAM, { subject: 'After reset' })
    assert.equal(t4.id, '4', 'Should continue from HWM, not restart at 1')
  })
})
