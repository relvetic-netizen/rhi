// W2-bugfix P1-c — graph persistence failure must NOT be silent. When
// writeRequest fails (lock contention, corrupt store, un-writable path), the
// request can still be delivered, but the caller would wrongly assume the
// request is durably tracked. recoverPendingOnRestart can only see persisted
// entries, so an un-persisted pending request silently disappears on a daemon
// restart. The fix surfaces a `graph_degraded` flag on the result instead of
// only logging a warning, while keeping the MCP server crash-free (R-W2-8).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTeam, readTeam } from '../team.js'
import { getTeamConfigPath } from '../paths.js'
import { readMailbox } from '../mailbox.js'
import { sendRequest, sendReply } from '../requests.js'
import { invoke, crossReply } from '../cross-team.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-graph-degraded__'
const CROSS_SRC = '__test-graph-degraded-src__'
const CROSS_TGT = '__test-graph-degraded-tgt__'
const TMP = join(process.cwd(), '.test-tmp-graph-degraded')
const origDir = process.env.CLAUDE_CONFIG_DIR
const origGraphPath = process.env.RELVETIA_TEAM_GRAPH_PATH

// A file used as a directory-parent forces mkdirSync (inside writeGraphAtomic)
// to throw EEXIST/ENOTDIR, deterministically failing the graph write without
// touching the mailbox store (which lives under CLAUDE_CONFIG_DIR).
const BLOCKER_FILE = join(TMP, 'graph-blocker')
const UNWRITABLE_GRAPH = join(BLOCKER_FILE, 'team-graph.json')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  if (origGraphPath) process.env.RELVETIA_TEAM_GRAPH_PATH = origGraphPath
  else delete process.env.RELVETIA_TEAM_GRAPH_PATH
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  // Recreate TMP and the blocker file so the graph path's parent is a file.
  await createTeam(TEST_TEAM, [
    { name: 'alice', role: 'caller' },
    { name: 'bob', role: 'worker' },
  ], 'graph degraded')
  await createTeam(CROSS_SRC, [{ name: 'requester', role: 'caller' }], 'src')
  await createTeam(CROSS_TGT, [{ name: 'specialist', role: 'worker' }], 'tgt')
  await writeFile(BLOCKER_FILE, 'not a directory')
  process.env.RELVETIA_TEAM_GRAPH_PATH = UNWRITABLE_GRAPH
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

describe('graph persistence failure is surfaced, not silent (P1-c)', () => {
  it('sendRequest delivers but flags graph_degraded when the graph write fails', async () => {
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'degraded path',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    // Despite the failed graph write, the request must still be delivered.
    const req = await waitForRequest(TEST_TEAM, 'bob')
    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
      responseText: 'ok',
    })
    const result = await run
    assert.equal(result.replied, true, 'request must still be delivered (no crash)')
    assert.equal(result.graph_degraded, true, 'caller must be told the request was not persisted')
    assert.ok(result.graph_degraded_reason, 'a reason must accompany the degraded flag')
  })

  it('cross-team invoke flags graph_degraded when the graph write fails', async () => {
    const run = invoke({
      sourceTeam: CROSS_SRC, sourceAgent: 'requester',
      targetTeam: CROSS_TGT, targetAgent: 'specialist',
      prompt: 'cross degraded path',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    const req = await waitForRequest(CROSS_TGT, 'specialist')
    await crossReply({
      sourceTeam: CROSS_SRC, sourceAgent: 'requester',
      requestId: req.request_id,
      fromTeam: CROSS_TGT, fromAgent: 'specialist',
      responseText: 'cross ok',
    })
    const result = await run
    assert.equal(result.replied, true)
    assert.equal(result.graph_degraded, true)
    assert.ok(result.graph_degraded_reason)
  })
})

