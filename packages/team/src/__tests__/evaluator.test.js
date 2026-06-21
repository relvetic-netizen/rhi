import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluateTask, runEvaluatedTask } from '../evaluator.js'
import { createTeam } from '../team.js'
import { createTask, completeTask, getTask, appendEvaluation } from '../tasks.js'
import { readMailbox } from '../mailbox.js'
import { sendReply } from '../requests.js'
import { readKnowledge } from '../memory.js'
import { _clearGuardrailCache } from '../guardrails.js'
import { getTeamDir } from '../paths.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-evaluator__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-evaluator')

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
    { name: 'judge', role: 'evaluator' },
  ], 'test')
})

describe('appendEvaluation', () => {
  it('appends evaluation entries in order', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'x' })
    await appendEvaluation(TEST_TEAM, task.id, { by: 'judge', text: 'first' })
    await appendEvaluation(TEST_TEAM, task.id, { by: 'judge', text: 'second', passed: true, score: 0.8 })
    const updated = await getTask(TEST_TEAM, task.id)
    assert.equal(updated.evaluations.length, 2)
    assert.equal(updated.evaluations[0].text, 'first')
    assert.equal(updated.evaluations[1].passed, true)
    assert.equal(updated.evaluations[1].score, 0.8)
  })

  it('returns null for unknown task', async () => {
    const result = await appendEvaluation(TEST_TEAM, '9999', { by: 'judge', text: 'x' })
    assert.equal(result, null)
  })
})

describe('evaluateTask', () => {
  it('records a judge verdict end-to-end', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'implement feature' })
    await completeTask(TEST_TEAM, task.id, { output: 'did it' })

    // Judge replies asynchronously with a structured verdict
    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const inbox = await readMailbox(TEST_TEAM, 'judge')
      const req = inbox.find(m => m.request_id)
      assert.ok(req, 'judge should have received a request')
      await sendReply({
        teamName: TEST_TEAM, from: 'judge', requestId: req.request_id,
        responseText: 'Looks solid.\n{ "passed": true, "score": 0.9 }',
      })
    }

    const [result] = await Promise.all([
      evaluateTask({
        teamName: TEST_TEAM, taskId: task.id, evaluator: 'judge',
        timeoutMs: 3000,
      }),
      replyLater(),
    ])

    assert.equal(result.ok, true)
    assert.equal(result.evaluation.by, 'judge')
    assert.equal(result.evaluation.passed, true)
    assert.equal(result.evaluation.score, 0.9)
    assert.match(result.evaluation.text, /Looks solid/)

    const updated = await getTask(TEST_TEAM, task.id)
    assert.equal(updated.evaluations.length, 1)
    assert.equal(updated.evaluations[0].passed, true)
  })

  it('times out when evaluator does not respond', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'x' })
    const result = await evaluateTask({
      teamName: TEST_TEAM, taskId: task.id, evaluator: 'judge',
      timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /did not reply/)
  })

  it('fails for unknown task', async () => {
    const result = await evaluateTask({
      teamName: TEST_TEAM, taskId: '9999', evaluator: 'judge',
      timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /task/)
  })

  it('fails for unknown evaluator', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'x' })
    const result = await evaluateTask({
      teamName: TEST_TEAM, taskId: task.id, evaluator: 'no-such',
      timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /not a team member/)
  })

  it('auto-promotes facts the judge flagged for team knowledge', async () => {
    const task = await createTask(TEST_TEAM, { subject: 'integrate X' })

    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const inbox = await readMailbox(TEST_TEAM, 'judge')
      const req = inbox.find(m => m.request_id)
      await sendReply({
        teamName: TEST_TEAM, from: 'judge', requestId: req.request_id,
        responseText: 'Looks good.\n' + JSON.stringify({
          passed: true,
          promote_to_knowledge: [
            { topic: 'integration', content: 'X requires async bootstrap', tags: ['infra'] },
          ],
        }),
      })
    }

    const [result] = await Promise.all([
      evaluateTask({
        teamName: TEST_TEAM, taskId: task.id, evaluator: 'judge', timeoutMs: 3000,
      }),
      replyLater(),
    ])

    assert.equal(result.ok, true)
    assert.equal(result.promoted.length, 1)

    const knowledge = await readKnowledge(TEST_TEAM)
    assert.equal(knowledge.length, 1)
    assert.equal(knowledge[0].topic, 'integration')
    assert.equal(knowledge[0].source_agent, 'judge')
  })
})

