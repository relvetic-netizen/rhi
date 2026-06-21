import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runConsensusTask } from '../evaluator.js'
import { createTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { sendReply } from '../requests.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-consensus__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-consensus')

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
    { name: 'worker', role: 'impl' },
    { name: 'judge-a', role: 'evaluator' },
    { name: 'judge-b', role: 'evaluator' },
    { name: 'judge-c', role: 'evaluator' },
  ], 'test')
})

// Helper: wait for the next un-answered request_id in an agent's inbox and
// reply. Tracks answered IDs across the driver run so a single agent can
// answer multiple sequential turns.
function makeResponder() {
  const answered = new Set()
  return async function respondToNext(agent, responseText, attempts = 200) {
    for (let i = 0; i < attempts; i++) {
      const inbox = await readMailbox(TEST_TEAM, agent)
      const next = inbox.find(m => m.request_id && !answered.has(m.request_id))
      if (next) {
        answered.add(next.request_id)
        await sendReply({
          teamName: TEST_TEAM, from: agent, requestId: next.request_id,
          responseText,
        })
        return next.request_id
      }
      await new Promise(r => setTimeout(r, 20))
    }
    throw new Error(`no fresh request for ${agent}`)
  }
}

describe('runConsensusTask — input validation', () => {
  it('rejects evaluators array with < 2 members', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a'], prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /at least 2/)
  })

  it('rejects duplicate evaluators', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-a'], prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /distinct/)
  })

  it('rejects worker in evaluators', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'worker'], prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /worker cannot also be an evaluator/)
  })

  it('rejects unknown evaluator', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'nope'], prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /"nope" not a team member/)
  })

  it('rejects unknown worker', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'nope',
      evaluators: ['judge-a', 'judge-b'], prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /worker "nope"/)
  })

  it('rejects out-of-range quorum', async () => {
    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      quorum: 3, prompt: 'x', timeoutMs: 200,
    })
    assert.equal(r.ok, false)
    assert.match(r.error, /quorum must be an integer in \[1, 2\]/)
  })
})

describe('runConsensusTask — default-ACCEPT semantics', () => {
  it('ACCEPTs on first attempt when all evaluators pass', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      await respond('worker', 'answer-v1')
      await respond('judge-a', '{"passed": true, "score": 0.9}')
      await respond('judge-b', '{"passed": true, "score": 0.95}')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', timeoutMs: 3000, maxRevisions: 0,
    })
    await driver

    assert.equal(r.ok, true)
    assert.equal(r.accepted, true)
    assert.equal(r.attempts, 1)
    assert.equal(r.summary.accepts, 2)
    assert.equal(r.summary.refutes, 0)
    assert.equal(r.summary.abstains, 0)
    assert.equal(r.votes.length, 2)
  })

  it('REVISEs when one evaluator refutes, then ACCEPTs on retry', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      // Round 1
      await respond('worker', 'v1 — incomplete')
      await respond('judge-a', '{"passed": false, "feedback": "Missing edge case for empty input."}')
      await respond('judge-b', '{"passed": true, "score": 0.7}')
      // Round 2
      await respond('worker', 'v2 — with edge case')
      await respond('judge-a', '{"passed": true, "score": 0.9}')
      await respond('judge-b', '{"passed": true, "score": 0.95}')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', timeoutMs: 3000, maxRevisions: 2,
    })
    await driver

    assert.equal(r.accepted, true)
    assert.equal(r.attempts, 2)
    assert.equal(r.history.length, 2)
    assert.equal(r.history[0].accepted, false)
    assert.equal(r.history[0].summary.refutes, 1)
    assert.equal(r.history[1].accepted, true)
    assert.match(r.result, /v2/)
  })

  it('exhausts max_revisions when refute persists', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      for (let i = 0; i < 3; i++) {
        await respond('worker', `attempt ${i + 1}`)
        await respond('judge-a', '{"passed": false, "feedback": "still wrong"}')
        await respond('judge-b', '{"passed": true, "score": 0.7}')
      }
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'impossible', timeoutMs: 3000, maxRevisions: 2,
    })
    await driver

    assert.equal(r.accepted, false)
    assert.equal(r.attempts, 3)
    assert.match(r.reason, /max_revisions=2 exhausted/)
  })

  it('abstain (schema-fail twice) does NOT block ACCEPT under default-ACCEPT', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      await respond('worker', 'answer')
      // judge-a abstains by emitting garbage both times.
      await respond('judge-a', 'just rambling, no JSON')
      await respond('judge-a', 'still rambling')
      // judge-b passes.
      await respond('judge-b', '{"passed": true, "score": 0.9}')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', timeoutMs: 3000, maxRevisions: 0,
    })
    await driver

    assert.equal(r.accepted, true, 'abstain + accept = ACCEPT under default semantics')
    assert.equal(r.summary.accepts, 1)
    assert.equal(r.summary.refutes, 0)
    assert.equal(r.summary.abstains, 1)
    const abstainVote = r.votes.find(v => v.evaluator === 'judge-a')
    assert.equal(abstainVote.schema_failed, true)
    assert.equal(abstainVote.passed, null)
  })

  it('all abstains → still ACCEPT under default-ACCEPT (no explicit refute)', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      await respond('worker', 'answer')
      await respond('judge-a', 'no json a1')
      await respond('judge-a', 'no json a2')
      await respond('judge-b', 'no json b1')
      await respond('judge-b', 'no json b2')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', timeoutMs: 3000, maxRevisions: 0,
    })
    await driver

    assert.equal(r.accepted, true)
    assert.equal(r.summary.abstains, 2)
    assert.equal(r.summary.refutes, 0)
  })
})

