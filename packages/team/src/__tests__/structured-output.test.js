import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTask, completeTask, getTask } from '../tasks.js'
import { validate } from '../schema-validator.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-structured__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-structured')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => { await rm(TMP, { recursive: true, force: true }) })

describe('schema-validator', () => {
  it('validates type:string', () => {
    assert.equal(validate({ type: 'string' }, 'ok').valid, true)
    assert.equal(validate({ type: 'string' }, 42).valid, false)
  })

  it('validates required properties', () => {
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
    assert.equal(validate(schema, { name: 'x' }).valid, true)
    const result = validate(schema, {})
    assert.equal(result.valid, false)
    assert.match(result.errors[0], /required/)
  })

  it('validates nested properties', () => {
    const schema = {
      type: 'object',
      required: ['user'],
      properties: {
        user: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
        },
      },
    }
    assert.equal(validate(schema, { user: { email: 'a@b' } }).valid, true)
    assert.equal(validate(schema, { user: { email: 123 } }).valid, false)
  })

  it('validates array items', () => {
    const schema = { type: 'array', items: { type: 'integer' } }
    assert.equal(validate(schema, [1, 2, 3]).valid, true)
    assert.equal(validate(schema, [1, 'two', 3]).valid, false)
  })

  it('validates enum', () => {
    const schema = { type: 'string', enum: ['a', 'b', 'c'] }
    assert.equal(validate(schema, 'a').valid, true)
    assert.equal(validate(schema, 'd').valid, false)
  })

  it('treats integer and number distinctly', () => {
    assert.equal(validate({ type: 'integer' }, 1.5).valid, false)
    assert.equal(validate({ type: 'integer' }, 1).valid, true)
    assert.equal(validate({ type: 'number' }, 1.5).valid, true)
  })
})

describe('completeTask', () => {
  it('completes task with no schema', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'simple' })
    const result = await completeTask(TEST_TEAM, task.id, { done: true })
    assert.equal(result.ok, true)
    assert.equal(result.task.status, 'completed')
    assert.deepEqual(result.task.result, { done: true })
  })

  it('rejects result that fails schema validation', async () => {
    const schema = {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer' } },
    }
    const task = await createTask(TEST_TEAM, { subject: 'measure', resultSchema: schema })
    const bad = await completeTask(TEST_TEAM, task.id, { count: 'not a number' })
    assert.equal(bad.ok, false)
    assert.match(bad.errors[0], /expected integer/)

    // Task should still be pending
    const unchanged = await getTask(TEST_TEAM, task.id)
    assert.equal(unchanged.status, 'pending')
  })

  it('accepts result that matches schema', async () => {
    const schema = {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer' } },
    }
    const task = await createTask(TEST_TEAM, { subject: 'measure', resultSchema: schema })
    const ok = await completeTask(TEST_TEAM, task.id, { count: 42 })
    assert.equal(ok.ok, true)
    assert.equal(ok.task.result.count, 42)
  })

  it('refuses completion when blockers are unfinished', async () => {
    const blocker = await createTask(TEST_TEAM, { subject: 'prereq' })
    const blocked = await createTask(TEST_TEAM, {
      subject: 'dependent',
      blockedBy: [blocker.id],
    })
    const attempt = await completeTask(TEST_TEAM, blocked.id, null)
    assert.equal(attempt.ok, false)
    assert.match(attempt.errors[0], /blocked by incomplete/)
  })

  it('allows completion when blockers are completed', async () => {
    const blocker = await createTask(TEST_TEAM, { subject: 'prereq' })
    await completeTask(TEST_TEAM, blocker.id, null)
    const blocked = await createTask(TEST_TEAM, {
      subject: 'dependent',
      blockedBy: [blocker.id],
    })
    const attempt = await completeTask(TEST_TEAM, blocked.id, null)
    assert.equal(attempt.ok, true)
  })

  it('force=true bypasses blockedBy check', async () => {
    const blocker = await createTask(TEST_TEAM, { subject: 'prereq' })
    const blocked = await createTask(TEST_TEAM, {
      subject: 'dependent',
      blockedBy: [blocker.id],
    })
    const attempt = await completeTask(TEST_TEAM, blocked.id, null, { force: true })
    assert.equal(attempt.ok, true)
  })

  it('returns error for unknown task', async () => {
    const attempt = await completeTask(TEST_TEAM, '9999', null)
    assert.equal(attempt.ok, false)
    assert.match(attempt.errors[0], /not found/)
  })
})
