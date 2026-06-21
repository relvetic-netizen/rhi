import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTeam, readTeam, cloneMember } from '../team.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-clone__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-clone')

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
    { name: 'impl-v1', role: 'implementer', prompt: 'original', model: 'sonnet' },
  ], 'test')
})

describe('cloneMember', () => {
  it('copies member and overrides specified fields', async () => {
    const result = await cloneMember(TEST_TEAM, 'impl-v1', 'impl-v2', {
      prompt: 'variant B',
      model: 'opus',
    })
    assert.equal(result.ok, true)
    assert.equal(result.member.name, 'impl-v2')
    assert.equal(result.member.role, 'implementer', 'role should be inherited')
    assert.equal(result.member.prompt, 'variant B')
    assert.equal(result.member.model, 'opus')
    assert.equal(result.member.isActive, false)
  })

  it('persists the clone in the team config', async () => {
    await cloneMember(TEST_TEAM, 'impl-v1', 'impl-v2')
    const team = await readTeam(TEST_TEAM)
    assert.ok(team.members.find(m => m.name === 'impl-v2'))
  })

  it('fails when source does not exist', async () => {
    const result = await cloneMember(TEST_TEAM, 'no-such', 'x')
    assert.equal(result.ok, false)
    assert.match(result.error, /not found/)
  })

  it('fails when target name already exists', async () => {
    const result = await cloneMember(TEST_TEAM, 'impl-v1', 'impl-v1')
    assert.equal(result.ok, false)
    assert.match(result.error, /already exists/)
  })
})
