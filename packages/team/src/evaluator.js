// Evaluator loop — inspired by OpenAI Agents SDK "LLM-as-judge" pattern.
// Sends a task's current state + result to a judge agent via the existing
// request/reply primitive and appends the verdict to the task.
//
// The judge's reply may be free text or a small JSON blob with fields like
// {score, passed, feedback}. We parse loosely — any JSON object found in the
// reply text is merged into the evaluation record.

import { getTask, appendEvaluation } from './tasks.js'
import { sendRequest } from './requests.js'
import { readTeam } from './team.js'
import { emitEvent } from './tracing.js'
import { errorMessage } from './errors.js'
import { promoteToKnowledge } from './memory.js'
import { validate as validateSchema } from './schema-validator.js'

const DEFAULT_TIMEOUT_MS = 60000

// Shape every judge response is expected to fit. Lenient on extras (no
// `additionalProperties` enforcement) but strict on the four fields the
// evaluator/consensus loops actually read. `feedback` is required so that
// when `passed=false` the worker gets actionable text (not the raw judge
// transcript via the silent-fail evalText fallback).
export const EVALUATOR_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['passed'],
  properties: {
    passed: { type: 'boolean' },
    score: { type: 'number' },
    feedback: { type: 'string' },
  },
}

function buildRetryPrompt(prevText) {
  return [
    'Your previous response did not match the required schema.',
    '',
    'Your previous response:',
    '---',
    prevText.slice(0, 2000),
    '---',
    '',
    'Re-emit a single JSON object with these fields:',
    '  passed:   boolean (true=ACCEPT, false=REVISE)   [required]',
    '  score:    number 0.0–1.0                         [optional]',
    '  feedback: string with concrete revisions         [optional, required when passed=false]',
    'Do not add commentary outside the JSON object.',
  ].join('\n')
}

/**
 * Validate a judge reply against EVALUATOR_RESPONSE_SCHEMA. On first failure,
 * fire ONE re-prompt to the same evaluator asking for a schema-conforming
 * response. Returns:
 *   { parsed, text, attempts, schemaErrors? }
 * `parsed` is the validated object on success, or `null` if both attempts
 * fail (caller decides null-fallback semantics).
 *
 * `text` is the FINAL raw response (used by callers that fall back to free
 * text for the evaluation record). `attempts` counts judge round-trips.
 */
async function fetchValidatedJudgeReply({
  teamName, from, evaluator, prompt, timeoutMs,
  retryPromptId = 'evaluator-schema-retry',
}) {
  const firstResp = await sendRequest({
    teamName, from, to: evaluator, prompt, timeoutMs,
  })
  if (firstResp.pending_approval || firstResp.blocked || firstResp.timed_out) {
    return { parsed: null, text: '', attempts: 1, transport: firstResp }
  }
  const firstText = firstResp.response?.text || ''
  const firstParsed = extractJson(firstText)
  if (firstParsed) {
    const v = validateSchema(EVALUATOR_RESPONSE_SCHEMA, firstParsed)
    if (v.valid) {
      return { parsed: firstParsed, text: firstText, attempts: 1, transport: firstResp }
    }
    await emitEvent('evaluator.schema_fail', {
      team_name: teamName, evaluator, retry_id: retryPromptId,
      errors: v.errors.slice(0, 5),
    })
  } else {
    await emitEvent('evaluator.schema_fail', {
      team_name: teamName, evaluator, retry_id: retryPromptId,
      errors: ['no JSON object in response'],
    })
  }

  // One re-prompt. We embed the previous response inline so the evaluator
  // (which polls its inbox and reacts to the new request_id) can see what
  // failed without relying on inbox-history context.
  const retryResp = await sendRequest({
    teamName, from, to: evaluator,
    prompt: buildRetryPrompt(firstText),
    timeoutMs,
  })
  if (retryResp.pending_approval || retryResp.blocked || retryResp.timed_out) {
    return { parsed: null, text: firstText, attempts: 2, transport: retryResp }
  }
  const retryText = retryResp.response?.text || ''
  const retryParsed = extractJson(retryText)
  if (retryParsed) {
    const v = validateSchema(EVALUATOR_RESPONSE_SCHEMA, retryParsed)
    if (v.valid) {
      return { parsed: retryParsed, text: retryText, attempts: 2, transport: retryResp }
    }
    await emitEvent('evaluator.schema_fail_final', {
      team_name: teamName, evaluator, retry_id: retryPromptId,
      errors: v.errors.slice(0, 5),
    })
  } else {
    await emitEvent('evaluator.schema_fail_final', {
      team_name: teamName, evaluator, retry_id: retryPromptId,
      errors: ['no JSON object in retry response'],
    })
  }
  return { parsed: null, text: retryText || firstText, attempts: 2, transport: retryResp }
}

