// Regression tests for bugs surfaced during Phase 5 code review.
// Each describe block corresponds to one HIGH- or MEDIUM-severity finding.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-bugfix__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-bugfix')

async function findBash() {
  const candidates = [
    process.env.BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    'bash',
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      if (candidate === 'bash') return candidate
    }
  }
  return 'bash'
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
beforeEach(async () => { await rm(TMP, { recursive: true, force: true }) })

// -------------------------------------------------------------------------
// Finding #5 (MEDIUM): extractJson greedy regex
// Before the fix, a judge reply containing an example JSON block followed by
// the actual verdict JSON would be matched greedily from the first '{' to the
// last '}', producing one malformed blob that JSON.parse rejected, so all
// structured fields were lost.
// -------------------------------------------------------------------------
describe('evaluator.extractJson — non-greedy, balanced-brace parsing', () => {
  it('parses the first valid JSON object even when followed by more braces (schema-fail triggers retry, retry recovers)', async () => {
    const { createTeam } = await import('../team.js')
    const { createTask, getTask } = await import('../tasks.js')
    const { evaluateTask } = await import('../evaluator.js')
    const { readMailbox } = await import('../mailbox.js')
    const { sendReply } = await import('../requests.js')
    await createTeam(TEST_TEAM, [{ name: 'judge', role: 'eval' }])
    const task = await createTask(TEST_TEAM, { subject: 'x' })

    // Judge reply contains an example block first, then the real verdict.
    // Greedy regex would span from first '{' to last '}' and fail JSON.parse;
    // the non-greedy balanced-brace parser correctly picks the FIRST balanced
    // object ({ example: true }). With schema validation that first object
    // fails — it has no `passed` — so the evaluator loop now fires a single
    // re-prompt. We drive that retry below.
    const replyText = [
      'Evaluating this task.',
      'Example shape:',
      '{ "example": true }',
      'My verdict:',
      '{ "passed": true, "score": 0.75 }',
      'Trailing commentary.',
    ].join('\n')

    // Answer two requests: the first with the misleading example (schema
    // validation will reject it), the second (the retry) with a clean verdict.
    const replyLater = async () => {
      const answered = new Set()
      for (let i = 0; i < 2; i++) {
        let req
        for (let t = 0; t < 100 && !req; t++) {
          await new Promise(r => setTimeout(r, 30))
          const inbox = await readMailbox(TEST_TEAM, 'judge')
          req = inbox.find(m => m.request_id && !answered.has(m.request_id))
        }
        assert.ok(req, `judge should receive request ${i + 1}`)
        answered.add(req.request_id)
        await sendReply({
          teamName: TEST_TEAM, from: 'judge', requestId: req.request_id,
          responseText: i === 0 ? replyText : '{"passed": true, "score": 0.75}',
        })
      }
    }

    const [result] = await Promise.all([
      evaluateTask({ teamName: TEST_TEAM, taskId: task.id, evaluator: 'judge', timeoutMs: 3000 }),
      replyLater(),
    ])

    assert.equal(result.ok, true)
    const t = await getTask(TEST_TEAM, task.id)
    assert.equal(t.evaluations.length, 1)
    // After retry, structured fields surface from the second response.
    assert.equal(t.evaluations[0].passed, true)
    assert.equal(t.evaluations[0].score, 0.75)
  })

  it('handles JSON with nested braces and strings containing braces', async () => {
    // We can't call extractJson directly (it's not exported), but we can
    // verify the behavior via evaluateTask end-to-end.
    const { createTeam } = await import('../team.js')
    const { createTask, getTask } = await import('../tasks.js')
    const { evaluateTask } = await import('../evaluator.js')
    const { readMailbox } = await import('../mailbox.js')
    const { sendReply } = await import('../requests.js')
    await createTeam(TEST_TEAM, [{ name: 'judge', role: 'eval' }])
    const task = await createTask(TEST_TEAM, { subject: 'x' })

    const replyText =
      'verdict: { "passed": true, "feedback": "looks {fine}", "nested": { "ok": 1 }, "score": 0.8 }'

    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const inbox = await readMailbox(TEST_TEAM, 'judge')
      const req = inbox.find(m => m.request_id)
      await sendReply({
        teamName: TEST_TEAM, from: 'judge', requestId: req.request_id, responseText: replyText,
      })
    }

    const [result] = await Promise.all([
      evaluateTask({ teamName: TEST_TEAM, taskId: task.id, evaluator: 'judge', timeoutMs: 3000 }),
      replyLater(),
    ])

    assert.equal(result.ok, true)
    const t = await getTask(TEST_TEAM, task.id)
    assert.equal(t.evaluations[0].passed, true)
    assert.equal(t.evaluations[0].score, 0.8)
  })
})

// -------------------------------------------------------------------------
// Finding #8 (MEDIUM): team.js used plain writeFile for config updates.
// Partial writes on crash would corrupt team config. Fix uses writeFileAtomic.
// We verify that no .tmp.<pid> files leak into the team directory after
// normal operations.
// -------------------------------------------------------------------------
describe('team.js — atomic writes leave no tmp files', () => {
  it('does not leave .tmp files after createTeam/updateMemberStatus/cloneMember', async () => {
    const { createTeam, updateMemberStatus, cloneMember } = await import('../team.js')
    const { readdir } = await import('node:fs/promises')
    const { getTeamDir } = await import('../paths.js')

    await createTeam(TEST_TEAM, [{ name: 'a' }], 'test')
    await updateMemberStatus(TEST_TEAM, 'a', true)
    await cloneMember(TEST_TEAM, 'a', 'b')

    const dir = getTeamDir(TEST_TEAM)
    const entries = await readdir(dir)
    const tmp = entries.filter(f => f.includes('.tmp.'))
    assert.deepEqual(tmp, [], `No .tmp leftovers expected, found: ${tmp.join(', ')}`)

    const configRaw = await readFile(join(dir, 'config.json'), 'utf-8')
    const config = JSON.parse(configRaw)
    assert.ok(config.members.find(m => m.name === 'b'))
  })
})

