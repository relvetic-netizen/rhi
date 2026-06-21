/**
 * walker-executor.ts unit tests.
 *
 * Tests cover:
 *   - WALKER_PATHS mapping resolves the expected walker.ts files
 *   - buildWalkerEnv injects RELVETIA_DAEMON_CHILD + WALKER_TASK_ID
 *   - runWalker spawns the configured command and resolves on exit
 *   - runWalker SIGTERMs the child after timeoutMs and reports timedOut
 *   - runWalker rejects via thrown Error for unmapped task ids
 *
 * The integration with the actual Agent SDK is covered by walker-x.test /
 * walker-discord.test (dry-run mode mocking the SDK).
 */

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import {
  WALKER_PATHS,
  DEFAULT_WALKER_TIMEOUT_MS,
  buildWalkerEnv,
  runWalker,
} from '../src/walker-executor.js'
import type { CronTask } from '../src/tasks.js'

// Spawn cwd for runWalker tests. Default in walker-executor.ts is
// `~/.claude/relvetia/private`, which exists on developer machines but NOT
// on CI runners — spawn ENOENTs there, child fails to start, and the test
// observes exitCode=1 / timedOut=false instead of the asserted value.
// Use os.tmpdir() so tests are self-contained on any host.
const TEST_CWD = tmpdir()

function makeTask(id: string): CronTask {
  return {
    id,
    cron: '0 9 * * *',
    prompt: '<native:runWalker>',
    createdAt: Date.now(),
    recurring: true,
    permanent: true,
    nativeHandler: 'runWalker',
  }
}

describe('walker-executor — WALKER_PATHS', () => {
  it('maps both walker task ids to the expected .ts paths under private/walkers', () => {
    const HOME = homedir()
    expect(WALKER_PATHS['private-walker-x']).toBe(
      join(HOME, '.claude', 'relvetia', 'private', 'walkers', 'x-walker.ts'),
    )
    expect(WALKER_PATHS['private-walker-discord']).toBe(
      join(HOME, '.claude', 'relvetia', 'private', 'walkers', 'discord-walker.ts'),
    )
  })

  it('exposes a 6 minute default timeout (300s wall + buffer)', () => {
    expect(DEFAULT_WALKER_TIMEOUT_MS).toBe(6 * 60 * 1000)
  })
})

describe('walker-executor — buildWalkerEnv', () => {
  it('injects RELVETIA_DAEMON_CHILD=1 and WALKER_TASK_ID', () => {
    const env = buildWalkerEnv('private-walker-x')
    expect(env.RELVETIA_DAEMON_CHILD).toBe('1')
    expect(env.WALKER_TASK_ID).toBe('private-walker-x')
  })

  it('inherits process.env (e.g. PATH must be present so spawn can locate node)', () => {
    const env = buildWalkerEnv('private-walker-discord')
    expect(env.PATH ?? env.Path).toBeTruthy()
  })
})

describe('walker-executor — runWalker', () => {
  it('throws when task.id has no walker mapping', async () => {
    const task = makeTask('private-walker-nonexistent')
    await expect(runWalker(task)).rejects.toThrow(/no walker mapping/)
  })

  it('runs an arbitrary command and resolves with its exit code', async () => {
    const task = makeTask('private-walker-x')
    // Override walkerPath to a node script that exits 0 quickly. We use `node`
    // with an inline `-e` so we don't depend on tsx being on PATH for this
    // test.
    const result = await runWalker(task, {
      command: 'node',
      walkerPath: '__dummy__',  // ignored because we set extraArgs
      extraArgs: ['-e', 'process.exit(0)'],
      timeoutMs: 10_000,
      cwd: TEST_CWD,
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('propagates non-zero exit codes', async () => {
    const task = makeTask('private-walker-x')
    const result = await runWalker(task, {
      command: 'node',
      walkerPath: '__dummy__',
      extraArgs: ['-e', 'process.exit(7)'],
      timeoutMs: 10_000,
      cwd: TEST_CWD,
    })
    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
  })

  it('SIGTERMs the child after timeoutMs and reports timedOut=true', async () => {
    const task = makeTask('private-walker-x')
    const result = await runWalker(task, {
      command: 'node',
      walkerPath: '__dummy__',
      // Sleep forever; timeout should kick in.
      extraArgs: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 500,
      cwd: TEST_CWD,
    })
    expect(result.timedOut).toBe(true)
    // SIGTERM exit on Windows surfaces as null signal → 1, on POSIX as 143.
    // Either is acceptable; just confirm non-zero.
    expect(result.exitCode).not.toBe(0)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500)
  }, 15_000)

  it('does not throw on spawn errors (resolves with non-zero exit)', async () => {
    const task = makeTask('private-walker-x')
    const result = await runWalker(task, {
      command: '__nonexistent_command_xyz__',
      walkerPath: '__dummy__',
      timeoutMs: 5_000,
      cwd: TEST_CWD,
    })
    expect(result.exitCode).not.toBe(0)
  })
})
