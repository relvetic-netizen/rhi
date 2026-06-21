// W2-S4 S4-C — passthrough() forward compatibility tests (Pi SC-1 mitigation,
//   D-W2-4). Future Wave 3 may add new top-level / per-request fields. The
//   reader must preserve them, not strip them, so a new daemon doesn't lose
//   data written by an older daemon (or vice versa).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  writeRequest,
  loadGraph,
  TeamGraphSchema,
  RequestEntrySchema,
} from '../graph-store.js'

let tmpRoot
let graphPath

before(() => { tmpRoot = mkdtempSync(join(tmpdir(), 'graph-passthrough-')) })
after(() => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {} })
beforeEach(() => {
  graphPath = join(tmpRoot, `graph-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
})

describe('graph-passthrough — top-level forward compat', () => {
  it('loadGraph preserves unknown top-level fields when reading existing file', () => {
    const seeded = {
      schema_version: 1,
      requests: [],
      updated_at: 1700000000000,
      experimental_metrics: { count: 7 },  // future Wave 3 field
    }
    writeFileSync(graphPath, JSON.stringify(seeded), 'utf8')
    const r = loadGraph({ graphPath, alarm: () => {} })
    assert.equal(r.source, 'primary')
    assert.deepEqual(r.graph.experimental_metrics, { count: 7 })
  })

  it('subsequent writeRequest preserves unknown top-level fields (round-trip)', () => {
    const seeded = {
      schema_version: 1, requests: [], updated_at: 1, future_field: 'wave3-data',
    }
    writeFileSync(graphPath, JSON.stringify(seeded), 'utf8')
    writeRequest({ from: 'a', to: 'b', request_id: 'r1', started_at: 1, deadline_at: 9, graphPath })
    const persisted = JSON.parse(readFileSync(graphPath, 'utf8'))
    assert.equal(persisted.future_field, 'wave3-data')
    assert.equal(persisted.requests.length, 1)
  })
})

describe('graph-passthrough — per-request forward compat', () => {
  it('preserves unknown fields on existing request entries through round-trip writes', () => {
    const seeded = {
      schema_version: 1,
      requests: [{
        from: 'a', to: 'b', request_id: 'r1',
        started_at: 1, deadline_at: 9, status: 'pending',
        // Future Wave 3 trace field
        trace_metadata: { span_id: 'sp-001', parent_span_id: null },
      }],
      updated_at: 1,
    }
    writeFileSync(graphPath, JSON.stringify(seeded), 'utf8')
    // Add a new entry — earlier entry's trace_metadata must survive.
    writeRequest({ from: 'a', to: 'b', request_id: 'r2', started_at: 1, deadline_at: 9, graphPath })
    const persisted = JSON.parse(readFileSync(graphPath, 'utf8'))
    const r1 = persisted.requests.find((e) => e.request_id === 'r1')
    assert.deepEqual(r1.trace_metadata, { span_id: 'sp-001', parent_span_id: null })
  })

  it('Schemas reject malformed status enum even with passthrough', () => {
    const r = RequestEntrySchema.safeParse({
      from: 'a', to: 'b', request_id: 'r1',
      started_at: 1, deadline_at: 2, status: 'WeirdStatus',
    })
    assert.equal(r.success, false)
  })

  it('Schemas reject missing required fields even with passthrough', () => {
    const r = RequestEntrySchema.safeParse({
      from: 'a', to: 'b', // missing request_id
      started_at: 1, deadline_at: 2, status: 'pending',
    })
    assert.equal(r.success, false)
  })
})

describe('graph-passthrough — schema_version unknown handling', () => {
  it('alarm fires (single source) when schema_version is unknown and no .bak', () => {
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 7, requests: [], updated_at: 0,
    }), 'utf8')
    const alarms = []
    const r = loadGraph({ graphPath, alarm: (m) => alarms.push(m) })
    assert.equal(r.source, 'skipped')
    assert.equal(alarms.length, 1)
    assert.match(alarms[0], /schema_version unknown/)
  })

  it('does NOT throw — caller stays alive (forward compat contract)', () => {
    writeFileSync(graphPath, JSON.stringify({
      schema_version: 'v2-string', requests: [], updated_at: 0,
    }), 'utf8')
    assert.doesNotThrow(() => loadGraph({ graphPath, alarm: () => {} }))
  })
})
