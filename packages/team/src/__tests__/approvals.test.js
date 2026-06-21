import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { enqueueApproval, listApprovals, getApproval, decide } from '../approvals.js'
import { writeToMailbox, readMailbox } from '../mailbox.js'
import { createTeam } from '../team.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-approvals__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-approvals')

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

describe('enqueueApproval', () => {
  it('creates a pending record with auto id', async () => {
    const rec = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      kind: 'message', message: { from: 'alice', text: 'hi' },
    })
    assert.ok(rec.id.startsWith('ap_'))
    assert.equal(rec.status, 'pending')
    assert.equal(rec.from, 'alice')
    assert.equal(rec.to, 'bob')
  })

  it('lists pending approvals', async () => {
    await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'b', kind: 'message',
      message: { from: 'a', text: '1' },
    })
    await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'b', kind: 'message',
      message: { from: 'a', text: '2' },
    })
    const pending = await listApprovals(TEST_TEAM)
    assert.equal(pending.length, 2)
  })
})

describe('decide', () => {
  it('approves a pending record', async () => {
    const rec = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { from: 'alice', text: 'hi' },
    })
    const updated = await decide(TEST_TEAM, rec.id, 'approved', { approver: 'team-lead' })
    assert.equal(updated.status, 'approved')
    assert.equal(updated.approver, 'team-lead')
    assert.ok(updated.decidedAt)
  })

  it('rejects a pending record with reason', async () => {
    const rec = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { from: 'alice', text: 'hi' },
    })
    const updated = await decide(TEST_TEAM, rec.id, 'rejected', {
      approver: 'team-lead', reason: 'too vague',
    })
    assert.equal(updated.status, 'rejected')
    assert.equal(updated.reason, 'too vague')
  })

  it('does nothing on already-decided record', async () => {
    const rec = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { from: 'alice', text: 'hi' },
    })
    await decide(TEST_TEAM, rec.id, 'approved', { approver: 'team-lead' })
    const second = await decide(TEST_TEAM, rec.id, 'rejected', { approver: 'team-lead' })
    assert.equal(second, null)
    const current = await getApproval(TEST_TEAM, rec.id)
    assert.equal(current.status, 'approved')
  })
})

describe('writeToMailbox integration with requires_approval', () => {
  it('enqueues instead of delivering when requires_approval=true', async () => {
    const result = await writeToMailbox(TEST_TEAM, 'bob', {
      from: 'alice',
      text: 'sensitive op',
      requires_approval: true,
    })
    assert.ok(result.pending_approval_id)

    // Bob's inbox is empty
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    assert.equal(bobInbox.length, 0)

    // team-lead got a notice
    const leadInbox = await readMailbox(TEST_TEAM, 'team-lead')
    assert.equal(leadInbox.length, 1)
    assert.equal(leadInbox[0].from, 'approval-queue')
    assert.match(leadInbox[0].text, /Pending approval ap_/)

    // Approval queue has the pending entry
    const pending = await listApprovals(TEST_TEAM)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].message.text, 'sensitive op')
  })
})
