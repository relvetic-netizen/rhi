// S3b-A: admission gate primitives — inferTaskId + isAutonomousTaskPath
// + autonomousFallback. Verifies the source order mirrors ctx-budget.mjs's
// resolveActiveTaskId, the null-fallback HITL backward-compat, and every
// autonomy marker (env / task-id namespace / cwd path).

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  inferTaskId,
  isAutonomousTaskPath,
  autonomousFallback,
  ADMISSION_ENV_KEYS,
} from '../admission.js'

const TMP = path.join(process.cwd(), '.test-tmp-admission')

before(async () => {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(path.join(TMP, 'relvetia'), { recursive: true })
})

after(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('inferTaskId — source order (caller → env → session-map → null)', () => {
  it('caller wins over env', () => {
    const r = inferTaskId({
      caller: 'task-from-caller',
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'task-from-env' },
    })
    assert.equal(r.taskId, 'task-from-caller')
    assert.equal(r.source, 'caller')
  })

  it('caller wins over session-map', () => {
    const r = inferTaskId({
      caller: 'task-from-caller',
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'sid-1' },
      sessionMap: { sessions: { 'sid-1': { task_id: 'task-from-map' } } },
    })
    assert.equal(r.taskId, 'task-from-caller')
    assert.equal(r.source, 'caller')
  })

  it('env wins over session-map', () => {
    const r = inferTaskId({
      env: {
        [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'task-from-env',
        [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'sid-1',
      },
      sessionMap: { sessions: { 'sid-1': { task_id: 'task-from-map' } } },
    })
    assert.equal(r.taskId, 'task-from-env')
    assert.equal(r.source, 'env')
  })

  it('session-map fallback when no caller/env', () => {
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'sid-2' },
      sessionMap: { sessions: { 'sid-2': { task_id: 'task-from-map' } } },
    })
    assert.equal(r.taskId, 'task-from-map')
    assert.equal(r.source, 'session-map')
  })

  it('returns null when no source resolves (HITL backward compat)', () => {
    const r = inferTaskId({ env: {} })
    assert.equal(r.taskId, null)
    assert.equal(r.source, null)
  })

  it('null when sessionId missing from session-map', () => {
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'unknown-sid' },
      sessionMap: { sessions: { 'sid-3': { task_id: 'task-3' } } },
    })
    assert.equal(r.taskId, null)
    assert.equal(r.source, null)
  })

  it('explicit sessionId argument supersedes env CLAUDE_SESSION_ID', () => {
    const r = inferTaskId({
      sessionId: 'explicit-sid',
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'env-sid' },
      sessionMap: {
        sessions: {
          'explicit-sid': { task_id: 'task-explicit' },
          'env-sid': { task_id: 'task-env-sid' },
        },
      },
    })
    assert.equal(r.taskId, 'task-explicit')
    assert.equal(r.source, 'session-map')
  })

  it('treats empty caller string as missing (falls through to env)', () => {
    const r = inferTaskId({
      caller: '',
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: 'task-from-env' },
    })
    assert.equal(r.taskId, 'task-from-env')
    assert.equal(r.source, 'env')
  })

  it('treats empty env value as missing', () => {
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]: '' },
    })
    assert.equal(r.taskId, null)
  })

  it('coerces numeric caller to string', () => {
    const r = inferTaskId({ caller: 42 })
    assert.equal(r.taskId, '42')
    assert.equal(r.source, 'caller')
  })

  it('reads session-map from disk when none provided', async () => {
    const sid = 'disk-sid'
    const dir = path.join(TMP, 'cfg-' + Math.random().toString(36).slice(2, 8))
    await mkdir(path.join(dir, 'relvetia'), { recursive: true })
    await writeFile(
      path.join(dir, 'relvetia', 'session-task.json'),
      JSON.stringify({ schema_version: 1, sessions: { [sid]: { task_id: 'disk-task' } } }),
    )
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: sid },
      configDir: dir,
    })
    assert.equal(r.taskId, 'disk-task')
    assert.equal(r.source, 'session-map')
  })

  it('returns null when on-disk session-map is missing', () => {
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'any' },
      configDir: path.join(TMP, 'no-such-cfg'),
    })
    assert.equal(r.taskId, null)
  })

  it('returns null when on-disk session-map is corrupt JSON', async () => {
    const dir = path.join(TMP, 'cfg-corrupt')
    await mkdir(path.join(dir, 'relvetia'), { recursive: true })
    await writeFile(path.join(dir, 'relvetia', 'session-task.json'), '{ not valid')
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID]: 'any' },
      configDir: dir,
    })
    assert.equal(r.taskId, null)
  })

  it('falls back to RELVETIA_SESSION_ID when CLAUDE_SESSION_ID absent', () => {
    const r = inferTaskId({
      env: { [ADMISSION_ENV_KEYS.SESSION_ID]: 'rsid-1' },
      sessionMap: { sessions: { 'rsid-1': { task_id: 'task-rsid' } } },
    })
    assert.equal(r.taskId, 'task-rsid')
    assert.equal(r.source, 'session-map')
  })
})

