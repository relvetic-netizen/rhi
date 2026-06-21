// Agents-as-tools — inspired by OpenAI Agents SDK `agent.as_tool()`.
// Single-process SDK agents can call a specialist as a tool and block until
// it returns. In a multi-process file-based system we simulate this with:
//
//   team_request(to, prompt, timeout_ms)  →
//     1. Write a request message tagged with a unique request_id to `to`'s inbox.
//     2. Poll the CALLER's inbox for a response with `in_reply_to = request_id`.
//     3. Return the response text (blocks caller for up to timeout_ms).
//
//   team_reply(request_id, response_text)  →
//     Write a response message back to the original requester with
//     `in_reply_to` set. Recipient is looked up from the pending-requests map.
//
// This gives manager agents a bounded-subtask primitive without replacing
// the async mailbox as the default communication path.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { getTeamDir, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeToMailbox, readMailbox } from './mailbox.js'
import { errorMessage, isEnoent } from './errors.js'
import { readTeam } from './team.js'
import { writeRequest, updateRequestStatus } from './graph-store.js'

const DEFAULT_POLL_INTERVAL_MS = 200
const DEFAULT_TIMEOUT_MS = 60000

// Sprint 3b S3b-D — sync request cycle detection.
// In-flight `team_request` graph: node → Map<node, Set<request_id>>. We never
// let an autonomous worker enter a cycle (e.g. A awaiting B awaiting A) because
// the second caller would block forever waiting on an inbox the first caller
// can never service. Wave 1 minimal: in-memory graph; Wave 2 evaluates
// persistence (handoff DON'T 32 — writer contract = relay-orchestrator only).
//
// W2-bugfix P1-b: nodes are keyed by `${teamName}:${agent}` so two teams that
// happen to share agent names (alice→bob in team-x vs team-y) are NOT collapsed
// into one node (false cross-team deny). Edges hold the set of in-flight
// request_ids that opened them; the edge is only removed when its LAST request
// completes (refcount), so two concurrent alice→bob requests don't let one
// completing request silently re-open bob→alice while the other is still
// in-flight.
const inFlightGraph = new Map()

// Node key — namespaced by team so identical agent names in different teams
// never alias. teamName may be undefined in legacy callers; normalize to ''.
function nodeKey(teamName, agent) {
  return `${teamName == null ? '' : teamName}:${agent}`
}

function graphHasPath(graph, start, target) {
  if (start === target) return false
  const visited = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const node = queue.shift()
    if (visited.has(node)) continue
    visited.add(node)
    const adj = graph.get(node)
    if (!adj) continue
    if (adj.has(target)) return true
    for (const next of adj.keys()) queue.push(next)
  }
  return false
}

function recordInFlight(fromKey, toKey, requestId) {
  if (!inFlightGraph.has(fromKey)) inFlightGraph.set(fromKey, new Map())
  const adj = inFlightGraph.get(fromKey)
  if (!adj.has(toKey)) adj.set(toKey, new Set())
  adj.get(toKey).add(requestId)
}

function clearInFlight(fromKey, toKey, requestId) {
  const adj = inFlightGraph.get(fromKey)
  if (!adj) return
  const ids = adj.get(toKey)
  if (!ids) return
  ids.delete(requestId)
  if (ids.size === 0) adj.delete(toKey)
  if (adj.size === 0) inFlightGraph.delete(fromKey)
}

// Returns { ok, reason } — never throws, so the MCP server stays crash-free on
// I/O error (R-W2-8 contract). But the failure is NOT swallowed silently: the
// caller propagates a `graph_degraded` flag to the tool response (W2-bugfix
// P1-c) so the requester knows this pending request will NOT survive a daemon
// restart (recoverPendingOnRestart can only see persisted entries).
function persistGraphRequest(entry) {
  try {
    const result = writeRequest(entry)
    if (!result?.ok) {
      const reason = result?.reason ?? 'unknown'
      console.warn(`[requests] graph writeRequest failed for ${entry.request_id}: ${reason}`)
      return { ok: false, reason }
    }
    return { ok: true }
  } catch (e) {
    const reason = errorMessage(e)
    console.warn(`[requests] graph writeRequest failed for ${entry.request_id}: ${reason}`)
    return { ok: false, reason }
  }
}

