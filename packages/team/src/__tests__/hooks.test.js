import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fireHook, _resetHooks } from '../hooks.js'

const TMP = join(process.cwd(), '.test-tmp-hooks')
const HOOKS_FILE = join(TMP, 'swarm-hooks.mjs')

const origEnv = process.env.CLAUDE_SWARM_HOOKS_FILE

before(() => {
  process.env.CLAUDE_SWARM_HOOKS_FILE = HOOKS_FILE
})
after(async () => {
  if (origEnv) process.env.CLAUDE_SWARM_HOOKS_FILE = origEnv
  else delete process.env.CLAUDE_SWARM_HOOKS_FILE
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  _resetHooks()
})

describe('fireHook', () => {
  it('does nothing when no hooks file exists', async () => {
    await fireHook('before_tool', { tool: 'x', args: {} })
    // should not throw
  })

  it('invokes registered hook', async () => {
    await mkdir(TMP, { recursive: true })
    const sentinelPath = join(TMP, 'sentinel.txt')
    await writeFile(HOOKS_FILE, `
      import { writeFile } from 'node:fs/promises'
      export async function before_tool({ tool }) {
        await writeFile(${JSON.stringify(sentinelPath)}, tool)
      }
    `)
    await fireHook('before_tool', { tool: 'team_send_message', args: {} })

    const { readFile } = await import('node:fs/promises')
    const content = await readFile(sentinelPath, 'utf-8')
    assert.equal(content, 'team_send_message')
  })

  it('swallows hook errors without throwing', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(HOOKS_FILE, `
      export async function before_tool() {
        throw new Error('hook failure')
      }
    `)
    // Should not throw
    await fireHook('before_tool', { tool: 'x', args: {} })
  })

  it('ignores unknown events', async () => {
    await mkdir(TMP, { recursive: true })
    await writeFile(HOOKS_FILE, `export async function before_tool() {}`)
    await fireHook('nonexistent_event', {})
  })
})
