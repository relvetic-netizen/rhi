// S3b-D — sync request cycle deny. The in-flight team_request graph is
// purely in-memory in Wave 1 (handoff DON'T 32). When recording an edge
// would close a cycle (B awaiting A while A awaits B), sendRequest returns
// SYNC_CYCLE_DENIED + recommend team_request_async.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  sendRequest, sendReply,
  _peekInFlightGraph, _clearInFlightGraph, _detectCycle,
} from '../requests.js'
import { createTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-cycle-deny__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-cycle-deny')

// sendRequest records the in-flight edge only AFTER two file-locked persistence
// writes (registerRequest → pending-requests.json, persistGraphRequest →
// team-graph.json). On a loaded machine those writes can outlast a fixed sleep,
// so polling for the edges — instead of guessing a delay — keeps these timing
// assertions deterministic. The poll deadline is generous; in practice the
// edges appear within a few ms.
//
// `edges` is a list of [from, to] pairs that must all be present in the
// in-flight graph (namespaced per team) before the caller asserts on cycle
// state. Returns true once every edge is recorded, false on deadline.
async function waitForEdges(teamName, edges, deadlineMs = 2000) {
  const has = (peek, from, to) => {
    const adj = peek.get(`${teamName}:${from}`)
    return !!adj && adj.has(`${teamName}:${to}`)
  }
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const peek = _peekInFlightGraph()
    if (edges.every(([from, to]) => has(peek, from, to))) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return false
}

// Poll a recipient's inbox until a request message arrives, then return it.
// writeToMailbox runs after sendRequest's two persistence writes, so a fixed
// sleep can fire before delivery lands; polling removes that timing guess.
async function waitForRequest(teamName, agent, deadlineMs = 2000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const inbox = await readMailbox(teamName, agent)
    const req = inbox.find(m => m.request_id)
    if (req) return req
    await new Promise(r => setTimeout(r, 10))
  }
  return null
}

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
  _clearInFlightGraph()
  await createTeam(TEST_TEAM, [
    { name: 'alice', role: 'worker' },
    { name: 'bob', role: 'worker' },
    { name: 'carol', role: 'worker' },
  ], 'test')
})
afterEach(() => {
  _clearInFlightGraph()
})

describe('_detectCycle (graph primitive)', () => {
  it('returns false on empty graph', () => {
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'a', to: 'b' }), false)
  })

  it('detects 2-cycle (a→b then b→a)', async () => {
    // Simulate alice awaiting bob, then bob tries to await alice.
    // We can't actually invoke sendRequest synchronously from both sides
    // here, so we exercise the primitive directly via timed_out path.
    const t = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q', timeoutMs: 200, pollIntervalMs: 30,
    })
    // While alice's request is in flight, bob→alice would close the loop.
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'alice→bob edge must be recorded')
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'alice' }), true)
    await t // let the timed_out path clean up
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'alice' }), false)
  })

  it('detects 3-cycle (a→b, b→c, c→a)', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 200, pollIntervalMs: 30,
    })
    const t2 = sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'carol',
      prompt: 'q2', timeoutMs: 200, pollIntervalMs: 30,
    })
    assert.ok(
      await waitForEdges(TEST_TEAM, [['alice', 'bob'], ['bob', 'carol']]),
      'alice→bob and bob→carol edges must be recorded',
    )
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'carol', to: 'alice' }), true)
    await Promise.all([t1, t2])
  })

  it('does not flag straight-line chain as a cycle', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 200, pollIntervalMs: 30,
    })
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'alice→bob edge must be recorded')
    // bob→carol is a forward chain, not a cycle.
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'carol' }), false)
    await t1
  })

  it('does not flag self-edge as cycle on empty graph', () => {
    // a→a on empty graph: graphHasPath(a, a) is false because start===target
    // and we explicitly require start !== target before BFS. Verify behavior.
    assert.equal(_detectCycle({ teamName: TEST_TEAM, from: 'a', to: 'a' }), false)
  })
})

