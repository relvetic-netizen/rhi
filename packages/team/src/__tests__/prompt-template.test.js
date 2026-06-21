import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { render, buildContext, renderForAgent } from '../prompt-template.js'
import { createTeam } from '../team.js'
import { writeToMailbox } from '../mailbox.js'
import { createTask } from '../tasks.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-template__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-template')

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
})

describe('render', () => {
  it('substitutes known variables', () => {
    const out = render('Hello {agent} of {team}', { agent: 'alice', team: 'x' })
    assert.equal(out, 'Hello alice of x')
  })

  it('leaves unknown variables unchanged', () => {
    const out = render('Hello {nobody}', { agent: 'a' })
    assert.equal(out, 'Hello {nobody}')
  })

  it('handles non-string input', () => {
    assert.equal(render('', {}), '')
    assert.equal(render(null, {}), '')
    assert.equal(render(undefined, {}), '')
  })
})

describe('buildContext', () => {
  it('returns minimal context when team does not exist', async () => {
    const ctx = await buildContext('no-such-team', 'alice')
    assert.equal(ctx.team, 'no-such-team')
    assert.equal(ctx.agent, 'alice')
  })

  it('counts unread messages and open tasks for the agent', async () => {
    await createTeam(TEST_TEAM, [{ name: 'alice', role: 'worker' }], 'test')
    await writeToMailbox(TEST_TEAM, 'alice', { from: 'team-lead', text: '1' })
    await writeToMailbox(TEST_TEAM, 'alice', { from: 'team-lead', text: '2' })
    await createTask(TEST_TEAM, { subject: 't1', owner: 'alice' })
    await createTask(TEST_TEAM, { subject: 't2', owner: 'alice' })
    await createTask(TEST_TEAM, { subject: 't3', owner: 'bob' })

    const ctx = await buildContext(TEST_TEAM, 'alice')
    assert.equal(ctx.agent, 'alice')
    assert.equal(ctx.role, 'worker')
    assert.equal(ctx.unread_count, 2)
    assert.equal(ctx.open_tasks, 2)
    assert.equal(ctx.total_tasks, 3)
    assert.equal(ctx.members, 'team-lead')
  })
})

describe('renderForAgent', () => {
  it('renders a template end-to-end', async () => {
    await createTeam(TEST_TEAM, [{ name: 'alice', role: 'worker' }], 'test')
    await writeToMailbox(TEST_TEAM, 'alice', { from: 'team-lead', text: 'x' })
    const out = await renderForAgent(
      'You are {agent}. You have {unread_count} unread.',
      TEST_TEAM,
      'alice'
    )
    assert.equal(out, 'You are alice. You have 1 unread.')
  })
})
