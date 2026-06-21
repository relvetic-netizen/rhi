// M7 admission gate (Sprint 3b) — task identity inference + autonomous-path
// detection so HITL approval prompts can be denied for autonomous workers.
//
// Contract (impl plan v4.2 §3.8 + handoff Decisions 25-27):
//
//   inferTaskId({ caller, env, sessionMap, configDir, sessionId })
//     → { taskId, source }
//     source ∈ 'caller' | 'env' | 'session-map' | null
//     null means: no autonomous task identity is known. Per M7 backward-compat
//     contract this MUST allow HITL (existing human reviewer caller path).
//
//   isAutonomousTaskPath({ taskId, cwd, env })
//     → boolean
//     true if any autonomy marker is present:
//       (a) env.RELVETIA_AUTONOMOUS === '1'
//       (b) taskId matches the autonomous task-id namespace
//       (c) cwd is under a configured autonomous-worker root (the handoffs root
//           and the tasks root). Both default to the standard relvetia layout
//           and are overridable via $RHI_HANDOFFS_ROOT / $RHI_TASKS_ROOT.
//
//   autonomousFallback({ originalRequest, fallback, taskId, source, ... })
//     → { fallback, taskId, source, ... }
//     'deferred' (default): record pending intent, worker continues
//     'conservative_default': caller-supplied default value
//
// Semantic equivalence (handoff Decisions §25): the inferTaskId env→session-map
// source order MUST match ctx-budget.mjs::resolveActiveTaskId. The difference
// is that inferTaskId has NO inferred fallback (handoff DON'T 31): it returns
// null instead of guessing, because guessing would falsely deny human HITL.

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const AUTONOMOUS_TASK_ID_REGEX = /^(auto|autoloop|symphony-impl|symphony-harness)-/

// Environment variables that participate in inference / autonomy detection.
// Kept here so tests can introspect without re-stating string literals.
export const ADMISSION_ENV_KEYS = Object.freeze({
  ACTIVE_TASK_ID: 'RELVETIA_ACTIVE_TASK_ID',
  AUTONOMOUS: 'RELVETIA_AUTONOMOUS',
  SESSION_ID: 'RELVETIA_SESSION_ID',
  CLAUDE_SESSION_ID: 'CLAUDE_SESSION_ID',
})

function defaultConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

function defaultSessionMapPath(env) {
  return path.join(defaultConfigDir(env), 'relvetia', 'session-task.json')
}

