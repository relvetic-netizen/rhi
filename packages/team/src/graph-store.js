// W2-S4 S4-A + S4-B + S4-C — in-flight team_request graph persistence.
//   Source of truth = ~/.claude/relvetia/team-graph.json (single file, atomic
//   tmp+rename writes, .bak fallback for corruption recovery R-W2-4).
//
// Single writer contract (R-W2-8 + S4-G enforce):
//   - graph-store.js is the ONLY module that writes team-graph.json
//   - relay-orchestrator / self-heal-loop / admission read via loadGraph()
//   - self-heal-loop S4-G reconcile補書 also goes through writeRequest API
//
// Schema (D-W2-4, F-4 lowercase):
//   {
//     schema_version: 1,
//     requests: [{
//       from: string,            // source_agent or source_team
//       to: string,              // target_agent or target_team
//       request_id: string,
//       started_at: number,      // ms epoch
//       deadline_at: number,     // ms epoch
//       in_reply_to: string|null,
//       status: "pending"|"completed"|"expired"
//     }],
//     updated_at: number         // ms epoch (post-rename)
//   }
//
// Reader passthrough() (Pi SC-1 mitigation): unknown top-level / nested fields
// are preserved (not stripped) so future schema additions are forward compat.
// schema_version !== 1 → alarm + skip (non-crash).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { withLockSync } from './lockfile.js'

const REQUEST_STATUS_VALUES = ['pending', 'completed', 'expired']

export const RequestEntrySchema = z.object({
  from: z.string(),
  to: z.string(),
  request_id: z.string(),
  started_at: z.number().int(),
  deadline_at: z.number().int(),
  in_reply_to: z.string().nullable().optional(),
  status: z.enum(REQUEST_STATUS_VALUES).default('pending'),
}).passthrough()

export const TeamGraphSchema = z.object({
  schema_version: z.literal(1),
  requests: z.array(RequestEntrySchema).default([]),
  updated_at: z.number().int(),
}).passthrough()

function getConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export function getGraphPath() {
  return process.env.RELVETIA_TEAM_GRAPH_PATH
    ?? join(getConfigDir(), 'relvetia', 'team-graph.json')
}

export function getGraphBakPath(graphPath = getGraphPath()) {
  return `${graphPath}.bak`
}

export function defaultGraph(nowMs = Date.now()) {
  return TeamGraphSchema.parse({
    schema_version: 1,
    requests: [],
    updated_at: nowMs,
  })
}

// loadGraph({ graphPath?, alarm? }):
//   read-only reader. Returns { graph, source: 'primary'|'bak'|'default'|'skipped',
//   alarm: string|null }. Never throws.
//   - primary: graph.json parsed + schema_version === 1
//   - bak: graph.json corrupt or schema_version unknown → graph.json.bak fallback
//   - default: both files missing or unrecoverable → fresh defaultGraph()
//   - skipped: schema_version unknown in BOTH files → alarm + default (forward compat)
//
//   alarm: when set, caller (status.mjs / self-heal-loop.mjs) should emit a
//   visible warning. Non-crash by contract (D-W2-4).
export function loadGraph({
  graphPath = getGraphPath(),
  alarm = (msg) => { console.warn(`[graph-store] ${msg}`) },
} = {}) {
  const result = (graph, source, alarmMsg = null) => {
    if (alarmMsg) alarm(alarmMsg)
    return { graph, source, alarm: alarmMsg }
  }

  const tryParse = (file, label) => {
    if (!existsSync(file)) return { ok: false, reason: 'missing' }
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, reason: `read_error:${err.code ?? err.message}` }
    }
    let json
    try {
      json = JSON.parse(raw)
    } catch (err) {
      return { ok: false, reason: 'parse_error' }
    }
    if (json && typeof json === 'object' && json.schema_version !== 1) {
      return { ok: false, reason: `unknown_schema_version:${json.schema_version}` }
    }
    const parsed = TeamGraphSchema.safeParse(json)
    if (!parsed.success) {
      return { ok: false, reason: `schema_invalid:${parsed.error.issues[0]?.path?.join('.') ?? '?'}` }
    }
    return { ok: true, graph: parsed.data }
  }

  const primary = tryParse(graphPath, 'primary')
  if (primary.ok) return result(primary.graph, 'primary')

  const bakPath = getGraphBakPath(graphPath)
  const bak = tryParse(bakPath, 'bak')
  if (bak.ok) {
    return result(
      bak.graph,
      'bak',
      `primary load failed (${primary.reason}); recovered from ${bakPath}`,
    )
  }

  // Both unrecoverable. If primary existed but unknown schema_version, surface
  // alarm so operators see forward-compat skip (D-W2-4).
  if (primary.reason?.startsWith('unknown_schema_version')) {
    return result(
      defaultGraph(),
      'skipped',
      `graph schema_version unknown in both primary and bak (${primary.reason}); using empty graph`,
    )
  }
  if (primary.reason !== 'missing' || bak.reason !== 'missing') {
    return result(
      defaultGraph(),
      'default',
      `graph unrecoverable (primary=${primary.reason}, bak=${bak.reason}); reset to empty`,
    )
  }
  return result(defaultGraph(), 'default')
}