describe('runConsensusTask — quorum semantics (stricter than default)', () => {
  it('quorum=2 requires both votes positive; one abstain → NOT accepted', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      for (let round = 0; round < 1; round++) {
        await respond('worker', `answer round ${round}`)
        await respond('judge-a', 'no json — abstain')
        await respond('judge-a', 'still no json')
        await respond('judge-b', '{"passed": true, "score": 0.9}')
      }
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', quorum: 2, timeoutMs: 3000, maxRevisions: 0,
    })
    await driver

    assert.equal(r.accepted, false, 'quorum=2 not reached (only 1 explicit accept)')
    assert.equal(r.summary.accepts, 1)
    assert.equal(r.summary.abstains, 1)
  })

  it('quorum=1 ACCEPTs as soon as one evaluator passes (even with one refute)', async () => {
    const respond = makeResponder()
    const driver = (async () => {
      await respond('worker', 'answer')
      await respond('judge-a', '{"passed": false, "feedback": "I disagree"}')
      await respond('judge-b', '{"passed": true, "score": 0.9}')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', quorum: 1, timeoutMs: 3000, maxRevisions: 0,
    })
    await driver

    assert.equal(r.accepted, true, 'quorum=1 reached despite one refute')
    assert.equal(r.summary.accepts, 1)
    assert.equal(r.summary.refutes, 1)
  })
})

describe('runConsensusTask — feedback dedup + revision prompt', () => {
  it('dedups identical feedback strings across evaluators', async () => {
    const respond = makeResponder()
    const sameFeedback = 'Add error handling for null input — currently throws.'

    // Capture the worker's second-turn prompt as we reply to it.
    let secondWorkerPrompt = null

    // Custom responder that captures the prompt text on the SECOND worker turn.
    let workerTurn = 0
    const workerAnswered = new Set()
    async function respondWorker(responseText) {
      let req
      for (let i = 0; i < 200 && !req; i++) {
        const inbox = await readMailbox(TEST_TEAM, 'worker')
        req = inbox.find(m => m.request_id && !workerAnswered.has(m.request_id))
        if (!req) await new Promise(r => setTimeout(r, 20))
      }
      if (!req) throw new Error('no fresh worker request')
      workerAnswered.add(req.request_id)
      workerTurn++
      if (workerTurn === 2) secondWorkerPrompt = req.text || ''
      await sendReply({
        teamName: TEST_TEAM, from: 'worker', requestId: req.request_id,
        responseText,
      })
    }

    const driver = (async () => {
      // Round 1
      await respondWorker('v1')
      await respond('judge-a', `{"passed": false, "feedback": "${sameFeedback}"}`)
      await respond('judge-b', `{"passed": false, "feedback": "${sameFeedback}"}`)
      // Round 2
      await respondWorker('v2')
      await respond('judge-a', '{"passed": true, "score": 0.9}')
      await respond('judge-b', '{"passed": true, "score": 0.9}')
    })()

    const r = await runConsensusTask({
      teamName: TEST_TEAM, worker: 'worker',
      evaluators: ['judge-a', 'judge-b'],
      prompt: 'solve', timeoutMs: 5000, maxRevisions: 2,
    })
    await driver

    assert.equal(r.accepted, true)
    assert.ok(secondWorkerPrompt, 'should have captured the revision prompt')
    // Identical feedback should appear ONCE in the revision prompt, not twice.
    const occurrences = (secondWorkerPrompt.match(/Add error handling for null input/g) || []).length
    assert.equal(occurrences, 1, `deduped feedback should appear once in revision prompt (got ${occurrences})`)
  })
})
