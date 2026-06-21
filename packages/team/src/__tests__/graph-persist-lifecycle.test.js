import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { sendRequest, sendReply } from '../requests.js'
import { invoke } from '../cross-team.js'
import { getRequest as getGraphRequest, writeRequest } from '../graph-store.js'
import { CROSS_TEAM_GRACE_MS } from '../admission.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-graph-lifecycle__'
const CROSS_SRC = '__test-graph-cross-src__'
const TMP = join(process.cwd(), '.test-tmp-graph-lifecycle')
const origDir = process.env.CLAUDE_CONFIG_DIR

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
    { name: 'alice', role: 'caller' },
    { name: 'bob', role: 'worker' },
  ], 'graph lifecycle')
  await createTeam(CROSS_SRC, [{ name: 'requester', role: 'caller' }], 'cross source')
})

async function waitForRequest(teamName, agentName) {
  const deadline = Date.now() + 1000
  while (Date.now() < deadline) {
    const inbox = await readMailbox(teamName, agentName)
    const req = inbox.find(m => m.request_id)
    if (req) return req
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`request not delivered to ${agentName}`)
}

describe('graph persistence lifecycle', () => {
  it('records a pending request when sendRequest creates it', async () => {
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'inspect pending graph entry',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    const req = await waitForRequest(TEST_TEAM, 'bob')

    const entry = getGraphRequest(req.request_id)
    assert.ok(entry)
    assert.equal(entry.from, 'alice')
    assert.equal(entry.to, 'bob')
    assert.equal(entry.status, 'pending')

    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
      responseText: 'done',
    })
    await run
  })

  it('transitions graph entry to completed when a reply is received', async () => {
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'complete me',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    const req = await waitForRequest(TEST_TEAM, 'bob')

    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
      responseText: 'complete',
    })
    const result = await run
    assert.equal(result.replied, true)

    const entry = getGraphRequest(result.request_id)
    assert.ok(entry)
    assert.equal(entry.status, 'completed')
  })

  it('transitions graph entry to expired on timeout', async () => {
    const result = await sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'timeout me',
      timeoutMs: 100, pollIntervalMs: 25,
    })

    assert.equal(result.timed_out, true)
    const entry = getGraphRequest(result.request_id)
    assert.ok(entry)
    assert.equal(entry.status, 'expired')
    assert.equal(entry.evidence.reason, 'timeout')
  })

  it('records cross-team admission blocks as expired graph entries', async () => {
    const result = await invoke({
      sourceTeam: CROSS_SRC, sourceAgent: 'requester',
      targetTeam: '*', targetAgent: 'specialist',
      prompt: 'broadcast should be denied',
      timeoutMs: 100, pollIntervalMs: 25,
    })

    assert.equal(result.blocked, true)
    assert.equal(result.reason, 'cross_team_broadcast_denied')
    const entry = getGraphRequest(result.request_id)
    assert.ok(entry)
    assert.equal(entry.status, 'expired')
    assert.equal(entry.evidence.reason, 'cross_team_broadcast_denied')
  })
})