describe('sendRequest cycle deny', () => {
  it('returns SYNC_CYCLE_DENIED with recommend=team_request_async', async () => {
    // alice→bob is in flight (will time out)
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 300, pollIntervalMs: 30,
    })
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'alice→bob edge must be recorded')
    // bob attempts to send back to alice — must be denied.
    const result = await sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'alice',
      prompt: 'q2', timeoutMs: 100, pollIntervalMs: 30,
    })
    assert.equal(result.error, 'SYNC_CYCLE_DENIED')
    assert.equal(result.recommend, 'team_request_async')
    assert.equal(result.replied, false)
    assert.equal(result.request_id, null)
    assert.match(result.reason, /cycle/)
    await t1 // wait for first to timeout
  })

  it('non-cycle pair is allowed', async () => {
    const replyLater = async () => {
      const req = await waitForRequest(TEST_TEAM, 'bob')
      assert.ok(req, 'bob should receive the request')
      await sendReply({
        teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
        responseText: 'ok',
      })
    }
    const [r] = await Promise.all([
      sendRequest({
        teamName: TEST_TEAM, from: 'alice', to: 'bob',
        prompt: 'q', timeoutMs: 1000, pollIntervalMs: 30,
      }),
      replyLater(),
    ])
    assert.equal(r.replied, true)
  })

  it('graph clears after reply (subsequent caller succeeds)', async () => {
    const replyLater = async () => {
      const req = await waitForRequest(TEST_TEAM, 'bob')
      assert.ok(req, 'bob should receive the request')
      await sendReply({
        teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
        responseText: 'ok',
      })
    }
    await Promise.all([
      sendRequest({
        teamName: TEST_TEAM, from: 'alice', to: 'bob',
        prompt: 'q1', timeoutMs: 500, pollIntervalMs: 30,
      }),
      replyLater(),
    ])
    // Now graph is empty; bob → alice must succeed (no cycle).
    const replyLater2 = async () => {
      const req = await waitForRequest(TEST_TEAM, 'alice')
      assert.ok(req, 'alice should receive the request')
      await sendReply({
        teamName: TEST_TEAM, from: 'alice', requestId: req.request_id,
        responseText: 'pong',
      })
    }
    const [r2] = await Promise.all([
      sendRequest({
        teamName: TEST_TEAM, from: 'bob', to: 'alice',
        prompt: 'q2', timeoutMs: 500, pollIntervalMs: 30,
      }),
      replyLater2(),
    ])
    assert.equal(r2.replied, true)
  })

  it('graph clears on timeout', async () => {
    const r = await sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q', timeoutMs: 100, pollIntervalMs: 20,
    })
    assert.equal(r.timed_out, true)
    const peek = _peekInFlightGraph()
    assert.equal(peek.size, 0, 'graph should be empty after timeout')
  })

  it('multiple non-cyclic edges from same `from` coexist', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 200, pollIntervalMs: 30,
    })
    const t2 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'carol',
      prompt: 'q2', timeoutMs: 200, pollIntervalMs: 30,
    })
    assert.ok(
      await waitForEdges(TEST_TEAM, [['alice', 'bob'], ['alice', 'carol']]),
      'both alice→bob and alice→carol edges must be recorded',
    )
    const peek = _peekInFlightGraph()
    // Nodes are namespaced by team (W2-bugfix P1-b): `${team}:${agent}`.
    const aliceTargets = peek.get(`${TEST_TEAM}:alice`)
    assert.ok(aliceTargets)
    assert.ok(aliceTargets.has(`${TEST_TEAM}:bob`))
    assert.ok(aliceTargets.has(`${TEST_TEAM}:carol`))
    await Promise.all([t1, t2])
  })

  it('detects 3-step cycle in sendRequest layer (alice→bob, bob→carol, carol→alice denied)', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 300, pollIntervalMs: 30,
    })
    const t2 = sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'carol',
      prompt: 'q2', timeoutMs: 300, pollIntervalMs: 30,
    })
    assert.ok(
      await waitForEdges(TEST_TEAM, [['alice', 'bob'], ['bob', 'carol']]),
      'alice→bob and bob→carol edges must be recorded',
    )
    const r3 = await sendRequest({
      teamName: TEST_TEAM, from: 'carol', to: 'alice',
      prompt: 'q3', timeoutMs: 100, pollIntervalMs: 30,
    })
    assert.equal(r3.error, 'SYNC_CYCLE_DENIED')
    await Promise.all([t1, t2])
  })

  it('cycle deny does NOT touch pending-requests registry', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 200, pollIntervalMs: 30,
    })
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'alice→bob edge must be recorded')
    const r = await sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'alice',
      prompt: 'q2', timeoutMs: 50, pollIntervalMs: 20,
    })
    assert.equal(r.error, 'SYNC_CYCLE_DENIED')
    assert.equal(r.request_id, null, 'no request_id should be allocated for denied cycle')
    await t1
  })

  it('cycle denial returns synchronously (no polling)', async () => {
    const t1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'q1', timeoutMs: 300, pollIntervalMs: 30,
    })
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'alice→bob edge must be recorded')
    const before = Date.now()
    const r = await sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'alice',
      prompt: 'q2', timeoutMs: 5000, pollIntervalMs: 30,
    })
    const elapsed = Date.now() - before
    assert.equal(r.error, 'SYNC_CYCLE_DENIED')
    assert.ok(elapsed < 300, `cycle deny should be fast (was ${elapsed}ms)`)
    await t1
  })

  it('concurrent reverse requests: exactly one denied (TOCTOU race)', async () => {
    // Regression for the detect→(await)→record TOCTOU. Before the fix,
    // recordInFlight ran only AFTER registerRequest / persistGraphRequest
    // awaited, so firing alice→bob and bob→alice with no await between them let
    // BOTH pass the empty-graph cycle check, BOTH go in-flight, and BOTH time
    // out — the cycle deny silently failed under concurrency (Codex repro:
    // { ab:{timed_out:true}, ba:{timed_out:true} }).
    //
    // Fire both with NO await in between (build the Promises, then Promise.all)
    // so they interleave the way two MCP calls landing on the same daemon do.
    // The fix records the edge synchronously before the first await, so the
    // second caller's synchronous _detectCycle sees the first edge and exactly
    // one request is denied. State-driven assertions (no fixed sleeps), so the
    // test is deterministic regardless of file-lock / FS latency.
    const pAB = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'ab', timeoutMs: 150, pollIntervalMs: 20,
    })
    const pBA = sendRequest({
      teamName: TEST_TEAM, from: 'bob', to: 'alice',
      prompt: 'ba', timeoutMs: 150, pollIntervalMs: 20,
    })
    const [ab, ba] = await Promise.all([pAB, pBA])

    const denied = [ab, ba].filter(r => r.error === 'SYNC_CYCLE_DENIED')
    const proceeded = [ab, ba].filter(r => r.error !== 'SYNC_CYCLE_DENIED')
    // The core invariant the bug violated: under concurrency it must NOT be the
    // case that both reverse requests go in-flight. Exactly one is denied.
    assert.equal(
      denied.length, 1,
      `exactly one reverse request must be denied, got ab=${JSON.stringify(ab)}, ba=${JSON.stringify(ba)}`,
    )
    assert.equal(proceeded.length, 1, 'exactly one must proceed')
    // The denied one allocates no request_id and recommends the async variant.
    assert.equal(denied[0].request_id, null)
    assert.equal(denied[0].recommend, 'team_request_async')
    // The survivor actually went in-flight; with no reply it reaches the timeout
    // terminal state, proving it was NOT also denied.
    assert.equal(proceeded[0].timed_out, true, 'survivor must have gone in-flight and timed out')

    // No phantom edge survives once both requests settle (rollback + clear).
    const peek = _peekInFlightGraph()
    assert.equal(peek.size, 0, 'graph must be empty after both requests settle')
  })

  it('peek graph snapshot is immutable from the outside', () => {
    _clearInFlightGraph()
    const peek = _peekInFlightGraph()
    peek.set('alice', new Set(['bob']))
    // Inspecting again shows internal state unaffected.
    const peek2 = _peekInFlightGraph()
    assert.equal(peek2.size, 0)
  })
})