function buildPrompt(task) {
  const lines = [
    `You are evaluating task #${task.id}.`,
    '',
    `Subject: ${task.subject}`,
    task.description ? `Description:\n${task.description}` : '',
    `Status: ${task.status}`,
    task.owner ? `Owner: ${task.owner}` : '',
    task.result !== null && task.result !== undefined
      ? `Result:\n${JSON.stringify(task.result, null, 2)}`
      : 'Result: (none)',
    '',
    'Respond with a short verdict. Optionally include a JSON block like',
    '{',
    '  "passed": true,',
    '  "score": 0.9,',
    '  "feedback": "...",',
    '  "promote_to_knowledge": [',
    '    { "topic": "auth", "content": "...", "tags": [...] }',
    '  ]',
    '}',
    'Items in promote_to_knowledge will be auto-recorded in team memory.',
  ]
  return lines.filter(l => l !== '').join('\n')
}

/**
 * Extract a JSON object from free text. Returns null if no valid JSON found.
 *
 * Strategy: starting from each `{`, scan forward tracking brace depth (with
 * string/escape awareness) to find a balanced closing `}`, then try JSON.parse.
 * First successful parse wins. This avoids the greedy-regex pitfall where
 * a judge reply containing example JSON + real JSON would be parsed as one
 * malformed blob.
 */
export function extractJson(text) {
  if (!text) return null
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    let escape = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (escape) { escape = false; continue }
      if (c === '\\' && inString) { escape = true; continue }
      if (c === '"') { inString = !inString; continue }
      if (inString) continue
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) {
          const candidate = text.slice(i, j + 1)
          try {
            const parsed = JSON.parse(candidate)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed
            }
          } catch { /* not valid JSON here, try next '{' */ }
          break
        }
      }
    }
  }
  return null
}

/**
 * Evaluate a task by sending its state to a judge agent and appending the
 * verdict. Returns { ok, evaluation?, error? }.
 */