// -------------------------------------------------------------------------
// Finding #3 (HIGH): approvals.json grew unboundedly. Added pruneApprovals().
// -------------------------------------------------------------------------
describe('approvals.pruneApprovals — removes old decided records', () => {
  it('removes decided approvals older than cutoff but keeps pending ones', async () => {
    const { createTeam } = await import('../team.js')
    const { enqueueApproval, decide, pruneApprovals, listApprovals } = await import('../approvals.js')

    await createTeam(TEST_TEAM, [{ name: 'a' }], 'test')

    // Enqueue three; decide two (one approved, one rejected), leave one pending.
    const ap1 = await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'team-lead',
      kind: 'message', message: { from: 'a', text: 'old decided' },
    })
    const ap2 = await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'team-lead',
      kind: 'message', message: { from: 'a', text: 'old rejected' },
    })
    const ap3 = await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'team-lead',
      kind: 'message', message: { from: 'a', text: 'still pending' },
    })

    await decide(TEST_TEAM, ap1.id, 'approved', { approver: 'team-lead' })
    await decide(TEST_TEAM, ap2.id, 'rejected', { approver: 'team-lead', reason: 'x' })

    // Cutoff = 0ms means "prune anything decided, regardless of how old".
    const removed = await pruneApprovals(TEST_TEAM, 0)
    assert.equal(removed, 2)

    const all = await listApprovals(TEST_TEAM, { status: 'all' })
    assert.equal(all.length, 1)
    assert.equal(all[0].id, ap3.id)
    assert.equal(all[0].status, 'pending')
  })

  it('keeps everything within the retention window', async () => {
    const { createTeam } = await import('../team.js')
    const { enqueueApproval, decide, pruneApprovals, listApprovals } = await import('../approvals.js')

    await createTeam(TEST_TEAM, [{ name: 'a' }], 'test')
    const ap = await enqueueApproval({
      teamName: TEST_TEAM, from: 'a', to: 'team-lead',
      kind: 'message', message: { from: 'a', text: 'recent' },
    })
    await decide(TEST_TEAM, ap.id, 'approved', { approver: 'team-lead' })

    // 10-minute window — just-decided record should survive.
    const removed = await pruneApprovals(TEST_TEAM, 10 * 60 * 1000)
    assert.equal(removed, 0)
    const all = await listApprovals(TEST_TEAM, { status: 'all' })
    assert.equal(all.length, 1)
  })
})

// -------------------------------------------------------------------------
// Finding #4 (MEDIUM): guardrails.js recompiled regex on every message AND
// a malicious regex could ReDoS the server. Fix precompiles at load time,
// caches by mtime, and logs slow patterns.
// -------------------------------------------------------------------------
describe('guardrails — regex cache + safe regex handling', () => {
  it('caches compiled rules and rebuilds when guardrails.json changes', async () => {
    const { loadGuardrails, _clearGuardrailCache } = await import('../guardrails.js')
    const { getTeamDir } = await import('../paths.js')
    const dir = getTeamDir(TEST_TEAM)
    await mkdir(dir, { recursive: true })
    const cfgPath = join(dir, 'guardrails.json')

    _clearGuardrailCache(TEST_TEAM)
    await writeFile(cfgPath, JSON.stringify({
      input: [{ type: 'blocklist', patterns: ['secret'], mode: 'regex', action: 'block' }],
      output: [],
    }))
    const v1 = await loadGuardrails(TEST_TEAM)
    assert.equal(v1.input.length, 1)
    assert.ok(Array.isArray(v1.input[0]._compiled))
    assert.equal(v1.input[0]._compiled.length, 1)
    assert.equal(v1.input[0]._compiled[0].source, 'secret')

    // Same load should return the cached object (same reference).
    const v2 = await loadGuardrails(TEST_TEAM)
    assert.strictEqual(v1, v2)

    // Change the file; ensure mtime differs, then load sees fresh config.
    // Bump mtime by rewriting to avoid flakiness from nanosecond resolution.
    await new Promise(r => setTimeout(r, 10))
    await writeFile(cfgPath, JSON.stringify({
      input: [{ type: 'blocklist', patterns: ['password', 'token'], mode: 'substring', action: 'redact' }],
      output: [],
    }))
    const v3 = await loadGuardrails(TEST_TEAM)
    assert.notStrictEqual(v1, v3)
    assert.equal(v3.input[0].patterns.length, 2)
  })

  it('skips invalid regex patterns gracefully', async () => {
    const { loadGuardrails, _clearGuardrailCache } = await import('../guardrails.js')
    const { getTeamDir } = await import('../paths.js')
    const dir = getTeamDir(TEST_TEAM)
    await mkdir(dir, { recursive: true })
    _clearGuardrailCache(TEST_TEAM)
    await writeFile(join(dir, 'guardrails.json'), JSON.stringify({
      input: [{
        type: 'blocklist',
        patterns: ['good-pattern', '[unclosed-class'],
        mode: 'regex',
        action: 'block',
      }],
      output: [],
    }))
    const cfg = await loadGuardrails(TEST_TEAM)
    // Invalid regex is skipped; good one remains.
    assert.equal(cfg.input[0]._compiled.length, 1)
    assert.equal(cfg.input[0]._compiled[0].source, 'good-pattern')
  })
})
