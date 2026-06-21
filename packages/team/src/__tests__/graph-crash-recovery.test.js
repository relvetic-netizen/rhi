// W2-S4 S4-E daemon-restart crash recovery — focused tests for the path
//   the relvetia-team daemon takes on cold start: load + walk pending + expire
//   anything past deadline (no grace, daemon was gone).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  writeRequest,
  updateRequestStatus,
  recoverPendingOnRestart,
  loadGraph,
  getGraphBakPath,
  getRequest,
  listPending,
  listExpired,
} from '../graph-store.js'

let tmpRoot
let graphPath

before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'graph-crash-recovery-')) })
after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {} })
beforeEach(() => {
  graphPath = join(tmpRoot, `team-graph-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
})

describe('S4-E daemon restart crash recovery — happy paths', () => {
  it('expires past-deadline pendings + leaves future ones intact', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'p1', started_at: 0, deadline_at: 100, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'p2', started_at: 0, deadline_at: 200, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'p3', started_at: 0, deadline_at: 300, graphPath })

    // simulate restart at t=200 (p1, p2 deadlines past; p3 still alive)
    const r = recoverPendingOnRestart({ nowMs: 200, graphPath })
    assert.equal(r.expired.length, 2)
    const expiredIds = r.expired.map((e) => e.request_id).sort()
    assert.deepEqual(expiredIds, ['p1', 'p2'])
    assert.equal(getRequest('p3', { graphPath }).status, 'pending')
  })

  it('records expired entries in graph (so a second restart sees no new expirations)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'p1', started_at: 0, deadline_at: 50, graphPath })
    recoverPendingOnRestart({ nowMs: 999, graphPath })
    const second = recoverPendingOnRestart({ nowMs: 9999, graphPath })
    assert.equal(second.expired.length, 0)
    assert.equal(getRequest('p1', { graphPath }).status, 'expired')
  })

  it('preserves completed/expired entries already in graph', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'done', started_at: 0, deadline_at: 50, graphPath })
    updateRequestStatus({ request_id: 'done', status: 'completed', graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'pendnew', started_at: 0, deadline_at: 50, graphPath })

    const r = recoverPendingOnRestart({ nowMs: 999, graphPath })
    assert.equal(r.expired.length, 1)
    assert.equal(r.expired[0].request_id, 'pendnew')
    assert.equal(getRequest('done', { graphPath }).status, 'completed')
  })

  it('reports total request count including all statuses', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 0, deadline_at: 50, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 0, deadline_at: 50, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'r3', started_at: 0, deadline_at: 5000, graphPath })
    const r = recoverPendingOnRestart({ nowMs: 999, graphPath })
    assert.equal(r.total, 3)
  })
})

describe('S4-E crash recovery — degraded fixtures', () => {
  it('reads through .bak when primary is corrupt and still expires deadlines', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 0, deadline_at: 50, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 0, deadline_at: 50, graphPath })
    // Corrupt primary, .bak still holds [r1] (post first writeRequest, before second).
    writeFileSync(graphPath, '{not-json', 'utf8')

    const r = recoverPendingOnRestart({ nowMs: 999, graphPath })
    assert.equal(r.source, 'bak')
    // .bak contained r1 (snapshot from first write), so only r1 is expired.
    assert.equal(r.expired.length, 1)
    assert.equal(r.expired[0].request_id, 'r1')
  })

  it('returns empty result + default source when nothing exists', () => {
    const r = recoverPendingOnRestart({ nowMs: 0, graphPath })
    assert.equal(r.expired.length, 0)
    assert.equal(r.total, 0)
    assert.equal(r.source, 'default')
  })

  it('skips schema_version unknown (forward compat) without crash', () => {
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 99, requests: [], updated_at: 0,
    }), 'utf8')
    const r = recoverPendingOnRestart({ nowMs: 999, graphPath })
    // Loaded as default (schema unknown ⇒ skipped/empty), no entries to expire.
    assert.equal(r.expired.length, 0)
  })
})

describe('S4-E crash recovery — multi-tenant scenarios', () => {
  it('handles mix of past, present, future deadlines (boundary conditions)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'past1', started_at: 0, deadline_at: 100, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'past2', started_at: 0, deadline_at: 199, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'present', started_at: 0, deadline_at: 200, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'future', started_at: 0, deadline_at: 300, graphPath })

    // recover at exactly t=200 — past1 + past2 should expire (deadline_at <= 200),
    // present should expire too (deadline_at == 200 hits the inclusive boundary),
    // future stays.
    const r = recoverPendingOnRestart({ nowMs: 200, graphPath })
    const ids = r.expired.map((e) => e.request_id).sort()
    assert.deepEqual(ids, ['past1', 'past2', 'present'])
    assert.equal(getRequest('future', { graphPath }).status, 'pending')
  })

  it('preserves all unrelated graph fields during recovery', () => {
    // Seed graph with an unknown forward-compat top-level field
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 1,
      requests: [{
        from: 'a', to: 'b', request_id: 'p1',
        started_at: 0, deadline_at: 50, status: 'pending',
        wave3_metadata: { trace: 'tr-001' },
      }],
      updated_at: 1,
      future_observability: { live: true },
    }), 'utf8')

    recoverPendingOnRestart({ nowMs: 999, graphPath })
    const persisted = JSON.parse(readFileSync(graphPath, 'utf8'))
    assert.deepEqual(persisted.future_observability, { live: true })
    assert.deepEqual(
      persisted.requests.find((e) => e.request_id === 'p1').wave3_metadata,
      { trace: 'tr-001' },
    )
  })

  it('supports recovering when graph contains no pending entries (clean shutdown case)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 0, deadline_at: 50, graphPath })
    updateRequestStatus({ request_id: 'r1', status: 'completed', graphPath })
    const r = recoverPendingOnRestart({ nowMs: 9999, graphPath })
    assert.equal(r.expired.length, 0)
    assert.equal(r.total, 1)
  })

  it('atomic write idempotency — running recovery twice is safe', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'p1', started_at: 0, deadline_at: 50, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'p2', started_at: 0, deadline_at: 50, graphPath })
    const r1 = recoverPendingOnRestart({ nowMs: 999, graphPath })
    const r2 = recoverPendingOnRestart({ nowMs: 999, graphPath })
    assert.equal(r1.expired.length, 2)
    assert.equal(r2.expired.length, 0)
    // graph state stable
    const final = loadGraph({ graphPath, alarm: () => {} })
    const expired = final.graph.requests.filter((r) => r.status === 'expired')
    assert.equal(expired.length, 2)
  })
})

describe('S4-E crash recovery — interaction with running daemon (idempotent)', () => {
  it('safe to call recoverPendingOnRestart twice in succession (idempotent)', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'p1', started_at: 0, deadline_at: 50, graphPath })
    const a = recoverPendingOnRestart({ nowMs: 999, graphPath })
    const b = recoverPendingOnRestart({ nowMs: 999, graphPath })
    assert.equal(a.expired.length, 1)
    assert.equal(b.expired.length, 0)
    assert.equal(getRequest('p1', { graphPath }).status, 'expired')
  })

  it('caller can use listPending afterwards to verify nothing pending past deadline', () => {
    writeRequest({ from: 'a', to: 'b', request_id: 'p1', started_at: 0, deadline_at: 50, graphPath })
    writeRequest({ from: 'a', to: 'b', request_id: 'p2', started_at: 0, deadline_at: 5000, graphPath })
    recoverPendingOnRestart({ nowMs: 999, graphPath })
    const pending = listPending({ graphPath })
    const expired = listExpired({ graphPath })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].request_id, 'p2')
    assert.equal(expired.length, 1)
    assert.equal(expired[0].request_id, 'p1')
  })
})

describe('S4-E startup wiring', () => {
  it('invokes graph crash recovery exactly once on startup', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.js'), 'utf8')
    const importedCalls = source.match(/\brecoverGraphPendingOnRestart\(\)/g) ?? []
    const dynamicCalls = source.match(/\brecoverPendingOnRestart\(\)/g) ?? []
    assert.equal(importedCalls.length + dynamicCalls.length, 1)
  })
})