// Returns { ok, reason } — never throws (R-W2-8). Like persistGraphRequest, a
// failed status transition is NOT swallowed: the request reached a terminal
// state (completed / expired) that did not persist, so the graph entry stays
// `pending` and a daemon restart would mis-recover it. The caller surfaces a
// `graph_degraded` flag (W2-bugfix P1-c) so the requester knows the terminal
// state was not durably recorded.
function persistGraphStatus({ request_id, status, evidence }) {
  try {
    const result = updateRequestStatus({ request_id, status, evidence })
    if (!result?.ok) {
      const reason = result?.reason ?? 'unknown'
      console.warn(`[requests] graph updateRequestStatus failed for ${request_id}: ${reason}`)
      return { ok: false, reason }
    }
    return { ok: true }
  } catch (e) {
    const reason = errorMessage(e)
    console.warn(`[requests] graph updateRequestStatus failed for ${request_id}: ${reason}`)
    return { ok: false, reason }
  }
}

// Merge a status-persistence failure into the existing degraded marker. If the
// request was already flagged degraded (writeRequest failed), the writeRequest
// reason wins (it is the earlier / more fundamental failure). Otherwise a
// failed status transition raises the flag on its own.
function withStatusDegraded(degraded, statusResult) {
  if (statusResult?.ok !== false) return degraded
  if (degraded.graph_degraded) return degraded
  return { graph_degraded: true, graph_degraded_reason: statusResult.reason }
}

// Test-only inspection helpers. Production code MUST NOT mutate the graph
// directly — use sendRequest's normal lifecycle. The snapshot collapses the
// per-edge request_id sets into a plain Set<node> so existing assertions that
// inspect adjacency still read naturally.
export function _peekInFlightGraph() {
  return new Map(
    Array.from(inFlightGraph, ([k, adj]) => [k, new Set(adj.keys())]),
  )
}
export function _clearInFlightGraph() {
  inFlightGraph.clear()
}
export function _detectCycle({ teamName, from, to }) {
  // True if recording (from→to) would close a cycle, i.e. there is already a
  // path from `to` back to `from` in the in-flight graph. Nodes are namespaced
  // by team so a same-named edge in another team does not trigger a false deny.
  return graphHasPath(inFlightGraph, nodeKey(teamName, to), nodeKey(teamName, from))
}

function requestsPath(teamName) {
  return join(getTeamDir(teamName), 'pending-requests.json')
}