describe('isAutonomousTaskPath — every marker (env / task-id namespace / cwd)', () => {
  const HOME = os.homedir().replace(/\\/g, '/')

  it('returns true on RELVETIA_AUTONOMOUS=1', () => {
    assert.equal(isAutonomousTaskPath({ env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '1' } }), true)
  })

  it('returns false on RELVETIA_AUTONOMOUS=0', () => {
    assert.equal(isAutonomousTaskPath({ env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: '0' } }), false)
  })

  it('returns false on RELVETIA_AUTONOMOUS=true (string `true` not accepted, only `1`)', () => {
    assert.equal(isAutonomousTaskPath({ env: { [ADMISSION_ENV_KEYS.AUTONOMOUS]: 'true' } }), false)
  })

  it('returns true for taskId in auto- namespace', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'auto-foo', env: {} }), true)
  })

  it('returns true for autoloop- namespace', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'autoloop-bar', env: {} }), true)
  })

  it('returns true for symphony-impl- namespace', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'symphony-impl-x', env: {} }), true)
  })

  it('returns true for symphony-harness- namespace', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'symphony-harness-wave1-s3b', env: {} }), true)
  })

  it('returns false for unrelated taskId', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'review-pr-123', env: {} }), false)
  })

  it('returns true when cwd is under the default handoffs root', () => {
    const cwd = `${HOME}/.claude/relvetia/handoffs/some-task/run-1`
    assert.equal(isAutonomousTaskPath({ cwd, env: {} }), true)
  })

  it('returns true when cwd is under the default tasks root', () => {
    const cwd = `${HOME}/workspace/relvetia-tasks/foo`
    assert.equal(isAutonomousTaskPath({ cwd, env: {} }), true)
  })

  it('honours RHI_HANDOFFS_ROOT override', () => {
    const cwd = '/srv/autonomy/handoffs/some-task/run-1'
    assert.equal(
      isAutonomousTaskPath({ cwd, env: { RHI_HANDOFFS_ROOT: '/srv/autonomy/handoffs' } }),
      true,
    )
  })

  it('honours RHI_TASKS_ROOT override', () => {
    const cwd = '/srv/autonomy/tasks/foo'
    assert.equal(
      isAutonomousTaskPath({ cwd, env: { RHI_TASKS_ROOT: '/srv/autonomy/tasks' } }),
      true,
    )
  })

  it('returns false for cwd that only resembles autonomous root', () => {
    const cwd = `${HOME}/workspace/relvetia-team/src`
    assert.equal(isAutonomousTaskPath({ cwd, env: {} }), false)
  })

  it('handles Windows-style backslashes in cwd', () => {
    const cwd = `${os.homedir()}\\.claude\\relvetia\\handoffs\\task-x`
    assert.equal(isAutonomousTaskPath({ cwd, env: {} }), true)
  })

  it('returns false when no marker present', () => {
    assert.equal(isAutonomousTaskPath({ taskId: 'pr-review', cwd: '/tmp', env: {} }), false)
  })

  it('null taskId is not autonomous on its own', () => {
    assert.equal(isAutonomousTaskPath({ taskId: null, env: {} }), false)
  })
})

describe('autonomousFallback', () => {
  it('default fallback is `deferred`', () => {
    const r = autonomousFallback({ taskId: 'auto-x', source: 'env' })
    assert.equal(r.fallback, 'deferred')
    assert.equal(r.error, 'HITL_ADMISSION_DENIED')
    assert.equal(r.taskId, 'auto-x')
    assert.equal(r.source, 'env')
  })

  it('accepts conservative_default explicitly', () => {
    const r = autonomousFallback({ taskId: 'auto-x', fallback: 'conservative_default' })
    assert.equal(r.fallback, 'conservative_default')
  })

  it('rejects unknown fallback values', () => {
    assert.throws(
      () => autonomousFallback({ fallback: 'something-else' }),
      /Invalid fallback/,
    )
  })

  it('preserves originalRequest payload for downstream caller', () => {
    const original = { team_name: 't', to: 'b', message: 'hi' }
    const r = autonomousFallback({ originalRequest: original })
    assert.deepEqual(r.originalRequest, original)
  })
})
