import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withSpan, emitEvent, setProcessors, currentContext } from '../tracing.js'
import { getTeamDir, ensureDir } from '../paths.js'

const TEST_TEAM = '__test-tracing__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-tracing')

before(() => { process.env.CLAUDE_CONFIG_DIR = TMP })
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  setProcessors([async (span) => {
    const { appendFile } = await import('node:fs/promises')
    const path = span.team_name
      ? join(getTeamDir(span.team_name), 'traces.jsonl')
      : join(TMP, 'swarm-traces.jsonl')
    await ensureDir(dirname(path))
    await appendFile(path, JSON.stringify(span) + '\n')
  }])
})

describe('withSpan', () => {
  it('writes a span to JSONL file scoped by team', async () => {
    await withSpan('tool.test', { team_name: TEST_TEAM, foo: 1 }, async () => {
      return 'ok'
    })
    const content = await readFile(join(getTeamDir(TEST_TEAM), 'traces.jsonl'), 'utf-8')
    const span = JSON.parse(content.trim().split('\n')[0])
    assert.equal(span.name, 'tool.test')
    assert.equal(span.status, 'ok')
    assert.equal(span.team_name, TEST_TEAM)
    assert.equal(span.attrs.foo, 1)
    assert.ok(span.trace_id.startsWith('trace_'))
    assert.ok(span.span_id.startsWith('span_'))
    assert.equal(span.parent_span_id, null)
    assert.ok(typeof span.duration_ms === 'number')
  })

  it('nested spans inherit trace_id and set parent_span_id', async () => {
    let outerCtx = null
    let innerCtx = null
    await withSpan('outer', { team_name: TEST_TEAM }, async () => {
      outerCtx = currentContext()
      await withSpan('inner', { team_name: TEST_TEAM }, async () => {
        innerCtx = currentContext()
      })
    })
    assert.equal(outerCtx.trace_id, innerCtx.trace_id)
    assert.equal(innerCtx.parent_span_id, outerCtx.span_id)
  })

  it('records error status when fn throws', async () => {
    await assert.rejects(
      withSpan('will-fail', { team_name: TEST_TEAM }, async () => {
        throw new Error('boom')
      })
    )
    const content = await readFile(join(getTeamDir(TEST_TEAM), 'traces.jsonl'), 'utf-8')
    const span = JSON.parse(content.trim())
    assert.equal(span.status, 'error')
    assert.equal(span.error, 'boom')
  })
})

describe('emitEvent', () => {
  it('writes a zero-duration event span', async () => {
    await emitEvent('guardrail.tripped', { team_name: TEST_TEAM, reason: 'test' })
    const content = await readFile(join(getTeamDir(TEST_TEAM), 'traces.jsonl'), 'utf-8')
    const span = JSON.parse(content.trim())
    assert.equal(span.name, 'guardrail.tripped')
    assert.equal(span.status, 'event')
    assert.equal(span.duration_ms, 0)
    assert.equal(span.attrs.reason, 'test')
  })
})