async function readRegistry(teamName) {
  try {
    const raw = await readFile(requestsPath(teamName), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    if (isEnoent(e)) return {}
    console.error(`[requests] Registry read failed: ${errorMessage(e)}`)
    return {}
  }
}

async function writeRegistry(teamName, registry) {
  await ensureDir(getTeamDir(teamName))
  await writeFile(requestsPath(teamName), JSON.stringify(registry, null, 2))
}

async function registerRequest(teamName, requestId, meta) {
  const path = requestsPath(teamName)
  await ensureDir(getTeamDir(teamName))
  await withLock(path, async () => {
    const reg = await readRegistry(teamName)
    reg[requestId] = meta
    await writeRegistry(teamName, reg)
  }, { lockfilePath: `${path}.lock` })
}

async function deregisterRequest(teamName, requestId) {
  const path = requestsPath(teamName)
  await ensureDir(getTeamDir(teamName))
  await withLock(path, async () => {
    const reg = await readRegistry(teamName)
    const meta = reg[requestId]
    delete reg[requestId]
    await writeRegistry(teamName, reg)
    return meta
  }, { lockfilePath: `${path}.lock` })
}

export async function getRequest(teamName, requestId) {
  const reg = await readRegistry(teamName)
  return reg[requestId] || null
}

/**
 * Issue a request and block (with polling) until a reply arrives or timeout.
 *
 * @returns {{
 *   replied: boolean,
 *   request_id: string,
 *   response?: object,
 *   timed_out?: boolean,
 *   blocked?: boolean,
 *   reason?: string,
 *   pending_approval?: boolean,
 *   pending_approval_id?: string,
 * }}
 *
 * `pending_approval=true` indicates that an `auto_require_approval` (or
 * explicit `requires_approval`) guardrail captured the request before the
 * recipient ever saw it. The caller MUST treat this as a non-delivery —
 * polling for a reply is futile because human approval is asynchronous and
 * almost always outlives the caller's timeout. The registry entry is cleaned
 * up here so the request_id won't leak; consequently, if the held message is
 * later approved and the recipient calls `team_reply(request_id)`, the reply
 * will fail to deliver (no pending request). For HITL-gated work that needs
 * a reply, send the prompt directly with `team_send_message` instead.
 */
export async function sendRequest({
  teamName, from, to, prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  senderColor,
  orchestratorSessionId,
}) {
  // Sprint 3b S3b-D — cycle detection. If recording (from→to) would close
  // a cycle (e.g. B is already awaiting A's inbox), refuse synchronously
  // and recommend the async variant. Scoped to teamName so a same-named edge
  // in another team in the same daemon does not falsely deny (W2-bugfix P1-b).
  if (_detectCycle({ teamName, from, to })) {
    return {
      replied: false,
      request_id: null,
      error: 'SYNC_CYCLE_DENIED',
      reason: `sync request cycle detected: ${from} → ${to} would close a loop`,
      recommend: 'team_request_async',
    }
  }

  const requestId = `req_${randomBytes(8).toString('hex')}`
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  // TOCTOU fix: record the in-flight edge SYNCHRONOUSLY, right after the cycle
  // check and BEFORE the first await. Node is single-threaded, so as long as no
  // await separates _detectCycle from recordInFlight, two concurrent reverse
  // requests (alice→bob racing bob→alice) cannot both observe an empty graph and
  // both proceed. Previously recordInFlight ran only after registerRequest /
  // persistGraphRequest awaited, opening a window where both reverse requests
  // passed the empty-graph check, both went in-flight, and both timed out — the
  // cycle deny silently failed under concurrency.
  const fromKey = nodeKey(teamName, from)
  const toKey = nodeKey(teamName, to)
  recordInFlight(fromKey, toKey, requestId)

  // Rollback contract: the edge is live before any persistence await. If
  // registerRequest / writeToMailbox throw (file-lock / I/O failure), the edge
  // would leak as a phantom that falsely denies a later legitimate reverse
  // request, so we clear it on any throw and re-propagate (the existing contract
  // surfaces these failures to the caller). The graceful early-return paths
  // below (approval / blocked / reply / timeout) already clearInFlight and
  // return — they do not throw — so they are not double-cleared here.
  let registered = false
  try {
    await registerRequest(teamName, requestId, {
      from,
      to,
      createdAt: startedAt,
      ...(orchestratorSessionId ? { orchestratorSessionId } : {}),
    })
    registered = true
    const persist = persistGraphRequest({
      from,
      to,
      request_id: requestId,
      started_at: startedAt,
      deadline_at: deadline,
    })
    // P1-c: when the graph write failed, the request is live (registered +
    // delivered below) but invisible to restart recovery. Surface it instead of
    // letting the caller assume durable tracking.
    const degraded = persist.ok
      ? {}
      : { graph_degraded: true, graph_degraded_reason: persist.reason }

    const write = await writeToMailbox(teamName, to, {
      from,
      text: `<request id="${requestId}" reply-to="${from}">\n${prompt}\n</request>`,
      summary: `request: ${prompt.slice(0, 60)}`,
      color: senderColor,
      request_id: requestId,
      ...(orchestratorSessionId ? { orchestrator_session_id: orchestratorSessionId } : {}),
    })
    if (write.pending_approval_id) {
      // Held by guardrail (auto_require_approval) or explicit requires_approval.
      // Don't wait — human approval is asynchronous.
      await deregisterRequest(teamName, requestId)
      clearInFlight(fromKey, toKey, requestId)
      const statusResult = persistGraphStatus({
        request_id: requestId,
        status: 'expired',
        evidence: { reason: write.reason || 'request held for approval', pending_approval_id: write.pending_approval_id },
      })
      return {
        replied: false,
        request_id: requestId,
        pending_approval: true,
        pending_approval_id: write.pending_approval_id,
        reason: write.reason || 'request held for approval',
        ...withStatusDegraded(degraded, statusResult),
      }
    }
    if (write.blocked) {
      await deregisterRequest(teamName, requestId)
      clearInFlight(fromKey, toKey, requestId)
      const statusResult = persistGraphStatus({
        request_id: requestId,
        status: 'expired',
        evidence: { reason: write.reason || 'mailbox_blocked' },
      })
      return { replied: false, request_id: requestId, blocked: true, reason: write.reason, ...withStatusDegraded(degraded, statusResult) }
    }

    while (Date.now() < deadline) {
      const inbox = await readMailbox(teamName, from)
      const reply = inbox.find(m => m && m.in_reply_to === requestId)
      if (reply) {
        await deregisterRequest(teamName, requestId)
        clearInFlight(fromKey, toKey, requestId)
        const statusResult = persistGraphStatus({ request_id: requestId, status: 'completed' })
        return { replied: true, request_id: requestId, response: reply, ...withStatusDegraded(degraded, statusResult) }
      }
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }

    await deregisterRequest(teamName, requestId)
    clearInFlight(fromKey, toKey, requestId)
    const statusResult = persistGraphStatus({ request_id: requestId, status: 'expired', evidence: { reason: 'timeout' } })
    return { replied: false, request_id: requestId, timed_out: true, ...withStatusDegraded(degraded, statusResult) }
  } catch (e) {
    // Roll back the in-flight edge so a transient write failure does not leave a
    // phantom that blocks future reverse requests. Best-effort registry cleanup
    // (it may or may not have been written before the throw).
    clearInFlight(fromKey, toKey, requestId)
    if (registered) {
      try { await deregisterRequest(teamName, requestId) } catch {}
    }
    throw e
  }
}

/**
 * Issue an async fire-and-forget request. Unlike sendRequest(), this does not
 * register in pending-requests.json and never polls for a reply.
 *
 * @returns {{
 *   request_id: string,
 *   delivered?: boolean,
 *   blocked?: boolean,
 *   reason?: string,
 *   pending_approval_id?: string,
 * }}
 */
export async function sendRequestAsync({
  teamName, from, to, prompt,
  summary,
  urgencyHintMs,
  senderColor,
  orchestratorSessionId,
}) {
  const team = await readTeam(teamName)
  if (!team) throw new Error(`Team "${teamName}" not found.`)
  if (!team.members.some(m => m.name === from)) {
    throw new Error(`Member "${from}" not found.`)
  }
  if (to === '*') {
    throw new Error('Async broadcast not supported in v1; use team_send_message for fan-out without request tracking.')
  }
  if (!team.members.some(m => m.name === to)) {
    throw new Error(`Member "${to}" not found.`)
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be non-empty')
  }
  if (urgencyHintMs != null && (
    typeof urgencyHintMs !== 'number' ||
    !Number.isFinite(urgencyHintMs) ||
    urgencyHintMs < 0
  )) {
    throw new Error('urgencyHintMs must be a non-negative number')
  }

  const requestId = `areq_${randomUUID()}`
  const urgencyAttr = urgencyHintMs != null ? ` urgency-hint-ms="${urgencyHintMs}"` : ''
  const write = await writeToMailbox(teamName, to, {
    from,
    text: `<async-request id="${requestId}" from="${from}"${urgencyAttr}>\n${prompt}\n</async-request>`,
    summary,
    color: senderColor,
    request_id: requestId,
    ...(orchestratorSessionId ? { orchestrator_session_id: orchestratorSessionId } : {}),
  })

  if (write.pending_approval_id) {
    return {
      request_id: requestId,
      pending_approval_id: write.pending_approval_id,
      reason: write.reason || 'async request held for approval',
    }
  }
  if (write.blocked) {
    return { request_id: requestId, delivered: false, blocked: true, reason: write.reason }
  }
  return { request_id: requestId, delivered: true }
}

/**
 * Send a reply to a pending request. Looks up the original requester from
 * the registry so the caller doesn't need to track it.
 *
 * Returns `{ delivered, to?, reason?, pending_approval?, pending_approval_id? }`.
 * `pending_approval=true` means the reply itself was captured by a guardrail
 * and is waiting on human approval — the original requester will time out
 * (or already has) rather than receive this reply.
 */
export async function sendReply({ teamName, from, requestId, responseText, senderColor }) {
  const meta = await getRequest(teamName, requestId)
  if (!meta) {
    return { delivered: false, reason: `no pending request ${requestId}` }
  }
  const write = await writeToMailbox(teamName, meta.from, {
    from,
    text: responseText,
    summary: `reply to ${requestId}`,
    color: senderColor,
    in_reply_to: requestId,
    ...(meta.orchestratorSessionId ? { orchestrator_session_id: meta.orchestratorSessionId } : {}),
  })
  if (write.pending_approval_id) {
    return {
      delivered: false,
      pending_approval: true,
      pending_approval_id: write.pending_approval_id,
      reason: write.reason || 'reply held for approval',
    }
  }
  if (write.blocked) {
    return { delivered: false, reason: write.reason }
  }
  // P1-c: the reply was delivered but if the graph status transition fails the
  // request stays `pending` in the persisted graph; surface that to the replier
  // so it is not assumed durably resolved.
  const statusResult = persistGraphStatus({ request_id: requestId, status: 'completed' })
  const degraded = statusResult?.ok === false
    ? { graph_degraded: true, graph_degraded_reason: statusResult.reason }
    : {}
  return { delivered: true, to: meta.from, ...degraded }
}