export async function evaluateTask({
  teamName, taskId, evaluator, from = 'team-lead',
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const team = await readTeam(teamName)
  if (!team) return { ok: false, error: `team "${teamName}" not found` }

  const judge = team.members.find(m => m.name === evaluator)
  if (!judge) return { ok: false, error: `evaluator "${evaluator}" not a team member` }

  const task = await getTask(teamName, taskId)
  if (!task) return { ok: false, error: `task #${taskId} not found` }

  const prompt = buildPrompt(task)
  const validated = await fetchValidatedJudgeReply({
    teamName, from, evaluator, prompt, timeoutMs,
    retryPromptId: `evaluateTask:${taskId}`,
  })
  const transport = validated.transport
  if (transport.pending_approval) {
    return {
      ok: false,
      error: `request to evaluator held for approval (id=${transport.pending_approval_id}): ${transport.reason || 'auto_require_approval triggered'}`,
      pending_approval: true,
      pending_approval_id: transport.pending_approval_id,
    }
  }
  if (transport.blocked) {
    return { ok: false, error: `request blocked: ${transport.reason}` }
  }
  if (transport.timed_out) {
    return { ok: false, error: `evaluator "${evaluator}" did not reply within ${timeoutMs}ms` }
  }

  // After schema validation: parsed is the validated object or null. Fall back
  // to extractJson on the final text for `promote_to_knowledge` (the schema
  // doesn't enforce that field, so we still scrape it from the raw reply).
  const text = validated.text
  const parsed = validated.parsed || extractJson(text) || {}

  let entry
  try {
    entry = await appendEvaluation(teamName, taskId, {
      by: evaluator,
      text,
      score: typeof parsed.score === 'number' ? parsed.score : null,
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : null,
    })
  } catch (e) {
    return { ok: false, error: `failed to store evaluation: ${errorMessage(e)}` }
  }

  // Auto-promote any facts the judge flagged as team-wide knowledge.
  const promoted = []
  if (Array.isArray(parsed.promote_to_knowledge)) {
    for (const item of parsed.promote_to_knowledge) {
      if (!item || typeof item.content !== 'string') continue
      try {
        const kn = await promoteToKnowledge(teamName, {
          content: item.content,
          topic: typeof item.topic === 'string' ? item.topic : '',
          tags: Array.isArray(item.tags) ? item.tags : [],
          source_agent: evaluator,
        })
        promoted.push(kn.id)
      } catch (e) {
        console.error(`[evaluator] auto-promote failed: ${errorMessage(e)}`)
      }
    }
  }

  await emitEvent('evaluation.recorded', {
    team_name: teamName, task_id: taskId, evaluator,
    passed: entry?.passed, score: entry?.score,
    promoted_count: promoted.length,
  })

  return { ok: true, evaluation: entry, promoted }
}

// ---------------------------------------------------------------------------
// Evaluated-task loop — worker → evaluator → REVISE/ACCEPT
// ---------------------------------------------------------------------------

function buildEvaluatorPrompt(originalPrompt, workerResult, attempt) {
  return [
    `You are evaluating attempt #${attempt + 1} of a task.`,
    '',
    'Original request:',
    originalPrompt,
    '',
    'Worker\'s answer:',
    workerResult,
    '',
    'Respond with a JSON block:',
    '{',
    '  "passed": true | false,',
    '  "score": 0.0-1.0,',
    '  "feedback": "concrete, actionable revisions if not passed"',
    '}',
    '',
    'passed=true means ACCEPT (no further revisions). passed=false means REVISE — your feedback will be sent back to the worker for a retry.',
  ].join('\n')
}

function buildRevisionPrompt(originalPrompt, prevResult, feedback) {
  return [
    'Revise your previous answer based on the evaluator\'s feedback.',
    '',
    'Original request:',
    originalPrompt,
    '',
    'Your previous answer:',
    prevResult,
    '',
    'Evaluator feedback:',
    feedback,
    '',
    'Produce an improved answer that addresses the feedback.',
  ].join('\n')
}

/**
 * Run a worker → evaluator → REVISE/ACCEPT loop. The worker produces an
 * answer, the evaluator judges it, and if `passed=false` the loop sends the
 * feedback back to the worker for a revised attempt — up to `maxRevisions`
 * times.
 *
 * Each attempt uses the agents-as-tools `sendRequest` primitive (block until
 * reply or timeout), so this function is fully runtime-driven: no external
 * orchestrator needs to poll or schedule revisions.
 *
 * @param {object} args
 * @param {string} args.teamName
 * @param {string} args.worker        — agent that produces answers
 * @param {string} args.evaluator     — agent that judges and gives feedback
 * @param {string} args.prompt        — initial request to the worker
 * @param {string} [args.from='team-lead']
 * @param {number} [args.maxRevisions=2]   — extra retries after the first attempt
 * @param {number} [args.timeoutMs=60000]  — per-step request timeout
 * @returns {Promise<{
 *   ok: boolean,
 *   accepted?: boolean,
 *   attempts?: number,
 *   result?: string,
 *   evaluation?: { attempt, passed, score, feedback, raw },
 *   history?: Array<{ result, evaluation }>,
 *   error?: string,
 *   reason?: string,
 * }>}
 */
// Hard cap on revision retries. Beyond this the loop becomes a synchronous
// runaway through `sendRequest` and an external orchestrator (or human) is
// almost certainly the better fit. The MCP schema enforces the same upper
// bound; this defensive check guards direct (non-MCP) callers.
export const MAX_REVISIONS_CAP = 10

export async function runEvaluatedTask({
  teamName, worker, evaluator, prompt,
  from = 'team-lead',
  maxRevisions = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt is required' }
  }
  if (
    !Number.isInteger(maxRevisions) ||
    maxRevisions < 0 ||
    maxRevisions > MAX_REVISIONS_CAP
  ) {
    return {
      ok: false,
      error: `maxRevisions must be an integer in [0, ${MAX_REVISIONS_CAP}] (got ${maxRevisions})`,
    }
  }
  const team = await readTeam(teamName)
  if (!team) return { ok: false, error: `team "${teamName}" not found` }
  if (!team.members.find(m => m.name === worker)) {
    return { ok: false, error: `worker "${worker}" not a team member` }
  }
  if (!team.members.find(m => m.name === evaluator)) {
    return { ok: false, error: `evaluator "${evaluator}" not a team member` }
  }
  if (worker === evaluator) {
    return { ok: false, error: 'worker and evaluator must be different members' }
  }

  const history = []
  let currentPrompt = prompt
  let lastResult = null
  let lastEvaluation = null

  for (let attempt = 0; attempt <= maxRevisions; attempt++) {
    const workerResp = await sendRequest({
      teamName, from, to: worker, prompt: currentPrompt, timeoutMs,
    })
    if (workerResp.pending_approval) {
      return {
        ok: false,
        error: `request to worker held for approval (id=${workerResp.pending_approval_id}, attempt ${attempt + 1}): ${workerResp.reason || 'auto_require_approval triggered'}`,
        pending_approval: true,
        pending_approval_id: workerResp.pending_approval_id,
        history,
      }
    }
    if (workerResp.blocked) {
      return { ok: false, error: `request to worker blocked: ${workerResp.reason}`, history }
    }
    if (workerResp.timed_out) {
      return { ok: false, error: `worker "${worker}" did not reply within ${timeoutMs}ms (attempt ${attempt + 1})`, history }
    }
    lastResult = workerResp.response?.text || ''

    const validatedEval = await fetchValidatedJudgeReply({
      teamName, from, evaluator,
      prompt: buildEvaluatorPrompt(prompt, lastResult, attempt),
      timeoutMs,
      retryPromptId: `runEvaluatedTask:attempt-${attempt + 1}`,
    })
    const evalResp = validatedEval.transport
    if (evalResp.pending_approval) {
      return {
        ok: false,
        error: `request to evaluator held for approval (id=${evalResp.pending_approval_id}, attempt ${attempt + 1}): ${evalResp.reason || 'auto_require_approval triggered'}`,
        pending_approval: true,
        pending_approval_id: evalResp.pending_approval_id,
        history,
        last_result: lastResult,
      }
    }
    if (evalResp.blocked) {
      return { ok: false, error: `request to evaluator blocked: ${evalResp.reason}`, history }
    }
    if (evalResp.timed_out) {
      return { ok: false, error: `evaluator "${evaluator}" did not reply within ${timeoutMs}ms`, history, last_result: lastResult }
    }

    const evalText = validatedEval.text
    const parsed = validatedEval.parsed
    const schemaFailed = parsed === null
    lastEvaluation = {
      attempt: attempt + 1,
      passed: parsed && typeof parsed.passed === 'boolean' ? parsed.passed : null,
      score: parsed && typeof parsed.score === 'number' ? parsed.score : null,
      // When schema validation failed twice, tag the feedback so the worker
      // (and downstream callers) can see the response was malformed instead
      // of silently treating the judge's full raw transcript as actionable
      // feedback. When parsed.feedback is missing but the response was valid
      // (passed-only), fall through to the raw text — preserves the prior
      // behaviour for evaluators that emit `{passed: true}` without feedback.
      feedback: parsed && typeof parsed.feedback === 'string'
        ? parsed.feedback
        : schemaFailed
          ? `[schema-validation-failed] evaluator response did not match required schema after 1 retry. Raw text:\n${evalText.slice(0, 500)}`
          : evalText,
      raw: evalText,
      schema_failed: schemaFailed,
    }
    history.push({ result: lastResult, evaluation: lastEvaluation })

    await emitEvent('evaluated_task.attempt', {
      team_name: teamName, worker, evaluator,
      attempt: attempt + 1, passed: lastEvaluation.passed, score: lastEvaluation.score,
    })

    if (lastEvaluation.passed === true) {
      return {
        ok: true, accepted: true,
        attempts: attempt + 1,
        result: lastResult,
        evaluation: lastEvaluation,
        history,
      }
    }

    if (attempt < maxRevisions) {
      currentPrompt = buildRevisionPrompt(prompt, lastResult, lastEvaluation.feedback)
    }
  }

  return {
    ok: true,
    accepted: false,
    attempts: maxRevisions + 1,
    result: lastResult,
    evaluation: lastEvaluation,
    history,
    reason: `max_revisions=${maxRevisions} exhausted without ACCEPT`,
  }
}

// ---------------------------------------------------------------------------
// Consensus task — worker → N parallel evaluators → quorum → REVISE/ACCEPT
//
// Inspired by bun's `.claude/workflows/phase-h-diff-review.workflow.js` 2-vote
// pattern. Each round:
//   1. Worker produces an answer (single sendRequest).
//   2. ALL N evaluators receive the answer in parallel (Promise.all of
//      schema-validated sendRequests via fetchValidatedJudgeReply).
//   3. Decide ACCEPT vs REVISE:
//        - Default semantics ("verifier" mode): ACCEPT iff zero votes
//          explicitly say `passed=false`. Abstains (schema-fail twice) do
//          NOT block ACCEPT — they're treated as "no positive refute".
//        - When `quorum` is given, require `accepts >= quorum` for ACCEPT
//          (stricter; abstains count against quorum).
//   4. On REVISE: dedup feedback strings by their first 80 chars and merge
//      into the worker's revision prompt.
//
// ---------------------------------------------------------------------------

function summarizeVotes(votes) {
  const accepts = votes.filter(v => v.passed === true).length
  const refutes = votes.filter(v => v.passed === false).length
  const abstains = votes.length - accepts - refutes
  return { accepts, refutes, abstains, total: votes.length }
}

function dedupFeedback(votes) {
  const seen = new Set()
  const out = []
  for (const v of votes) {
    if (v.passed !== false) continue
    const fb = typeof v.feedback === 'string' ? v.feedback : ''
    if (!fb) continue
    const key = fb.slice(0, 80)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ evaluator: v.evaluator, feedback: fb })
  }
  return out
}