// W2-bugfix P1-a — the cross-team cycle gate (S3-D) must actually fire through
// the production invoke() path, not just when admission is called with values
// hand-fed by a unit test. Before the fix invoke() passed only source/target,
// so the in-flight chain was never reconstructed and a back-edge that closes a
// 2-cycle was admitted.
describe('cross-team cycle deny via invoke() (P1-a)', () => {
  const TEAM_A = '__test-xcycle-a__'
  const TEAM_B = '__test-xcycle-b__'

  beforeEach(async () => {
    await createTeam(TEAM_A, [{ name: 'alice', role: 'caller' }], 'team A')
    await createTeam(TEAM_B, [{ name: 'bob', role: 'caller' }], 'team B')
  })

  it('denies bob@B → alice@A while alice@A → bob@B is in flight', async () => {
    // First leg: alice@A invokes bob@B. It will block (bob never replies) and
    // time out, but stays pending in the graph for the window we need.
    const leg1 = invoke({
      sourceTeam: TEAM_A, sourceAgent: 'alice',
      targetTeam: TEAM_B, targetAgent: 'bob',
      prompt: 'forward leg',
      timeoutMs: 800, pollIntervalMs: 30,
    })
    await waitForRequest(TEAM_B, 'bob')

    // Back leg: bob@B invokes alice@A. The reconstructed chain now contains the
    // pending alice@A → bob@B edge, so this back-edge closes a 2-cycle.
    const leg2 = await invoke({
      sourceTeam: TEAM_B, sourceAgent: 'bob',
      targetTeam: TEAM_A, targetAgent: 'alice',
      prompt: 'back leg should be denied',
      timeoutMs: 200, pollIntervalMs: 30,
    })

    assert.equal(leg2.blocked, true, 'back-edge must be blocked')
    assert.equal(leg2.reason, 'cross_team_cycle')
    const entry = getGraphRequest(leg2.request_id)
    assert.ok(entry)
    assert.equal(entry.status, 'expired')
    assert.equal(entry.evidence.reason, 'cross_team_cycle')

    await leg1 // let the forward leg time out and clean up
  })
})

// W2-bugfix P1-a residual (S3-G): the 24h target-down fallback must actually
// fire for a long-pending request that is re-invoked. Before the fix invoke()
// always passed the brand-new `startedAt`, so the request looked fresh every
// time and the 24h deadline never elapsed. The fix inherits the original
// started_at from the oldest pending graph entry on the same from→to edge.
describe('cross-team 24h target-down fallback fires on re-invoke (P1-a / S3-G)', () => {
  const SG_A = '__test-sg-a__'
  const SG_B = '__test-sg-b__'

  beforeEach(async () => {
    await createTeam(SG_A, [{ name: 'alice', role: 'caller' }], 'team A')
    await createTeam(SG_B, [{ name: 'bob', role: 'worker' }], 'team B')
  })

  it('denies with cross_team_target_down_timeout when a >24h pending edge exists', async () => {
    // Seed a pending graph entry for alice@SG_A → bob@SG_B that was first issued
    // more than 24h ago. invoke() builds the same `agent@team` node keys, so the
    // re-invoke inherits this stale started_at instead of "now".
    const staleStart = Date.now() - (CROSS_TEAM_GRACE_MS + 60_000)
    writeRequest({
      from: `alice@${SG_A}`,
      to: `bob@${SG_B}`,
      request_id: 'xreq_stale_seed',
      started_at: staleStart,
      deadline_at: staleStart + 1000,
    })

    const result = await invoke({
      sourceTeam: SG_A, sourceAgent: 'alice',
      targetTeam: SG_B, targetAgent: 'bob',
      prompt: 're-invoke of long-pending request',
      timeoutMs: 200, pollIntervalMs: 30,
    })

    assert.equal(result.blocked, true, 'S3-G must fire for a >24h pending edge')
    assert.equal(result.reason, 'cross_team_target_down_timeout')
    const entry = getGraphRequest(result.request_id)
    assert.ok(entry)
    assert.equal(entry.status, 'expired')
    assert.equal(entry.evidence.reason, 'cross_team_target_down_timeout')
  })

  it('does NOT fire S3-G for a brand-new edge with no pending predecessor', async () => {
    // No seeded entry — a genuinely new request uses the current clock and is
    // not yet 24h old, so S3-G must not fire (it should time out normally).
    const result = await invoke({
      sourceTeam: SG_A, sourceAgent: 'alice',
      targetTeam: SG_B, targetAgent: 'bob',
      prompt: 'fresh request',
      timeoutMs: 150, pollIntervalMs: 30,
    })
    assert.equal(result.timed_out, true, 'fresh edge must time out, not S3-G deny')
    assert.notEqual(result.reason, 'cross_team_target_down_timeout')
  })
})
