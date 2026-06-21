// W2-S4 S4-A + S4-B + S4-C unit tests for graph-store.js.
//   Covers writeRequest / updateRequestStatus / getRequest / listPending /
//   listExpired / loadGraph + atomic tmp+rename + .bak fallback + idempotency.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

import {
  writeRequest,
  updateRequestStatus,
  getRequest,
  listPending,
  listExpired,
  loadGraph,
  defaultGraph,
  recoverPendingOnRestart,
  RequestEntrySchema,
  TeamGraphSchema,
  getGraphBakPath,
  _internals,
} from '../graph-store.js'

let tmpRoot
let graphPath

function newGraphPath() {
  return join(tmpRoot, `team-graph-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
}

function runGraphWriter({ graphPath, requestId, to }) {
  const code = `
import { writeRequest } from './src/graph-store.js'
writeRequest({
  from: 'concurrent-writer',
  to: process.env.GRAPH_TO,
  request_id: process.env.GRAPH_REQUEST_ID,
  started_at: 1,
  deadline_at: 9,
})
`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RELVETIA_TEAM_GRAPH_PATH: graphPath,
        GRAPH_REQUEST_ID: requestId,
        GRAPH_TO: to,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`writer ${requestId} exited ${code}: ${stderr}`))
    })
  })
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'graph-store-test-'))
})

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  graphPath = newGraphPath()
})

describe('graph-store — defaultGraph + Schema', () => {
  it('defaultGraph returns valid empty graph', () => {
    const g = defaultGraph()
    assert.equal(g.schema_version, 1)
    assert.deepEqual(g.requests, [])
    assert.equal(typeof g.updated_at, 'number')
  })

  it('TeamGraphSchema rejects schema_version != 1', () => {
    const r = TeamGraphSchema.safeParse({ schema_version: 2, requests: [], updated_at: 1 })
    assert.equal(r.success, false)
  })

  it('TeamGraphSchema passthrough preserves unknown top-level fields', () => {
    const parsed = TeamGraphSchema.parse({
      schema_version: 1, requests: [], updated_at: 1, future_field: { v: 'wave3' },
    })
    assert.deepEqual(parsed.future_field, { v: 'wave3' })
  })

  it('RequestEntrySchema enforces lowercase status enum', () => {
    const ok = RequestEntrySchema.safeParse({
      from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, status: 'pending',
    })
    assert.equal(ok.success, true)
    const bad = RequestEntrySchema.safeParse({
      from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, status: 'Pending',
    })
    assert.equal(bad.success, false)
  })

  it('RequestEntrySchema passthrough preserves unknown fields (forward compat)', () => {
    const e = RequestEntrySchema.parse({
      from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2,
      status: 'pending', metadata: { trace_id: 't1' },
    })
    assert.deepEqual(e.metadata, { trace_id: 't1' })
  })
})

describe('graph-store — loadGraph fallback chain', () => {
  it('returns default when no file exists', () => {
    const r = loadGraph({ graphPath, alarm: () => {} })
    assert.equal(r.source, 'default')
    assert.equal(r.graph.schema_version, 1)
    assert.equal(r.alarm, null)
  })

  it('reads primary on healthy file', () => {
    writeRequest({
      from: 'team-a', to: 'team-b', request_id: 'r1',
      started_at: 1, deadline_at: 2, graphPath,
    })
    const r = loadGraph({ graphPath, alarm: () => {} })
    assert.equal(r.source, 'primary')
    assert.equal(r.graph.requests.length, 1)
  })

  it('falls back to .bak when primary is corrupt JSON (R-W2-4)', () => {
    writeRequest({
      from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, graphPath,
    })
    // second write rotates first into .bak
    writeRequest({
      from: 'a', to: 'b', request_id: 'r2', started_at: 1, deadline_at: 2, graphPath,
    })
    // corrupt primary
    writeFileSync(graphPath, '{bad json', 'utf8')
    let alarmed = null
    const r = loadGraph({ graphPath, alarm: (m) => { alarmed = m } })
    assert.equal(r.source, 'bak')
    // .bak holds the snapshot from BEFORE the second writeRequest, so r1 only.
    assert.equal(r.graph.requests.length, 1)
    assert.equal(r.graph.requests[0].request_id, 'r1')
    assert.match(alarmed ?? '', /recovered from/)
  })

  it('returns default + alarm when schema_version unknown in primary and .bak is missing', () => {
    writeFileSync(graphPath, JSON.stringify({ schema_version: 99, requests: [], updated_at: 0 }), 'utf8')
    let alarmed = null
    const r = loadGraph({ graphPath, alarm: (m) => { alarmed = m } })
    assert.equal(r.source, 'skipped')
    assert.equal(r.graph.requests.length, 0)
    assert.match(alarmed ?? '', /schema_version unknown/)
  })

  it('returns default when both primary and .bak are corrupt', () => {
    writeFileSync(graphPath, '{bad', 'utf8')
    writeFileSync(getGraphBakPath(graphPath), 'also bad', 'utf8')
    let alarmed = null
    const r = loadGraph({ graphPath, alarm: (m) => { alarmed = m } })
    assert.equal(r.source, 'default')
    assert.match(alarmed ?? '', /unrecoverable/)
  })

  it('alarm callback is silent when nothing is wrong', () => {
    let invoked = false
    loadGraph({ graphPath, alarm: () => { invoked = true } })
    assert.equal(invoked, false)
  })
})

describe('graph-store — writeRequest', () => {
  it('appends a new pending entry', () => {
    const r = writeRequest({
      from: 'a', to: 'b', request_id: 'r1', started_at: 100, deadline_at: 200, graphPath,
    })
    assert.equal(r.ok, true)
    assert.equal(r.idempotent, false)
    assert.equal(r.entry.status, 'pending')
    assert.equal(r.entry.in_reply_to, null)
  })

  it('idempotent on duplicate request_id (no overwrite)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    const r = writeRequest({
      from: 'X', to: 'Y', request_id: 'r1',  // different from/to
      started_at: 999, deadline_at: 9999, graphPath,
    })
    assert.equal(r.ok, true)
    assert.equal(r.idempotent, true)
    // existing entry retained as-is
    assert.equal(r.entry.from, 'a')
    assert.equal(r.entry.to, 'b')
    assert.equal(r.entry.deadline_at, 9)
  })

  it('persists via atomic tmp+rename — no temp file leftover', () => {
    writeRequest({
      from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, graphPath,
    })
    const dir = dirname(graphPath)
    const stragglers = readdirSync(dir).filter((f) =>
      f.startsWith(basename(graphPath) + '.tmp.'),
    )
    assert.equal(stragglers.length, 0)
  })

  it('rolls primary into .bak before overwriting', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    // No .bak yet — first write only created primary
    assert.equal(existsSync(getGraphBakPath(graphPath)), false)
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 1, deadline_at: 9, graphPath })
    assert.equal(existsSync(getGraphBakPath(graphPath)), true)
    const bak = JSON.parse(readFileSync(getGraphBakPath(graphPath), 'utf8'))
    assert.equal(bak.requests.length, 1)
    assert.equal(bak.requests[0].request_id, 'r1')
  })

  it('rejects missing required args', () => {
    assert.throws(() => writeRequest({ from: '', to: 'b', request_id: 'r', deadline_at: 1, graphPath }))
    assert.throws(() => writeRequest({ from: 'a', to: '', request_id: 'r', deadline_at: 1, graphPath }))
    assert.throws(() => writeRequest({ from: 'a', to: 'b', request_id: '', deadline_at: 1, graphPath }))
    assert.throws(() => writeRequest({ from: 'a', to: 'b', request_id: 'r', deadline_at: NaN, graphPath }))
  })

  it('accepts optional in_reply_to', () => {
    const r = writeRequest({
      from: 'a', to: 'b', request_id: 'r1',
      started_at: 1, deadline_at: 2, in_reply_to: 'orig-req',
      graphPath,
    })
    assert.equal(r.entry.in_reply_to, 'orig-req')
  })

  it('preserves concurrent cross-process writes under the graph lock', async () => {
    await Promise.all([
      runGraphWriter({ graphPath, requestId: 'r-concurrent-1', to: 'b1' }),
      runGraphWriter({ graphPath, requestId: 'r-concurrent-2', to: 'b2' }),
    ])

    const { graph } = loadGraph({ graphPath, alarm: () => {} })
    const ids = graph.requests.map(r => r.request_id).sort()
    assert.deepEqual(ids, ['r-concurrent-1', 'r-concurrent-2'])
  })
})

describe('graph-store — updateRequestStatus', () => {
  it('transitions pending → completed', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    const r = updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    assert.equal(r.ok, true)
    assert.equal(r.idempotent, false)
    assert.equal(r.prev.status, 'pending')
    assert.equal(r.entry.status, 'completed')
  })

  it('transitions pending → expired with evidence', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    const r = updateRequestStatus({
      request_id: 'r1', status: 'expired',
      evidence: { reason: 'deadline_passed', notified: true },
      graphPath,
    })
    assert.equal(r.ok, true)
    assert.equal(r.entry.status, 'expired')
    assert.deepEqual(r.entry.evidence, { reason: 'deadline_passed', notified: true })
  })

  it('idempotent on same status', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    const again = updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    assert.equal(again.ok, true)
    assert.equal(again.idempotent, true)
  })

  it('rejects transition from terminal status (completed → expired)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    const r = updateRequestStatus({ request_id: 'r1', status: 'expired', graphPath })
    assert.equal(r.ok, false)
    assert.match(r.reason, /terminal_status/)
  })

  it('returns request_not_found for unknown id', () => {
    const r = updateRequestStatus({ request_id: 'never', status: 'completed', graphPath })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'request_not_found')
  })

  it('rejects invalid status enum', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    const r = updateRequestStatus({ request_id: 'r1', status: 'Pending', graphPath })
    assert.equal(r.ok, false)
    assert.match(r.reason, /invalid_status/)
  })

  it('rejects empty request_id', () => {
    const r = updateRequestStatus({ request_id: '', status: 'completed', graphPath })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'request_id_required')
  })
})

describe('graph-store — getRequest / listPending / listExpired', () => {
  beforeEach(() => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    writeRequest({ from: 'a', to: 'c', request_id: 'r2', started_at: 1, deadline_at: 9, graphPath })
    writeRequest({ from: 'a', to: 'd', request_id: 'r3', started_at: 1, deadline_at: 9, graphPath })
    updateRequestStatus({ request_id: 'r2', status: 'completed', graphPath })
    updateRequestStatus({ request_id: 'r3', status: 'expired', graphPath })
  })

  it('getRequest returns entry by id', () => {
    const e = getRequest('r1', { graphPath })
    assert.equal(e?.request_id, 'r1')
  })

  it('getRequest returns null for unknown id', () => {
    const e = getRequest('never', { graphPath })
    assert.equal(e, null)
  })

  it('listPending returns only pending entries', () => {
    const arr = listPending({ graphPath })
    assert.equal(arr.length, 1)
    assert.equal(arr[0].request_id, 'r1')
  })

  it('listExpired returns only expired entries', () => {
    const arr = listExpired({ graphPath })
    assert.equal(arr.length, 1)
    assert.equal(arr[0].request_id, 'r3')
  })
})

describe('graph-store — atomic write contract', () => {
  it('updated_at increases monotonically across writes', async () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, graphPath })
    const t1 = JSON.parse(readFileSync(graphPath, 'utf8')).updated_at
    // small delay so Date.now() advances at least 1ms
    await new Promise((r) => setTimeout(r, 5))
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 1, deadline_at: 2, graphPath })
    const t2 = JSON.parse(readFileSync(graphPath, 'utf8')).updated_at
    assert.ok(t2 >= t1)
  })

  it('writeGraphAtomic normalizes schema_version to 1 (writer-enforced contract)', () => {
    // single-writer contract: even if a bogus schema_version slips in upstream,
    // the writer normalizes it to 1 before persisting (D-W2-4).
    _internals.writeGraphAtomic(
      { schema_version: 2, requests: [], updated_at: 0 },
      graphPath,
    )
    const persisted = JSON.parse(readFileSync(graphPath, 'utf8'))
    assert.equal(persisted.schema_version, 1)
  })

  it('failed write does NOT corrupt primary (kept previous valid graph)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    // Force schema validation failure by injecting a bogus state via internals.
    assert.throws(() => _internals.writeGraphAtomic(
      { schema_version: 1, requests: [{ /* missing required fields */ }], updated_at: 0 },
      graphPath,
    ))
    // Primary untouched
    const r = loadGraph({ graphPath, alarm: () => {} })
    assert.equal(r.source, 'primary')
    assert.equal(r.graph.requests[0].request_id, 'r1')
  })

  it('handles a graph with many entries (smoke)', () => {
    for (let i = 0; i < 50; i += 1) {
      writeRequest({
        from: 'a', to: `b-${i}`, request_id: `r-${i}`,
        started_at: i, deadline_at: i + 1000, graphPath,
      })
    }
    const r = loadGraph({ graphPath, alarm: () => {} })
    assert.equal(r.graph.requests.length, 50)
    assert.equal(r.graph.requests[10].request_id, 'r-10')
  })

  it('listPending and listExpired do not mutate underlying graph', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 2, graphPath })
    const before = listPending({ graphPath })
    before.push({ tampered: true })
    const after = listPending({ graphPath })
    assert.equal(after.length, 1)
    assert.equal(after[0].tampered, undefined)
  })
})

describe('graph-store — recoverPendingOnRestart (S4-E)', () => {
  it('expires every pending entry whose deadline_at <= nowMs (no grace)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 100, deadline_at: 200, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 100, deadline_at: 500, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'r3', started_at: 100, deadline_at: 1000, graphPath })
    const r = recoverPendingOnRestart({ nowMs: 600, graphPath })
    assert.equal(r.expired.length, 2)
    const ids = r.expired.map((e) => e.request_id).sort()
    assert.deepEqual(ids, ['r1', 'r2'])
    assert.equal(r.total, 3)
    assert.equal(getRequest('r1', { graphPath }).status, 'expired')
    assert.equal(getRequest('r2', { graphPath }).status, 'expired')
    assert.equal(getRequest('r3', { graphPath }).status, 'pending')
  })

  it('no-op when no pending entries are past deadline', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 100, deadline_at: 1000, graphPath })
    const r = recoverPendingOnRestart({ nowMs: 500, graphPath })
    assert.equal(r.expired.length, 0)
    assert.equal(r.total, 1)
    assert.equal(getRequest('r1', { graphPath }).status, 'pending')
  })

  it('skips already terminal entries', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    const r = recoverPendingOnRestart({ nowMs: 9999, graphPath })
    assert.equal(r.expired.length, 0)
    assert.equal(getRequest('r1', { graphPath }).status, 'completed')
  })

  it('returns source=default when graph file missing', () => {
    const r = recoverPendingOnRestart({ nowMs: 0, graphPath })
    assert.equal(r.expired.length, 0)
    assert.equal(r.total, 0)
    assert.equal(r.source, 'default')
  })
})