function readSessionMapSafe(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolve a task_id for the current call site.
 *
 * Precedence:
 *   1. caller   — caller-supplied (most explicit)
 *   2. env      — RELVETIA_ACTIVE_TASK_ID (set by spawn-relay for autonomous workers)
 *   3. session-map — sessionId → task_id mapping (~/.claude/relvetia/session-task.json)
 *   4. null     — no autonomous task identity (HITL allow path, backward compat)
 *
 * No inferred fallback (handoff DON'T 31): null is the explicit "I don't
 * know" answer, never a guess. HITL approval relies on this to keep the
 * existing human reviewer flow working.
 */
export function inferTaskId({
  caller,
  env = process.env,
  sessionMap,
  configDir,
  sessionId,
} = {}) {
  if (caller != null && caller !== '') {
    return { taskId: String(caller), source: 'caller' }
  }
  const envTaskId = env[ADMISSION_ENV_KEYS.ACTIVE_TASK_ID]
  if (typeof envTaskId === 'string' && envTaskId !== '') {
    return { taskId: envTaskId, source: 'env' }
  }
  const sid = sessionId ?? env[ADMISSION_ENV_KEYS.CLAUDE_SESSION_ID] ?? env[ADMISSION_ENV_KEYS.SESSION_ID]
  if (sid) {
    const map = sessionMap ?? readSessionMapSafe(
      configDir ? path.join(configDir, 'relvetia', 'session-task.json') : defaultSessionMapPath(env),
    )
    const entry = map?.sessions?.[sid]
    if (entry?.task_id) {
      return { taskId: String(entry.task_id), source: 'session-map' }
    }
  }
  return { taskId: null, source: null }
}

/**
 * Detect whether the current call site is an autonomous worker that should
 * have HITL approval denied.
 */
export function isAutonomousTaskPath({ taskId, cwd, env = process.env } = {}) {
  if (env[ADMISSION_ENV_KEYS.AUTONOMOUS] === '1') return true
  if (taskId && AUTONOMOUS_TASK_ID_REGEX.test(taskId)) return true
  if (cwd) {
    const norm = path.normalize(cwd).replace(/\\/g, '/')
    const home = os.homedir().replace(/\\/g, '/')
    // Autonomous-worker roots. Defaults follow the standard relvetia layout but
    // are overridable so operators can relocate where autonomous workers run.
    const normRoot = (p) => {
      const r = p.replace(/\\/g, '/')
      return r.endsWith('/') ? r : `${r}/`
    }
    const handoffsRoot = normRoot(env.RHI_HANDOFFS_ROOT || `${home}/.claude/relvetia/handoffs`)
    const tasksRoot = normRoot(env.RHI_TASKS_ROOT || `${home}/workspace/relvetia-tasks`)
    if (norm.startsWith(handoffsRoot) || norm.startsWith(tasksRoot)) return true
  }
  return false
}

/**
 * Build a structured autonomous fallback response for a denied HITL call.
 * The caller layer (team_send_message) wraps this into an MCP tool reply.
 */
export function autonomousFallback({
  originalRequest = null,
  fallback = 'deferred',
  taskId = null,
  source = null,
  reason = 'autonomous_path',
} = {}) {
  if (fallback !== 'deferred' && fallback !== 'conservative_default') {
    throw new Error(`Invalid fallback: ${fallback}`)
  }
  return {
    error: 'HITL_ADMISSION_DENIED',
    fallback,
    reason,
    taskId,
    source,
    originalRequest,
  }
}

/**
 * High-level admission decision for HITL approval requests. Returns a
 * structured deny envelope when the call site is autonomous-with-known-task,
 * otherwise null (HITL allow path).
 *
 * Wraps the inferTaskId / isAutonomousTaskPath / autonomousFallback trio so
 * tool layers (team_send_message etc.) only need a single call.
 */
export function shouldDenyHitl({
  requiresApproval,
  env = process.env,
  cwd = process.cwd(),
  sessionMap,
  configDir,
  sessionId,
  caller,
  originalRequest = null,
  fallback = 'deferred',
} = {}) {
  if (!requiresApproval) return null
  const inferred = inferTaskId({ caller, env, sessionMap, configDir, sessionId })
  if (inferred.taskId === null) return null
  if (!isAutonomousTaskPath({ taskId: inferred.taskId, cwd, env })) return null
  return autonomousFallback({
    originalRequest,
    fallback,
    taskId: inferred.taskId,
    source: inferred.source,
  })
}

// ============================================================================
// W2-S3 cross-team admission (S3-B + S3-D + S3-G + S3-H)
//
// Pure-function gate that the MCP tool layer (team_invoke / team_send_message
// when the message crosses a team boundary) consults BEFORE delivering. The
// caller resolves target_mode from the target team config and supplies the
// ledger.cross_team_chain entries; this module only owns the decision logic.
//
// Returns { allow, reason?, ... } for predictable wiring. `in_team: true`
// means the call did not cross a team boundary, so callers should fall back
// to existing in-team admission (Wave 1 inferTaskId / shouldDenyHitl /
// requests.js cycle deny). For cross-team paths, four gates run in order:
//
//   1. S3-H broadcast deny (target_team === '*')        — W2-DONT-7
//   2. S3-G target-down deadline (24h grace, R-W2-2)
//   3. S3-D cycle deny (BFS over pending chain entries) — Wave 1 cycle logic
//   4. S3-B autonomous target HITL deny (D-W2-3)
//
// Anything that passes all four returns { allow: true, in_team: false }.
// ============================================================================

// W2-S3 24h target-down grace per impl plan v5 final §3.3 / §4.3.
export const CROSS_TEAM_GRACE_MS = 24 * 60 * 60 * 1000

// Statuses that count as "still pending" for cycle detection. Completed,
// expired, and denied entries do NOT participate in the in-flight graph
// because they cannot block a new request.
const CYCLE_PENDING_STATUSES = new Set(['pending', 'in_flight', null, undefined])

function nodeKey(team, agent) {
  // Normalize null / undefined to empty string so the key is stable.
  // `${null}` would render as "null" which is an actual valid agent name.
  const t = team == null ? '' : String(team)
  const a = agent == null ? '' : String(agent)
  return `${t}:${a}`
}

function bfsHasPath(graph, start, target) {
  if (start === target) return true
  const visited = new Set()
  const queue = [start]
  while (queue.length > 0) {
    const node = queue.shift()
    if (visited.has(node)) continue
    visited.add(node)
    const adj = graph.get(node)
    if (!adj) continue
    if (adj.has(target)) return true
    for (const next of adj) queue.push(next)
  }
  return false
}

/**
 * Detect whether recording the proposed cross-team edge would close a cycle
 * in the in-flight cross-team chain. The chain is a flat array of objects;
 * any element with status not in CYCLE_PENDING_STATUSES is skipped.
 *
 * Returns true when adding edge would form a cycle:
 *   - self-loop (source === target)
 *   - existing path from target back to source through pending entries
 *
 * Pure / synchronous / no I/O — the chain MUST be supplied by the caller
 * (the canonical source is ledger.cross_team_chain).
 */
export function _detectCrossTeamCycle({ chain = [], edge } = {}) {
  if (!edge) return false
  const fromKey = nodeKey(edge.source_team, edge.source_agent)
  const toKey = nodeKey(edge.target_team, edge.target_agent)
  if (fromKey === toKey) return true
  const graph = new Map()
  for (const e of chain) {
    if (!e || typeof e !== 'object') continue
    if (!CYCLE_PENDING_STATUSES.has(e.status)) continue
    const f = nodeKey(e.source_team, e.source_agent)
    const t = nodeKey(e.target_team, e.target_agent)
    if (!graph.has(f)) graph.set(f, new Set())
    graph.get(f).add(t)
  }
  return bfsHasPath(graph, toKey, fromKey)
}

/**
 * Single-call cross-team admission gate. Runs S3-H → S3-G → S3-D → S3-B in
 * that order and short-circuits on the first deny.
 *
 * Inputs:
 *   source_team / source_agent   — caller (null = in-team)
 *   target_team / target_agent   — recipient (null = in-team)
 *   target_mode                  — 'autonomous' | 'hitl' | null (resolved by caller from team config)
 *   requires_approval            — boolean (S3-B only fires when true)
 *   ledger_chain                 — array of cross_team_chain entries
 *   started_at_ms                — when the request was first issued (for S3-G)
 *   now_ms                       — clock injection point (fake-clock 24h test)
 *   grace_ms                     — target-down deadline override (default 24h)
 *
 * Outputs:
 *   { allow: true, in_team: true }                                   — no boundary crossed
 *   { allow: true, in_team: false }                                  — passed all four gates
 *   { allow: false, reason, ... }                                    — gate-specific deny envelope
 */
// W3-S2 P1-3: Safe broadcast admission. The legacy `target_team === '*'`
// path stays denied (W2-DONT-7). Operators that need fanout must use this
// explicit, audited route instead, which enforces:
//   * audit_label: required non-empty string identifying the broadcast intent
//   * recipients: explicit whitelist of non-empty strings (no '*' wildcards)
//   * fanout_limit: max recipient count (default 10, override 1..100)
// Returns:
//   { allow: true,  audit: {...}, recipients: [...], audit_label, fanout_limit }
//   { allow: false, reason }
//
// This function is admission-only — no persistence, no actual send. The
// caller (orchestrator / coordinator) issues per-recipient sends after
// admission passes, and records the broadcast envelope via
// formatBroadcastEnvelope (graph-store) + recordBroadcastIntent (ledger
// audit log on the relvetia/scripts side).
export const BROADCAST_FANOUT_DEFAULT = 10
export const BROADCAST_FANOUT_MAX = 100

/** Reserved for Wave 3 cross-team broadcast — no current caller. */
export function evaluateBroadcastAdmission({
  audit_label = null,
  recipients = null,
  fanout_limit = BROADCAST_FANOUT_DEFAULT,
  source_team = null,
  source_agent = null,
  now_ms = Date.now(),
} = {}) {
  if (typeof audit_label !== 'string' || audit_label.trim().length === 0) {
    return { allow: false, reason: 'broadcast_audit_label_required' }
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { allow: false, reason: 'broadcast_recipients_required' }
  }
  for (const r of recipients) {
    if (typeof r !== 'string' || r.trim().length === 0) {
      return { allow: false, reason: 'broadcast_recipient_invalid' }
    }
    if (r === '*') {
      return { allow: false, reason: 'broadcast_wildcard_not_allowed' }
    }
  }
  // Reject duplicate recipients early — accidental double-deliver would
  // otherwise inflate the audit log and confuse downstream dedup.
  const uniq = new Set(recipients)
  if (uniq.size !== recipients.length) {
    return { allow: false, reason: 'broadcast_duplicate_recipients' }
  }
  if (!Number.isInteger(fanout_limit) || fanout_limit < 1 || fanout_limit > BROADCAST_FANOUT_MAX) {
    return { allow: false, reason: 'broadcast_fanout_limit_invalid' }
  }
  if (recipients.length > fanout_limit) {
    return {
      allow: false,
      reason: 'broadcast_fanout_exceeded',
      attempted: recipients.length,
      fanout_limit,
    }
  }
  return {
    allow: true,
    audit_label,
    recipients: [...recipients],
    fanout_limit,
    audit: {
      rule: 'W3-S2-P1-3',
      kind: 'broadcast_safe',
      audit_label,
      source_team,
      source_agent,
      recipient_count: recipients.length,
      fanout_limit,
      at_ms: now_ms,
    },
  }
}

export function evaluateCrossTeamAdmission({
  source_team = null,
  source_agent = null,
  target_team = null,
  target_agent = null,
  target_mode = null,
  requires_approval = false,
  ledger_chain = [],
  started_at_ms = null,
  now_ms = Date.now(),
  grace_ms = CROSS_TEAM_GRACE_MS,
  originalRequest = null,
} = {}) {
  // S3-H: wildcard broadcast is disallowed in Wave 2 (W2-DONT-7).
  // The broadcast may still legitimately exist on team_send_message for
  // in-team `to: "*"`, so we ONLY deny when a *cross-team* writer set
  // target_team to '*'.
  if (target_team === '*') {
    return {
      allow: false,
      reason: 'cross_team_broadcast_denied',
      audit: {
        rule: 'W2-DONT-7',
        source_team,
        source_agent,
        target_team,
        target_agent,
        at_ms: now_ms,
      },
    }
  }

  // In-team short circuit. Either side null OR same team => Wave 1 logic
  // governs (caller falls back to existing admission). null source/target
  // matches the impl plan §3.3 contract: null = in-team.
  const sourceNorm = source_team == null ? null : String(source_team)
  const targetNorm = target_team == null ? null : String(target_team)
  const isCrossTeam = sourceNorm != null && targetNorm != null && sourceNorm !== targetNorm
  if (!isCrossTeam) {
    return { allow: true, in_team: true }
  }

  // S3-G: 24h target-down deadline (R-W2-2). When the source recorded
  // started_at_ms, even a live target must be released after `grace_ms` so
  // the source side never blocks indefinitely.
  if (Number.isFinite(started_at_ms) && now_ms - started_at_ms > grace_ms) {
    return {
      allow: false,
      reason: 'cross_team_target_down_timeout',
      deadline_ms: started_at_ms + grace_ms,
      elapsed_ms: now_ms - started_at_ms,
      grace_ms,
      audit: {
        rule: 'R-W2-2',
        source_team,
        source_agent,
        target_team,
        target_agent,
        started_at_ms,
        now_ms,
      },
    }
  }

  // S3-D: cross-team cycle deny. Re-uses the in-flight graph idiom from
  // requests.js but spans team boundaries via `team:agent` keys.
  if (_detectCrossTeamCycle({
    chain: ledger_chain,
    edge: { source_team, source_agent, target_team, target_agent },
  })) {
    return {
      allow: false,
      reason: 'cross_team_cycle',
      audit: {
        rule: 'D-W2-3',
        source_team,
        source_agent,
        target_team,
        target_agent,
        at_ms: now_ms,
      },
    }
  }

  // S3-B: autonomous target HITL deny. Only relevant when the call would
  // require approval AND the target team is marked autonomous. Caller
  // resolves target_mode from the target team config; null mode means
  // "no marker" and is allowed.
  if (requires_approval && target_mode === 'autonomous') {
    return {
      allow: false,
      reason: 'cross_team_autonomous_hitl_denied',
      fallback: autonomousFallback({
        originalRequest,
        fallback: 'deferred',
        taskId: target_agent,
        source: 'cross_team_admission',
        reason: 'autonomous_target',
      }),
      audit: {
        rule: 'D-W2-3',
        source_team,
        source_agent,
        target_team,
        target_agent,
        target_mode,
      },
    }
  }

  return { allow: true, in_team: false }
}
