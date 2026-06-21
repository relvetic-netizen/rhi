import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { performHandoff } from '../handoffs.js'
import { createTeam, readTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { createTask, getTask } from '../tasks.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-handoff__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-handoff')

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
    { name: 'alice', role: 'researcher' },
    { name: 'bob', role: 'implementer' },
  ], 'test team')
})

describe('performHandoff', () => {
  it('delivers a handoff envelope to the recipient', async () => {
    const result = await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'research done',
      payload: 'summary of findings',
    })
    assert.equal(result.delivered, true)

    const inbox = await readMailbox(TEST_TEAM, 'bob')
    assert.equal(inbox.length, 1)
    assert.match(inbox[0].text, /<handoff from="alice" reason="research done">/)
    assert.match(inbox[0].text, /summary of findings/)
    assert.match(inbox[0].summary, /handoff: research done/)
  })

  it('transfers task ownership when task_id is provided', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'implement X', owner: 'alice' })
    const result = await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'ready for impl',
      taskId: task.id,
    })
    assert.equal(result.delivered, true)
    const updated = await getTask(TEST_TEAM, task.id)
    assert.equal(updated.owner, 'bob')
    assert.equal(updated.status, 'in_progress')
    assert.equal(result.task.owner, 'bob')
  })

  it('flips activity flags on both agents', async () => {
    await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'ready',
    })
    const team = await readTeam(TEST_TEAM)
    const alice = team.members.find(m => m.name === 'alice')
    const bob = team.members.find(m => m.name === 'bob')
    assert.equal(alice.isActive, false)
    assert.equal(bob.isActive, true)
  })

  it('applies truncate filter to payload', async () => {
    const longPayload = 'x'.repeat(5000)
    await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'trim',
      payload: longPayload,
      inputFilter: { name: 'truncate', max_length: 100 },
    })
    const inbox = await readMailbox(TEST_TEAM, 'bob')
    assert.ok(inbox[0].text.length < 500)
    assert.match(inbox[0].text, /truncated by handoff filter/)
  })

  it('applies last_n_lines filter', async () => {
    const payload = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'tail',
      payload,
      inputFilter: { name: 'last_n_lines', n: 5 },
    })
    const inbox = await readMailbox(TEST_TEAM, 'bob')
    assert.match(inbox[0].text, /earlier lines omitted/)
    assert.match(inbox[0].text, /line 29/)
    assert.ok(!inbox[0].text.includes('line 0\n'))
  })

  it('applies remove_code_blocks filter', async () => {
    const payload = 'before\n```js\nconst x = 1\n```\nafter'
    await performHandoff({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      reason: 'strip code',
      payload,
      inputFilter: { name: 'remove_code_blocks' },
    })
    const inbox = await readMailbox(TEST_TEAM, 'bob')
    assert.match(inbox[0].text, /\[code block removed\]/)
    assert.ok(!inbox[0].text.includes('const x = 1'))
  })
})