// P1-c (re-review residual 1): the SAME degraded surfacing must apply to the
// status transition (updateRequestStatus), not just the initial writeRequest.
// When the request is persisted fine but the terminal completed/expired
// transition fails to persist, the graph entry is left `pending` and a daemon
// restart would mis-recover it. Previously this failure was swallowed with a
// bare console.warn. These tests isolate the status-persist failure: the graph
// is WRITABLE while the pending entry is created, then redirected to an
// un-writable path so only the terminal updateRequestStatus fails.
describe('graph STATUS persistence failure is surfaced, not silent (P1-c residual)', () => {
  // A second TMP-local blocker reused to make updateRequestStatus fail after
  // the pending entry has already been persisted to the writable graph.
  const STATUS_BLOCKER = join(TMP, 'status-blocker')
  const UNWRITABLE_STATUS_GRAPH = join(STATUS_BLOCKER, 'team-graph.json')

  // Override the beforeEach graph path so the INITIAL writeRequest succeeds.
  // (The outer beforeEach points RELVETIA_TEAM_GRAPH_PATH at the unwritable
  // path; here we re-point it at a writable one and drop the writeRequest
  // blocker that the outer hook installed.)
  async function useWritableGraph() {
    const writableGraph = join(TMP, 'writable-graph.json')
    process.env.RELVETIA_TEAM_GRAPH_PATH = writableGraph
    await writeFile(STATUS_BLOCKER, 'not a directory')
  }

  it('sendReply flags graph_degraded when the status transition fails to persist', async () => {
    await useWritableGraph()
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'status degraded path',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    const req = await waitForRequest(TEST_TEAM, 'bob')
    // Now break ONLY the status write: redirect the graph to an unwritable path
    // so the pending entry exists but updateRequestStatus cannot persist.
    process.env.RELVETIA_TEAM_GRAPH_PATH = UNWRITABLE_STATUS_GRAPH
    const replyResult = await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
      responseText: 'ok',
    })
    assert.equal(replyResult.delivered, true, 'reply must still be delivered')
    assert.equal(replyResult.graph_degraded, true, 'replier must be told the status was not persisted')
    assert.ok(replyResult.graph_degraded_reason)
    await run
  })

  it('sendRequest flags graph_degraded when the completed transition fails to persist', async () => {
    await useWritableGraph()
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'caller status degraded path',
      timeoutMs: 3000, pollIntervalMs: 50,
    })
    const req = await waitForRequest(TEST_TEAM, 'bob')
    // Reply lands in alice's inbox via the writable graph path. Then break the
    // graph so the caller's completed-transition persist fails.
    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
      responseText: 'ok',
    })
    process.env.RELVETIA_TEAM_GRAPH_PATH = UNWRITABLE_STATUS_GRAPH
    const result = await run
    assert.equal(result.replied, true)
    assert.equal(result.graph_degraded, true, 'caller must be told the completed status was not persisted')
    assert.ok(result.graph_degraded_reason)
  })
})

// P1-c (Codex final-round residual): the admission-deny / target-missing
// TERMINAL return paths in invoke() also persist an `expired` status and then
// return early. Before the fix those returns dropped the persistGraphStatus
// result, so a graph that cannot persist the terminal status was left pending
// while the caller received no `graph_degraded` marker. S3-B/S3-G denials flow
// through this same path, so recovery integrity required surfacing it here too.
describe('cross-team admission-deny terminal path surfaces graph_degraded (P1-c)', () => {
  // Mark the target team autonomous so a requires_approval invoke trips the
  // S3-B admission deny (cross_team_autonomous_hitl_denied), reaching the
  // terminal deny return without ever delivering the request.
  async function makeTargetAutonomous() {
    const cfgPath = getTeamConfigPath(CROSS_TGT)
    const cfg = await readTeam(CROSS_TGT)
    cfg.mode = 'autonomous'
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2))
  }

  it('admission-denied invoke flags graph_degraded when the expired status cannot persist', async () => {
    await makeTargetAutonomous()
    // The outer beforeEach already points the graph at an unwritable path, so
    // both the initial persistGraphRequest and the terminal persistGraphStatus
    // fail. The deny return must still carry the degraded marker.
    const result = await invoke({
      sourceTeam: CROSS_SRC, sourceAgent: 'requester',
      targetTeam: CROSS_TGT, targetAgent: 'specialist',
      prompt: 'denied-and-degraded',
      requiresApproval: true,
      timeoutMs: 1000, pollIntervalMs: 50,
    })
    assert.equal(result.blocked, true, 'S3-B must deny the autonomous HITL invoke')
    assert.equal(result.reason, 'cross_team_autonomous_hitl_denied')
    assert.equal(result.graph_degraded, true, 'denied caller must learn the graph entry was not persisted')
    assert.ok(result.graph_degraded_reason, 'a reason must accompany the degraded flag')
  })
})