// W2-bugfix P1-b — the in-flight graph must namespace nodes per team and
// refcount edges per request_id. Before the fix these two scenarios produced
// wrong answers: a same-named edge in another team caused a false cycle deny,
// and a single completing request cleared the edge for a still-in-flight
// duplicate (re-opening the reverse direction).
describe('cycle deny — per-team + refcount (P1-b)', () => {
  const OTHER_TEAM = '__test-cycle-deny-other__'

  beforeEach(async () => {
    _clearInFlightGraph()
    await createTeam(OTHER_TEAM, [
      { name: 'alice', role: 'worker' },
      { name: 'bob', role: 'worker' },
    ], 'other team, same agent names')
  })
  afterEach(() => {
    _clearInFlightGraph()
  })

  it('does NOT falsely deny a same-named edge in a different team', async () => {
    // team-X: alice→bob in flight. A daemon-global graph would key both teams'
    // alice/bob to the same nodes, so team-Y bob→alice would (wrongly) be
    // denied as a cycle. With per-team keys it must be allowed.
    const tX = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'qX', timeoutMs: 300, pollIntervalMs: 30,
    })
    // The team-X edge must be live before we exercise team-Y, otherwise the
    // cross-team isolation assertion is vacuous (no edge to falsely match).
    assert.ok(await waitForEdges(TEST_TEAM, [['alice', 'bob']]), 'team-X alice→bob edge must be recorded')

    // Reply to the OTHER team's bob→alice so it completes (not times out).
    const replyOther = async () => {
      const req = await waitForRequest(OTHER_TEAM, 'alice')
      assert.ok(req, 'other-team alice should have received the request')
      await sendReply({
        teamName: OTHER_TEAM, from: 'alice', requestId: req.request_id,
        responseText: 'cross-team ok',
      })
    }
    const [rY] = await Promise.all([
      sendRequest({
        teamName: OTHER_TEAM, from: 'bob', to: 'alice',
        prompt: 'qY', timeoutMs: 1000, pollIntervalMs: 30,
      }),
      replyOther(),
    ])
    assert.notEqual(rY.error, 'SYNC_CYCLE_DENIED', 'different team must not be denied')
    assert.equal(rY.replied, true)
    await tX
  })

  it('keeps cycle deny after one of two duplicate in-flight requests completes', async () => {
    // Two concurrent alice→bob requests. A Set-collapsed edge would drop the
    // bob node the moment the FIRST request completes, even though the second
    // is still in flight — wrongly allowing bob→alice. Refcounting keeps the
    // edge until the last duplicate finishes.
    //
    // dup1 has a long timeout (it is the SURVIVOR — we never reply to it and
    // assert the edge before it times out). dup2 has a short timeout and is
    // the one we resolve. We resolve exactly ONE request by id, then assert
    // the edge still exists while dup1 is in flight.
    const dup1 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'dup1-survivor', timeoutMs: 2000, pollIntervalMs: 30,
    })
    const dup2 = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'dup2-resolved', timeoutMs: 2000, pollIntervalMs: 30,
    })

    // Wait until BOTH duplicate requests are delivered to bob.
    const deadline = Date.now() + 1000
    let reqs = []
    while (Date.now() < deadline) {
      reqs = (await readMailbox(TEST_TEAM, 'bob')).filter(m => m.request_id)
      if (reqs.length >= 2) break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(reqs.length, 2, 'both duplicate requests must be in flight')

    // Reply to exactly ONE of them (resolves that single request).
    const resolvedId = reqs[0].request_id
    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: resolvedId,
      responseText: 'one done',
    })

    // One duplicate has been resolved; the other is still in flight. The
    // alice→bob edge must persist (refcount > 0), so bob→alice is STILL a cycle.
    // Poll briefly to let the resolved request's poll loop observe its reply.
    const cycleDeadline = Date.now() + 500
    while (Date.now() < cycleDeadline) {
      // The resolved sendRequest clears its own request_id from the edge, but
      // the surviving duplicate keeps the edge alive.
      if (_detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'alice' })) break
      await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(
      _detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'alice' }),
      true,
      'edge must survive until the last duplicate request completes',
    )

    // Resolve the surviving duplicate too.
    const survivorId = reqs.find(r => r.request_id !== resolvedId).request_id
    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: survivorId,
      responseText: 'two done',
    })
    await Promise.all([dup1, dup2])

    // Both done → edge gone → bob→alice is allowed.
    assert.equal(
      _detectCycle({ teamName: TEST_TEAM, from: 'bob', to: 'alice' }),
      false,
      'edge must clear once the last duplicate finishes',
    )
  })
})
