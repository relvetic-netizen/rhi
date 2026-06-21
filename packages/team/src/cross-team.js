// Cross-team invocation — extension of agents-as-tools across team
// boundaries. OpenAI Agents SDK doesn't have a direct analog (everything
// is one process), but the pattern is natural here: sometimes one team
// wants to invoke a specialist that lives in another team.
//
// The mechanics are similar to requests.js, with one twist: the request
// message written to the TARGET team's inbox carries full reply metadata
// (source_team, source_agent, request_id) because the callee cannot see
// the source team's pending-requests registry. The callee uses
// team_cross_reply to write back to the source team directly.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getTeamDir, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeToMailbox, readMailbox } from './mailbox.js'
import { readTeam } from './team.js'
import { errorMessage, isEnoent } from './errors.js'
import { evaluateCrossTeamAdmission } from './admission.js'
import { writeRequest, updateRequestStatus, listPending } from './graph-store.js'

const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_TIMEOUT_MS = 60000

function crossPath(teamName) {
  return join(getTeamDir(teamName), 'cross-team-requests.json')
}

async function readRegistry(teamName) {
  try {
    const raw = await readFile(crossPath(teamName), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    if (isEnoent(e)) return {}
    console.error(`[cross-team] registry read failed: ${errorMessage(e)}`)
    return {}
  }
}

async function writeRegistry(teamName, registry) {
  await ensureDir(getTeamDir(teamName))
  await writeFile(crossPath(teamName), JSON.stringify(registry, null, 2))
}

async function register(teamName, requestId, meta) {
  const path = crossPath(teamName)
  await ensureDir(getTeamDir(teamName))
  await withLock(path, async () => {
    const reg = await readRegistry(teamName)
    reg[requestId] = meta
    await writeRegistry(teamName, reg)
  }, { lockfilePath: `${path}.lock` })
}

async function deregister(teamName, requestId) {
  const path = crossPath(teamName)
  await ensureDir(getTeamDir(teamName))
  await withLock(path, async () => {
    const reg = await readRegistry(teamName)
    delete reg[requestId]
    await writeRegistry(teamName, reg)
  }, { lockfilePath: `${path}.lock` })
}

function graphFrom(sourceTeam, sourceAgent) {
  return `${sourceAgent}@${sourceTeam}`
}

function graphTo(targetTeam, targetAgent) {
  return `${targetAgent}@${targetTeam}`
}

// Split a persisted `agent@team` graph node back into { agent, team }. Team
// names may legitimately be missing the `@` (legacy / in-team requests written
// by requests.js use bare agent names) — those entries are not cross-team and
// are skipped by the chain reconstruction below. Split on the LAST `@` so an
// agent name containing `@` doesn't corrupt the team segment.
function splitGraphNode(node) {
  if (typeof node !== 'string') return null
  const at = node.lastIndexOf('@')
  if (at <= 0 || at === node.length - 1) return null
  return { agent: node.slice(0, at), team: node.slice(at + 1) }
}

// Reconstruct the in-flight cross-team chain in the 4-field shape that
// admission._detectCrossTeamCycle expects. The persisted graph (graph-store)
// stores collapsed `agent@team` strings in `from`/`to`; cross-team entries are
// the ones whose endpoints both decode to a team. Pending status only — the
// store already filters to pending. cross-team.js is a READER here (single
// writer remains graph-store), so a read failure degrades to an empty chain
// (cycle gate simply can't fire) rather than crashing the invoke.
function loadCrossTeamChain() {
  let pending
  try {
    pending = listPending()
  } catch (e) {
    console.warn(`[cross-team] chain reconstruction skipped (graph read failed): ${errorMessage(e)}`)
    return []
  }
  const chain = []
  for (const r of pending) {
    const src = splitGraphNode(r.from)
    const tgt = splitGraphNode(r.to)
    if (!src || !tgt) continue
    chain.push({
      request_id: r.request_id,
      source_team: src.team,
      source_agent: src.agent,
      target_team: tgt.team,
      target_agent: tgt.agent,
      status: r.status,
      started_at: r.started_at,
    })
  }
  return chain
}

// Returns { ok, reason } — never throws (MCP crash-free contract R-W2-8). The
// caller surfaces a `graph_degraded` flag (W2-bugfix P1-c) so a cross-team
// request that was delivered but not persisted is not silently assumed durable
// (it would be invisible to recoverPendingOnRestart).
function persistGraphRequest(entry) {
  try {
    const result = writeRequest(entry)
    if (!result?.ok) {
      const reason = result?.reason ?? 'unknown'
      console.warn(`[cross-team] graph writeRequest failed for ${entry.request_id}: ${reason}`)
      return { ok: false, reason }
    }
    return { ok: true }
  } catch (e) {
    const reason = errorMessage(e)
    console.warn(`[cross-team] graph writeRequest failed for ${entry.request_id}: ${reason}`)
    return { ok: false, reason }
  }
}

// Returns { ok, reason } — never throws (MCP crash-free contract R-W2-8). A
// failed status transition leaves the persisted entry `pending` after the
// request reached a terminal state, so the caller surfaces a `graph_degraded`
// flag (W2-bugfix P1-c) rather than only logging.
function persistGraphStatus({ request_id, status, evidence }) {
  try {
    const result = updateRequestStatus({ request_id, status, evidence })
    if (!result?.ok) {
      const reason = result?.reason ?? 'unknown'
      console.warn(`[cross-team] graph updateRequestStatus failed for ${request_id}: ${reason}`)
      return { ok: false, reason }
    }
    return { ok: true }
  } catch (e) {
    const reason = errorMessage(e)
    console.warn(`[cross-team] graph updateRequestStatus failed for ${request_id}: ${reason}`)
    return { ok: false, reason }
  }
}

// Merge a status-persistence failure into the existing (writeRequest) degraded
// marker. writeRequest failure is more fundamental, so it wins if both fail.
function withStatusDegraded(degraded, statusResult) {
  if (statusResult?.ok !== false) return degraded
  if (degraded.graph_degraded) return degraded
  return { graph_degraded: true, graph_degraded_reason: statusResult.reason }
}

/**
 * Invoke an agent in another team and block until they reply or timeout.
 *
 * Writes a tagged request to the TARGET team's inbox. The message body
 * contains all metadata needed for the callee to reply via team_cross_reply.
 */
export async function invoke({
  sourceTeam, sourceAgent, targetTeam, targetAgent, prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  senderColor,
  requiresApproval = false,
}) {
  const srcTeamObj = await readTeam(sourceTeam)
  if (!srcTeamObj) return { replied: false, error: `source team "${sourceTeam}" not found` }
  const requestId = `xreq_${randomBytes(8).toString('hex')}`
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs
  const persist = persistGraphRequest({
    from: graphFrom(sourceTeam, sourceAgent),
    to: graphTo(targetTeam, targetAgent),
    request_id: requestId,
    started_at: startedAt,
    deadline_at: deadline,
  })
  // P1-c: a cross-team request that is delivered but not persisted is invisible
  // to restart recovery. Carry the degraded marker onto the delivered return
  // paths instead of relying on a log line nobody reads.
  const degraded = persist.ok
    ? {}
    : { graph_degraded: true, graph_degraded_reason: persist.reason }
  // Resolve target_mode from the target team config (optional `mode` field;
  // null when the team is not found, e.g. the `*` broadcast pseudo-team which
  // S3-H denies first regardless). The in-flight chain is reconstructed from
  // the persisted graph so the cross-team cycle gate (S3-D) actually fires in
  // the production path — previously invoke() passed only source/target and
  // none of cycle / 24h / autonomous-HITL could trigger (W2-bugfix P1-a).
  const tgtTeamForMode = targetTeam === '*' ? null : await readTeam(targetTeam)
  const ledgerChain = loadCrossTeamChain().filter(e => e.request_id !== requestId)
  // W2-bugfix P1-a residual (S3-G): the 24h target-down fallback measures
  // elapsed time from when this from→to request was FIRST issued. Passing the
  // brand-new `startedAt` every time meant a long-pending request that is
  // re-invoked always looked fresh, so S3-G never fired. Inherit the original
  // started_at from the oldest pending graph entry on the same from→to edge;
  // only a genuinely new edge (no pending predecessor) uses the current clock,
  // which is correct because a new request is not yet 24h old.
  const edgeStartedAt = ledgerChain
    .filter(e =>
      e.source_team === sourceTeam && e.source_agent === sourceAgent &&
      e.target_team === targetTeam && e.target_agent === targetAgent &&
      Number.isFinite(e.started_at))
    .reduce((min, e) => (e.started_at < min ? e.started_at : min), startedAt)
  const admission = evaluateCrossTeamAdmission({
    source_team: sourceTeam,
    source_agent: sourceAgent,
    target_team: targetTeam,
    target_agent: targetAgent,
    target_mode: tgtTeamForMode?.mode ?? null,
    requires_approval: requiresApproval,
    ledger_chain: ledgerChain,
    started_at_ms: edgeStartedAt,
  })
  if (!admission.allow) {
    // P1-c: an admission-denied request still has a pending graph entry that
    // recovery must reconcile. If persisting the terminal `expired` status
    // fails, carry the degraded marker so the caller learns the graph is out
    // of sync, rather than leaving it silently pending. (S3-B/S3-G denials
    // flow through this path too.)
    const statusResult = persistGraphStatus({
      request_id: requestId,
      status: 'expired',
      evidence: { reason: admission.reason },
    })
    return {
      replied: false,
      request_id: requestId,
      blocked: true,
      reason: admission.reason,
      admission_audit: admission.audit,
      ...withStatusDegraded(degraded, statusResult),
    }
  }
  const tgtTeamObj = await readTeam(targetTeam)
  if (!tgtTeamObj) {
    const statusResult = persistGraphStatus({ request_id: requestId, status: 'expired', evidence: { reason: 'target_team_not_found' } })
    return { replied: false, request_id: requestId, error: `target team "${targetTeam}" not found`, ...withStatusDegraded(degraded, statusResult) }
  }
  if (!tgtTeamObj.members.find(m => m.name === targetAgent)) {
    const statusResult = persistGraphStatus({ request_id: requestId, status: 'expired', evidence: { reason: 'target_agent_not_found' } })
    return { replied: false, request_id: requestId, error: `target agent "${targetAgent}" not in team "${targetTeam}"`, ...withStatusDegraded(degraded, statusResult) }
  }

  await register(sourceTeam, requestId, { targetTeam, targetAgent, sourceAgent, createdAt: startedAt })

  const envelope =
    `<cross-team-request\n` +
    `  id="${requestId}"\n` +
    `  source-team="${sourceTeam}"\n` +
    `  source-agent="${sourceAgent}"\n` +
    `>\n${prompt}\n</cross-team-request>`

  const write = await writeToMailbox(targetTeam, targetAgent, {
    from: `${sourceAgent}@${sourceTeam}`,
    text: envelope,
    summary: `cross-team: ${prompt.slice(0, 50)}`,
    color: senderColor,
    request_id: requestId,
  }, { skipTurns: true })

  if (write.blocked) {
    await deregister(sourceTeam, requestId)
    const statusResult = persistGraphStatus({
      request_id: requestId,
      status: 'expired',
      evidence: { reason: write.reason || 'mailbox_blocked' },
    })
    return { replied: false, request_id: requestId, blocked: true, reason: write.reason, ...withStatusDegraded(degraded, statusResult) }
  }

  while (Date.now() < deadline) {
    const inbox = await readMailbox(sourceTeam, sourceAgent)
    const reply = inbox.find(m => m && m.in_reply_to === requestId)
    if (reply) {
      await deregister(sourceTeam, requestId)
      const statusResult = persistGraphStatus({ request_id: requestId, status: 'completed' })
      return { replied: true, request_id: requestId, response: reply, ...withStatusDegraded(degraded, statusResult) }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }

  await deregister(sourceTeam, requestId)
  const statusResult = persistGraphStatus({ request_id: requestId, status: 'expired', evidence: { reason: 'timeout' } })
  return { replied: false, request_id: requestId, timed_out: true, ...withStatusDegraded(degraded, statusResult) }
}

/**
 * Reply to a cross-team request. Writes the response to the source team's
 * inbox with in_reply_to=request_id.
 */
export async function crossReply({
  sourceTeam, sourceAgent, requestId, fromTeam, fromAgent, responseText,
}) {
  const write = await writeToMailbox(sourceTeam, sourceAgent, {
    from: `${fromAgent}@${fromTeam}`,
    text: responseText,
    summary: `cross-reply to ${requestId}`,
    in_reply_to: requestId,
  }, { skipTurns: true })
  if (write.blocked) {
    return { delivered: false, reason: write.reason }
  }
  // P1-c: reply delivered but a failed status transition leaves the entry
  // `pending`; surface that to the replier instead of assuming durable resolve.
  const statusResult = persistGraphStatus({ request_id: requestId, status: 'completed' })
  const degraded = statusResult?.ok === false
    ? { graph_degraded: true, graph_degraded_reason: statusResult.reason }
    : {}
  return { delivered: true, ...degraded }
}