// P1-c (Codex final-round residual 2): the MCP tool handlers in src/index.js
// build the timeout reply via an EARLY return branch that previously ignored
// result.graph_degraded — so a timed-out request whose `expired` status also
// failed to persist showed the user a plain "timed out" with no degraded note,
// even though the completed-reply path did surface it. These source assertions
// pin the timeout branches to the same degraded-note display pattern. (The MCP
// handlers are not exported for direct invocation, so — consistent with the
// existing cross-team / admission-integration handler tests — we assert against
// the handler source block.)
describe('MCP timeout branches surface graph_degraded note (P1-c)', () => {
  it('team_request timeout branch references graph_degraded in its reply', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const start = src.indexOf("'team_request'")
    const end = src.indexOf("'team_request_async'")
    assert.ok(start > 0 && end > start, 'team_request handler block must be locatable')
    const block = src.slice(start, end)
    const timeoutIdx = block.indexOf('result.timed_out')
    assert.ok(timeoutIdx > 0, 'timeout branch must exist')
    // Bound the window to ONLY the timeout branch: from `result.timed_out` to
    // the end of that branch's return (anchored on the "timed out" reply text).
    // The next branch (completed-reply degradedNote) must NOT leak into the
    // window, otherwise the assertion would pass even if the timeout branch
    // dropped graph_degraded (the bug we are pinning).
    const timeoutEnd = block.indexOf('isError: true', block.indexOf('timed out after', timeoutIdx))
    assert.ok(timeoutEnd > timeoutIdx, 'timeout return must be locatable')
    const timeoutBlock = block.slice(timeoutIdx, timeoutEnd)
    assert.match(timeoutBlock, /graph_degraded/, 'timeout branch must surface graph_degraded')
  })

  it('team_invoke timeout branch references graph_degraded in its reply', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const start = src.indexOf("'team_invoke'")
    const end = src.indexOf("'team_cross_reply'")
    assert.ok(start > 0 && end > start, 'team_invoke handler block must be locatable')
    const block = src.slice(start, end)
    const timeoutIdx = block.indexOf('result.timed_out')
    assert.ok(timeoutIdx > 0, 'timeout branch must exist')
    const timeoutEnd = block.indexOf('isError: true', block.indexOf('invoke ${result.request_id} timed out', timeoutIdx))
    assert.ok(timeoutEnd > timeoutIdx, 'timeout return must be locatable')
    const timeoutBlock = block.slice(timeoutIdx, timeoutEnd)
    assert.match(timeoutBlock, /graph_degraded/, 'timeout branch must surface graph_degraded')
  })
})

// P1-c (master-port residual): the deny / error / pending-approval EARLY-RETURN
// handler branches return before the timeout/success notes, so they must also
// append the shared `degradedSuffix` (built from result.graph_degraded) — else a
// status-persist failure on a denied/held request is silent at the tool boundary.
// These source assertions fail before the fix (branches dropped the suffix).
describe('MCP deny/error/pending branches surface graph_degraded note (P1-c)', () => {
  it('team_invoke defines degradedSuffix from graph_degraded and applies it to error + blocked', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const start = src.indexOf("'team_invoke'")
    const end = src.indexOf("'team_cross_reply'")
    assert.ok(start > 0 && end > start, 'team_invoke handler block must be locatable')
    const block = src.slice(start, end)
    assert.match(block, /const degradedSuffix = result\.graph_degraded/, 'must build degradedSuffix from graph_degraded')
    const errIdx = block.indexOf('if (result.error)')
    const blkIdx = block.indexOf('if (result.blocked)')
    const toIdx = block.indexOf('if (result.timed_out)')
    assert.ok(errIdx > 0 && blkIdx > errIdx && toIdx > blkIdx, 'error/blocked/timeout branches in order')
    assert.match(block.slice(errIdx, blkIdx), /degradedSuffix/, 'error branch must append degradedSuffix')
    assert.match(block.slice(blkIdx, toIdx), /degradedSuffix/, 'blocked branch must append degradedSuffix')
  })

  it('team_request defines degradedSuffix and applies it to pending_approval + blocked', async () => {
    const src = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const start = src.indexOf("'team_request'")
    const end = src.indexOf("'team_request_async'")
    assert.ok(start > 0 && end > start, 'team_request handler block must be locatable')
    const block = src.slice(start, end)
    assert.match(block, /const degradedSuffix = result\.graph_degraded/, 'must build degradedSuffix from graph_degraded')
    const pendIdx = block.indexOf('if (result.pending_approval)')
    const blkIdx = block.indexOf('if (result.blocked)')
    const toIdx = block.indexOf('if (result.timed_out)')
    assert.ok(pendIdx > 0 && blkIdx > pendIdx && toIdx > blkIdx, 'pending/blocked/timeout branches in order')
    assert.match(block.slice(pendIdx, blkIdx), /degradedSuffix/, 'pending_approval branch must append degradedSuffix')
    assert.match(block.slice(blkIdx, toIdx), /degradedSuffix/, 'blocked branch must append degradedSuffix')
  })
})
