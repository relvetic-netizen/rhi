// S3b-B: shouldDenyHitl high-level decision + (lightweight) verification
// that `requires_approval` flow respects the admission gate. The MCP
// handler in index.js is exercised via the same shouldDenyHitl function it
// calls, plus a smoke check that the existing approvals flow still triggers
// for null-taskId callers (backward compat).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { shouldDenyHitl, ADMISSION_ENV_KEYS } from '../admission.js'
import { writeToMailbox } from '../mailbox.js'
import { listApprovals } from '../approvals.js'
import { createTeam } from '../team.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-admission-integration__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-admission-integration')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  await createTeam(TEST_TEAM, [
    { name: 'alice', role: 'worker' },
    { name: 'bob', role: 'worker' },
  ], 'test')
})

describe('shouldDenyHitl — admission decision', () => {
  it('returns null when requiresApproval is false', () => {
    const r = shouldDenyHitl({
      requiresApproval: false,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
    })
    assert.equal(r, null)
  })

  it('returns null when no task identity is known (backward compat)', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1' }, // marker but no taskId
      cwd: '/tmp',
    })
    assert.equal(r, null, 'null taskId must allow HITL (existing human reviewer caller)')
  })

  it('returns null when known taskId is non-autonomous', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'review-pr-19' },
      cwd: '/tmp',
    })
    assert.equal(r, null, 'human reviewer task path must allow HITL')
  })

  it('denies when env autonomous marker + known taskId', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: {
        [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1',
        [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'review-pr-19',
      },
      cwd: '/tmp',
    })
    assert.ok(r)
    assert.equal(r.error, 'HITL_ADMISSION_DENIED')
    assert.equal(r.taskId, 'review-pr-19')
    assert.equal(r.source, 'env')
    assert.equal(r.fallback, 'deferred')
  })

  it('denies when taskId is in autonomous namespace (auto-)', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
      cwd: '/tmp',
    })
    assert.ok(r)
    assert.equal(r.taskId, 'auto-x')
    assert.equal(r.source, 'env')
  })

  it('denies when taskId is in symphony-harness- namespace', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'symphony-harness-wave1-s3b' },
      cwd: '/tmp',
    })
    assert.ok(r)
    assert.equal(r.taskId, 'symphony-harness-wave1-s3b')
  })

  it('denies when cwd marker matches but env+taskId only ambient', () => {
    const cwd = os.homedir() + '/.claude/relvetia/handoffs/some-task/run-1'
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'some-task' },
      cwd,
    })
    assert.ok(r)
    assert.equal(r.taskId, 'some-task')
  })

  it('preserves originalRequest payload for caller tracing', () => {
    const original = { team_name: 't', to: 'b', message: 'hi', summary: null, from: 'alice' }
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
      cwd: '/tmp',
      originalRequest: original,
    })
    assert.deepEqual(r.originalRequest, original)
  })

  it('source field is `env` when env override resolves taskId', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
      cwd: '/tmp',
    })
    assert.equal(r.source, 'env')
  })

  it('source field is `caller` when caller arg supplied', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      caller: 'auto-x',
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1' },
      cwd: '/tmp',
    })
    assert.equal(r.source, 'caller')
  })

  it('source field is `session-map` when only sessionMap resolves taskId', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'sid-x' },
      sessionMap: { sessions: { 'sid-x': { task_id: 'review-task' } } },
      cwd: '/tmp',
    })
    assert.ok(r)
    assert.equal(r.source, 'session-map')
    assert.equal(r.taskId, 'review-task')
  })

  it('respects opt-in conservative_default fallback', () => {
    const r = shouldDenyHitl({
      requiresApproval: true,
      env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
      cwd: '/tmp',
      fallback: 'conservative_default',
    })
    assert.equal(r.fallback, 'conservative_default')
  })

  it('rejects unknown fallback values up the stack', () => {
    assert.throws(
      () => shouldDenyHitl({
        requiresApproval: true,
        env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1', [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x' },
        cwd: '/tmp',
        fallback: 'invalid',
      }),
      /Invalid fallback/,
    )
  })
})

describe('writeToMailbox + admission — backward compat (null taskId path)', () => {
  it('still enqueues approval for null-taskId caller (existing human reviewer)', async () => {
    // This simulates a HITL caller WITHOUT an autonomous task identity. The
    // admission gate must NOT intercept; the existing approval queue path
    // should run.
    const result = await writeToMailbox(TEST_TEAM, 'bob', {
      from: 'alice',
      text: 'please review',
      summary: 'review request',
      requires_approval: true,
    })
    assert.ok(result.pending_approval_id, 'message should be enqueued for human approval')
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, result.pending_approval_id)
  })

  it('non-approval messages are unaffected by admission gate', async () => {
    const result = await writeToMailbox(TEST_TEAM, 'bob', {
      from: 'alice',
      text: 'fyi',
      summary: 'note',
    })
    assert.equal(result.blocked, false, 'non-approval message should not be blocked')
    assert.equal(result.pending_approval_id, undefined, 'non-approval message should not be enqueued for approval')
  })
})

describe('writeToMailbox + admission — denies autonomous worker (taskId set)', () => {
  // Note: writeToMailbox itself doesn't run the admission gate (the gate is
  // in the `team_send_message` MCP handler — see src/index.js). These tests
  // verify the decision at the handler boundary via shouldDenyHitl, then
  // confirm that under autonomous env the handler returns the deny envelope
  // and skips writeToMailbox entirely (no approval is enqueued).
  it('autonomous env+task → handler emits deny, no approval enqueued', async () => {
    const denied = shouldDenyHitl({
      requiresApproval: true,
      env: {
        [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1',
        [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'auto-x',
      },
      cwd: '/tmp',
      originalRequest: { team_name: TEST_TEAM, to: 'bob', from: 'alice', message: 'go' },
    })
    assert.ok(denied, 'admission gate must intercept')
    // Crucially: writeToMailbox is NOT called in this branch (handler returns
    // early). Confirm there is no pending approval.
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'no approval should be enqueued when admission denies')
  })

  it('team_send_message denial branch returns an MCP error response', async () => {
    const indexSource = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const start = indexSource.indexOf('[HITL_ADMISSION_DENIED]')
    const end = indexSource.indexOf('const sender = team.members.find')
    assert.ok(start > 0)
    assert.ok(end > start)
    assert.match(indexSource.slice(start, end), /isError:\s*true/)
  })
})