function buildConsensusRevisionPrompt(originalPrompt, prevResult, dedupedFeedback) {
  const lines = [
    'Revise your previous answer based on feedback from multiple evaluators.',
    '',
    'Original request:',
    originalPrompt,
    '',
    'Your previous answer:',
    prevResult,
    '',
    `Feedback from ${dedupedFeedback.length} evaluator(s):`,
  ]
  dedupedFeedback.forEach((f, i) => {
    lines.push(`  ${i + 1}. [${f.evaluator}] ${f.feedback}`)
  })
  lines.push('', 'Produce an improved answer that addresses each point above.')
  return lines.join('\n')
}

export async function runConsensusTask({
  teamName, worker, evaluators, prompt,
  from = 'team-lead',
  quorum, // optional; default = no quorum (default-ACCEPT semantics)
  maxRevisions = 2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!prompt || typeof prompt !== 'string') {
    return { ok: false, error: 'prompt is required' }
  }
  if (!Array.isArray(evaluators) || evaluators.length < 2) {
    return { ok: false, error: 'evaluators must be an array of at least 2 agent names' }
  }
  if (new Set(evaluators).size !== evaluators.length) {
    return { ok: false, error: 'evaluators must be distinct' }
  }
  if (evaluators.includes(worker)) {
    return { ok: false, error: 'worker cannot also be an evaluator' }
  }
  if (
    !Number.isInteger(maxRevisions) ||
    maxRevisions < 0 ||
    maxRevisions > MAX_REVISIONS_CAP
  ) {
    return {
      ok: false,
      error: `maxRevisions must be an integer in [0, ${MAX_REVISIONS_CAP}] (got ${maxRevisions})`,
    }
  }
  if (quorum !== undefined) {
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > evaluators.length) {
      return {
        ok: false,
        error: `quorum must be an integer in [1, ${evaluators.length}] (got ${quorum})`,
      }
    }
  }
  const team = await readTeam(teamName)
  if (!team) return { ok: false, error: `team "${teamName}" not found` }
  if (!team.members.find(m => m.name === worker)) {
    return { ok: false, error: `worker "${worker}" not a team member` }
  }
  for (const ev of evaluators) {
    if (!team.members.find(m => m.name === ev)) {
      return { ok: false, error: `evaluator "${ev}" not a team member` }
    }
  }

  const history = []
  let currentPrompt = prompt
  let lastResult = null
  let lastVotes = []
  let lastSummary = null

  for (let attempt = 0; attempt <= maxRevisions; attempt++) {
    // --- Worker turn ---
    const workerResp = await sendRequest({
      teamName, from, to: worker, prompt: currentPrompt, timeoutMs,
    })
    if (workerResp.pending_approval) {
      return {
        ok: false,
        error: `request to worker held for approval (id=${workerResp.pending_approval_id}, attempt ${attempt + 1}): ${workerResp.reason || 'auto_require_approval triggered'}`,
        pending_approval: true,
        pending_approval_id: workerResp.pending_approval_id,
        history,
      }
    }
    if (workerResp.blocked) {
      return { ok: false, error: `request to worker blocked: ${workerResp.reason}`, history }
    }
    if (workerResp.timed_out) {
      return { ok: false, error: `worker "${worker}" did not reply within ${timeoutMs}ms (attempt ${attempt + 1})`, history }
    }
    lastResult = workerResp.response?.text || ''

    // --- N evaluators in parallel ---
    const evalPrompt = buildEvaluatorPrompt(prompt, lastResult, attempt)
    const validated = await Promise.all(
      evaluators.map(ev => fetchValidatedJudgeReply({
        teamName, from, evaluator: ev, prompt: evalPrompt, timeoutMs,
        retryPromptId: `runConsensusTask:attempt-${attempt + 1}:${ev}`,
      }))
    )

    // Bubble up transport-level failures (pending_approval / blocked / timeout
    // from ANY evaluator). We surface the first such failure with its
    // evaluator name so the orchestrator can act on it. Schema fails are NOT
    // transport failures and become abstain votes below.
    for (let i = 0; i < validated.length; i++) {
      const v = validated[i]
      const t = v.transport
      const ev = evaluators[i]
      if (t.pending_approval) {
        return {
          ok: false,
          error: `request to evaluator "${ev}" held for approval (id=${t.pending_approval_id}, attempt ${attempt + 1}): ${t.reason || 'auto_require_approval triggered'}`,
          pending_approval: true,
          pending_approval_id: t.pending_approval_id,
          held_evaluator: ev,
          history,
          last_result: lastResult,
        }
      }
      if (t.blocked) {
        return { ok: false, error: `request to evaluator "${ev}" blocked: ${t.reason}`, blocked_evaluator: ev, history }
      }
      if (t.timed_out) {
        return { ok: false, error: `evaluator "${ev}" did not reply within ${timeoutMs}ms`, timed_out_evaluator: ev, history, last_result: lastResult }
      }
    }

    // Build vote records.
    const votes = validated.map((v, i) => {
      const ev = evaluators[i]
      const parsed = v.parsed
      const schemaFailed = parsed === null
      return {
        evaluator: ev,
        passed: parsed && typeof parsed.passed === 'boolean' ? parsed.passed : null,
        score: parsed && typeof parsed.score === 'number' ? parsed.score : null,
        feedback: parsed && typeof parsed.feedback === 'string'
          ? parsed.feedback
          : schemaFailed
            ? `[schema-validation-failed] ${ev} did not match required schema after 1 retry.`
            : v.text,
        schema_failed: schemaFailed,
        raw: v.text,
      }
    })
    lastVotes = votes
    lastSummary = summarizeVotes(votes)

    await emitEvent('consensus.round', {
      team_name: teamName, worker, evaluators,
      attempt: attempt + 1,
      ...lastSummary,
      quorum: quorum ?? null,
    })

    // Decide ACCEPT.
    const accepted = quorum !== undefined
      ? lastSummary.accepts >= quorum
      : lastSummary.refutes === 0 // default-ACCEPT: any explicit refute blocks
    history.push({ result: lastResult, votes, summary: lastSummary, accepted })

    if (accepted) {
      return {
        ok: true,
        accepted: true,
        attempts: attempt + 1,
        result: lastResult,
        votes,
        summary: lastSummary,
        history,
      }
    }

    if (attempt < maxRevisions) {
      const deduped = dedupFeedback(votes)
      currentPrompt = deduped.length > 0
        ? buildConsensusRevisionPrompt(prompt, lastResult, deduped)
        : buildRevisionPrompt(prompt, lastResult, '(evaluators refuted but provided no actionable feedback — re-attempt with improvements based on the original prompt)')
    }
  }

  return {
    ok: true,
    accepted: false,
    attempts: maxRevisions + 1,
    result: lastResult,
    votes: lastVotes,
    summary: lastSummary,
    history,
    reason: `max_revisions=${maxRevisions} exhausted without consensus`,
  }
}