// Helper: respond to the next *unanswered* request_id in an agent's inbox.
// The inbox accumulates request lines across attempts (sendReply does not
// consume the original request), so we must skip request_ids we've already
// answered in this driver run.
const answered = new Set()
async function respondToNextRequest(agent, responseText, attempts = 100) {
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
    await new Promise(r => setTimeout(r, 30))
  }
  throw new Error(`no fresh request landed in ${agent}'s inbox`)
}

describe('runEvaluatedTask', () => {
  beforeEach(() => { answered.clear() })

  it('accepts on first attempt when judge passes', async () => {
    const driver = (async () => {
      await respondToNextRequest('worker', 'Here is the answer: 42')
      await respondToNextRequest('judge', 'Solid.\n{"passed": true, "score": 0.95}')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'What is the answer?',
      maxRevisions: 2, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.ok, true)
    assert.equal(result.accepted, true)
    assert.equal(result.attempts, 1)
    assert.match(result.result, /42/)
    assert.equal(result.history.length, 1)
    assert.equal(result.evaluation.passed, true)
    assert.equal(result.evaluation.score, 0.95)
  })

  it('revises once and accepts on the second attempt', async () => {
    const driver = (async () => {
      await respondToNextRequest('worker', 'first try, incomplete')
      await respondToNextRequest('judge', '{"passed": false, "score": 0.3, "feedback": "Add more detail."}')
      await respondToNextRequest('worker', 'second try, full detail')
      await respondToNextRequest('judge', '{"passed": true, "score": 0.9}')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'Explain X',
      maxRevisions: 2, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.accepted, true)
    assert.equal(result.attempts, 2)
    assert.equal(result.history.length, 2)
    assert.equal(result.history[0].evaluation.passed, false)
    assert.equal(result.history[1].evaluation.passed, true)
    assert.match(result.result, /second try/)
  })

  it('returns NOT ACCEPTED after max_revisions exhausted', async () => {
    const driver = (async () => {
      // 1 initial + 2 revisions = 3 worker turns, all rejected
      await respondToNextRequest('worker', 'attempt 1')
      await respondToNextRequest('judge', '{"passed": false, "feedback": "f1"}')
      await respondToNextRequest('worker', 'attempt 2')
      await respondToNextRequest('judge', '{"passed": false, "feedback": "f2"}')
      await respondToNextRequest('worker', 'attempt 3')
      await respondToNextRequest('judge', '{"passed": false, "feedback": "f3"}')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'Hard task',
      maxRevisions: 2, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.ok, true)
    assert.equal(result.accepted, false)
    assert.equal(result.attempts, 3)
    assert.match(result.reason, /max_revisions=2 exhausted/)
    assert.equal(result.history.length, 3)
  })

  it('rejects worker===evaluator', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'worker',
      prompt: 'x', timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /must be different/)
  })

  it('errors on unknown worker', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'nope', evaluator: 'judge',
      prompt: 'x', timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /worker "nope" not a team member/)
  })

  it('times out when worker does not respond', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'x', maxRevisions: 0, timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /worker "worker" did not reply/)
  })

  it('rejects negative maxRevisions before contacting the worker', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'x', maxRevisions: -1, timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /maxRevisions must be an integer in \[0, 10\]/)
  })

  it('rejects non-integer maxRevisions (e.g. 1.5)', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'x', maxRevisions: 1.5, timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /maxRevisions must be an integer/)
  })

  it('rejects maxRevisions above the hard cap', async () => {
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'x', maxRevisions: 11, timeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /maxRevisions must be an integer in \[0, 10\]/)
  })

  it('returns pending_approval immediately when worker request is held', async () => {
    // auto_require_approval rule that captures the worker request body.
    await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
    await writeFile(
      join(getTeamDir(TEST_TEAM), 'guardrails.json'),
      JSON.stringify({
        input: [{
          type: 'auto_require_approval',
          match: { mode: 'substring', patterns: ['HOLD-WORKER-REQUEST'] },
        }],
      })
    )
    _clearGuardrailCache(TEST_TEAM)

    const start = Date.now()
    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'please respond about HOLD-WORKER-REQUEST',
      maxRevisions: 2, timeoutMs: 5000,
    })
    const elapsed = Date.now() - start

    assert.equal(result.ok, false)
    assert.equal(result.pending_approval, true)
    assert.ok(result.pending_approval_id)
    assert.match(result.error, /worker held for approval/)
    assert.equal(result.history.length, 0, 'no attempt recorded')
    // Must not have polled the worker's timeout.
    assert.ok(elapsed < 1000, `held worker request must return fast (got ${elapsed}ms)`)
  })

  // -------------------------------------------------------------------------
  // Pattern A: schema-validated judge replies + 1-retry
  // Garbage / schema-non-conforming first response now triggers ONE re-prompt
  // before falling back to null. Backwards-compatible (existing tests that
  // send valid JSON on first response continue to work in 1 attempt).
  // -------------------------------------------------------------------------
  it('schema validation: garbage first response → retry returns valid JSON → ACCEPT', async () => {
    const driver = (async () => {
      await respondToNextRequest('worker', 'answer 1')
      // First evaluator response: free text, no JSON object — schema fails.
      await respondToNextRequest('judge', 'I think this looks fine but let me reconsider.')
      // Retry: valid schema response.
      await respondToNextRequest('judge', '{"passed": true, "score": 0.88}')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'Solve X',
      maxRevisions: 0, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.ok, true)
    assert.equal(result.accepted, true)
    assert.equal(result.attempts, 1, 'still ONE attempt — retry is part of the same eval step')
    assert.equal(result.evaluation.passed, true)
    assert.equal(result.evaluation.score, 0.88)
    assert.equal(result.evaluation.schema_failed, false)
  })

  it('schema validation: retry also fails → falls back to null with schema-fail marker', async () => {
    const driver = (async () => {
      await respondToNextRequest('worker', 'answer')
      await respondToNextRequest('judge', 'just rambling text')
      await respondToNextRequest('judge', 'more rambling, still no JSON')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'Solve Y',
      maxRevisions: 0, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.ok, true)
    // No verdict reached — fell back to null because validation failed twice.
    assert.equal(result.evaluation.passed, null)
    assert.equal(result.evaluation.score, null)
    assert.equal(result.evaluation.schema_failed, true)
    // Feedback is tagged so workers/orchestrators can distinguish from a
    // legitimate evaluator response containing free text.
    assert.match(result.evaluation.feedback, /\[schema-validation-failed\]/)
    // Without an explicit passed=true, the loop counts this as not-accepted.
    assert.equal(result.accepted, false)
  })

  it('schema validation: invalid type (passed=string) → retry → ACCEPT', async () => {
    const driver = (async () => {
      await respondToNextRequest('worker', 'answer')
      // passed is a string — schema requires boolean → fails.
      await respondToNextRequest('judge', '{"passed": "yes", "score": 0.9}')
      await respondToNextRequest('judge', '{"passed": true, "score": 0.9}')
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'task',
      maxRevisions: 0, timeoutMs: 3000,
    })
    await driver

    assert.equal(result.ok, true)
    assert.equal(result.accepted, true)
    assert.equal(result.evaluation.passed, true)
  })

  it('returns pending_approval when evaluator request is held after worker replies', async () => {
    // First, run a normal driver until the worker replies, then install a
    // rule that captures the evaluator-bound request.
    let installedRule = false
    const driver = (async () => {
      // Worker replies normally (its prompt has no trigger phrase).
      for (let i = 0; i < 100; i++) {
        const inbox = await readMailbox(TEST_TEAM, 'worker')
        const req = inbox.find(m => m.request_id)
        if (req) {
          await sendReply({
            teamName: TEST_TEAM, from: 'worker', requestId: req.request_id,
            responseText: 'worker answer with HOLD-EVAL-PHRASE inside',
          })
          break
        }
        await new Promise(r => setTimeout(r, 30))
      }
      // Now install rule so the evaluator-bound prompt (which embeds the
      // worker's answer with HOLD-EVAL-PHRASE) is held.
      await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
      await writeFile(
        join(getTeamDir(TEST_TEAM), 'guardrails.json'),
        JSON.stringify({
          input: [{
            type: 'auto_require_approval',
            match: { mode: 'substring', patterns: ['HOLD-EVAL-PHRASE'] },
          }],
        })
      )
      _clearGuardrailCache(TEST_TEAM)
      installedRule = true
    })()

    const result = await runEvaluatedTask({
      teamName: TEST_TEAM, worker: 'worker', evaluator: 'judge',
      prompt: 'innocent prompt',
      maxRevisions: 2, timeoutMs: 5000,
    })
    await driver

    assert.equal(installedRule, true)
    assert.equal(result.ok, false)
    assert.equal(result.pending_approval, true)
    assert.ok(result.pending_approval_id)
    assert.match(result.error, /evaluator held for approval/)
    // The worker's result is preserved on the held outcome so the caller
    // can still inspect what triggered the hold.
    assert.match(result.last_result || '', /HOLD-EVAL-PHRASE/)
  })
})