function writeGraphAtomic(state, graphPath) {
  const validated = TeamGraphSchema.parse({
    ...state,
    schema_version: 1,
    updated_at: Date.now(),
  })
  const dir = dirname(graphPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  // Roll existing primary → .bak before overwriting (R-W2-4 last-known-good).
  const bakPath = getGraphBakPath(graphPath)
  if (existsSync(graphPath)) {
    try {
      copyFileSync(graphPath, bakPath)
    } catch {
      // bak rotation is best-effort; primary write proceeds.
    }
  }
  const tmp = `${graphPath}.tmp.${process.pid}.${randomUUID()}`
  try {
    writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', 'utf8')
    renameSync(tmp, graphPath)
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return validated
}

// writeRequest({ from, to, request_id, deadline_at, started_at?, in_reply_to?, graphPath? }):
//   append a new pending request. Idempotent on request_id (existing entry is
//   left untouched; status/deadline are NOT re-written).
export function writeRequest({
  from,
  to,
  request_id,
  deadline_at,
  started_at = Date.now(),
  in_reply_to = null,
  graphPath = getGraphPath(),
}) {
  if (typeof from !== 'string' || from.length === 0) throw new Error('from required')
  if (typeof to !== 'string' || to.length === 0) throw new Error('to required')
  if (typeof request_id !== 'string' || request_id.length === 0) throw new Error('request_id required')
  if (!Number.isFinite(deadline_at)) throw new Error('deadline_at required (ms epoch)')
  return withLockSync(graphPath, () => {
    const { graph } = loadGraph({ graphPath })
    const existing = graph.requests.find((r) => r.request_id === request_id)
    if (existing) {
      return { ok: true, idempotent: true, entry: existing }
    }
    const entry = RequestEntrySchema.parse({
      from, to, request_id, started_at, deadline_at, in_reply_to, status: 'pending',
    })
    const next = { ...graph, requests: [...graph.requests, entry] }
    const written = writeGraphAtomic(next, graphPath)
    return { ok: true, idempotent: false, entry, graph: written }
  }, { lockfilePath: `${graphPath}.lock` })
}

// updateRequestStatus({ request_id, status, evidence?, graphPath? }):
//   transition pending → completed | expired. Returns { ok, reason?, prev?,
//   entry? }. Idempotent: same status returns ok=true with idempotent=true.
export function updateRequestStatus({
  request_id,
  status,
  evidence,
  graphPath = getGraphPath(),
}) {
  if (typeof request_id !== 'string' || request_id.length === 0) {
    return { ok: false, reason: 'request_id_required' }
  }
  if (!REQUEST_STATUS_VALUES.includes(status)) {
    return { ok: false, reason: `invalid_status:${status}` }
  }
  return withLockSync(graphPath, () => {
  const { graph } = loadGraph({ graphPath })
  const idx = graph.requests.findIndex((r) => r.request_id === request_id)
  if (idx < 0) return { ok: false, reason: 'request_not_found' }
  const prev = graph.requests[idx]
  if (prev.status === status) {
    return { ok: true, idempotent: true, entry: prev }
  }
  // Allow pending → completed | expired. completed/expired are terminal.
  if (prev.status !== 'pending') {
    return { ok: false, reason: `terminal_status:${prev.status}` }
  }
  const updated = {
    ...prev,
    status,
    ...(evidence !== undefined ? { evidence } : {}),
  }
  const next = {
    ...graph,
    requests: graph.requests.map((r, i) => (i === idx ? updated : r)),
  }
  const written = writeGraphAtomic(next, graphPath)
  return { ok: true, idempotent: false, prev, entry: updated, graph: written }
  }, { lockfilePath: `${graphPath}.lock` })
}

export function getRequest(requestId, { graphPath = getGraphPath() } = {}) {
  const { graph } = loadGraph({ graphPath })
  return graph.requests.find((r) => r.request_id === requestId) ?? null
}

export function listPending({ graphPath = getGraphPath() } = {}) {
  const { graph } = loadGraph({ graphPath })
  return graph.requests.filter((r) => r.status === 'pending')
}

export function listExpired({ graphPath = getGraphPath() } = {}) {
  const { graph } = loadGraph({ graphPath })
  return graph.requests.filter((r) => r.status === 'expired')
}

// recoverPendingOnRestart({ nowMs?, graphPath? }):
//   S4-E daemon-restart hook. Walk pending requests, mark every entry whose
//   deadline_at <= nowMs as expired (no grace, since the previous daemon
//   process is gone). Returns { expired: [...entries], total }. Caller is
//   responsible for sender notify (autonomous fallback / HITL deferral).
export function recoverPendingOnRestart({
  nowMs = Date.now(),
  graphPath = getGraphPath(),
} = {}) {
  return withLockSync(graphPath, () => {
  const { graph, source } = loadGraph({ graphPath })
  const expired = []
  let mutated = false
  const nextRequests = graph.requests.map((r) => {
    if (r.status !== 'pending') return r
    if (r.deadline_at > nowMs) return r
    mutated = true
    const e = { ...r, status: 'expired' }
    expired.push(e)
    return e
  })
  if (!mutated) return { expired: [], total: graph.requests.length, source }
  const next = { ...graph, requests: nextRequests }
  writeGraphAtomic(next, graphPath)
  return { expired, total: graph.requests.length, source }
  }, { lockfilePath: `${graphPath}.lock` })
}

// _internals: testing escape hatch (do NOT use in production code).
// W3-S2 P1-3: Safe broadcast envelope formatter (no persistence, no I/O).
// Pairs with admission.evaluateBroadcastAdmission. Caller invokes admission
// first, then formats the envelope from the admission result, then issues
// per-recipient sends + records audit via the ledger side
// (recordBroadcastIntent in ~/.claude/scripts/relvetia/ledger.mjs).
//
// Schema is intentionally simple — TeamGraphSchema is unchanged so this
// envelope is *not* persisted into team-graph.json. If a future wave needs
// persistence we'll extend the schema then.
export function formatBroadcastEnvelope({
  audit_label,
  recipients,
  fanout_limit,
  source_team = null,
  source_agent = null,
  nowMs = Date.now(),
  request_id = randomUUID(),
}) {
  if (typeof audit_label !== 'string' || audit_label.length === 0) {
    throw new Error('formatBroadcastEnvelope: audit_label required (string)')
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('formatBroadcastEnvelope: recipients required (non-empty array)')
  }
  if (!Number.isInteger(fanout_limit) || fanout_limit < 1) {
    throw new Error('formatBroadcastEnvelope: fanout_limit required (positive integer)')
  }
  return {
    kind: 'broadcast_safe',
    request_id,
    audit_label,
    source_team,
    source_agent,
    recipients: [...recipients],
    fanout_limit,
    started_at: nowMs,
  }
}

export const _internals = {
  REQUEST_STATUS_VALUES,
  writeGraphAtomic,
  defaultGraph,
}
