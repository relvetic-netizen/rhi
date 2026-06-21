import { describe, it, expect } from 'vitest'
import {
  normalizeNumericIds,
  mergeMappings,
  type IdMapping,
} from '../../extracted/memory/normalizeNumericIds.js'
import type {
  ResidualEntry,
  ResidualIndex,
} from '../../extracted/memory/residualIndex.js'

function makeEntry(overrides: Partial<ResidualEntry> = {}): ResidualEntry {
  return {
    id: overrides.id ?? 'x_1',
    topic: overrides.topic ?? 'tooling',
    summary: overrides.summary ?? 'summary',
    sources: overrides.sources ?? [],
    concepts: overrides.concepts ?? [],
    updated: overrides.updated ?? '2026-05-19',
    confidence: overrides.confidence ?? 1,
  }
}

function makeIndex(entries: Record<string, ResidualEntry>): ResidualIndex {
  return { version: 1, entries }
}

describe('normalizeNumericIds', () => {
  it('is a no-op on an empty index', () => {
    const idx = makeIndex({})
    const { index, mapping } = normalizeNumericIds(idx)
    expect(index).toBe(idx) // same reference — no work
    expect(mapping).toEqual([])
  })

  it('is a no-op when no numeric ids exist', () => {
    const idx = makeIndex({
      arch_001: makeEntry({ id: 'arch_001', topic: 'architecture' }),
      pref_007: makeEntry({ id: 'pref_007', topic: 'preferences' }),
    })
    const { index, mapping } = normalizeNumericIds(idx)
    expect(index).toBe(idx)
    expect(mapping).toEqual([])
  })

  it('rewrites a flat-topic numeric id using the 4-char prefix counter', () => {
    const idx = makeIndex({
      '114': makeEntry({
        id: '114',
        topic: 'troubleshooting-relvetia',
        summary: 'WAVE2_CUTOFF_MS fallback drift',
      }),
    })
    const { index, mapping } = normalizeNumericIds(idx)

    expect(Object.keys(index.entries)).toEqual(['trou_001'])
    expect(index.entries.trou_001.id).toBe('trou_001')
    expect(index.entries.trou_001.topic).toBe('troubleshooting-relvetia')
    expect(index.entries.trou_001.summary).toBe('WAVE2_CUTOFF_MS fallback drift')
    expect(mapping).toEqual([
      {
        oldId: '114',
        newId: 'trou_001',
        topic: 'troubleshooting-relvetia',
        updated: '2026-05-19',
      },
    ])
  })

  it('rewrites a hierarchical-topic numeric id using the slug-safe prefix', () => {
    const idx = makeIndex({
      '111': makeEntry({
        id: '111',
        topic: 'architecture/d10-duplicate-worker',
      }),
    })
    const { index, mapping } = normalizeNumericIds(idx)

    // generateEntryId: lowercase, [^a-z0-9]+ → '_', slice(0,16)
    //   architecture_d10_duplicate_worker → slice(0,16) → 'architecture_d10'
    expect(Object.keys(index.entries)).toEqual(['architecture_d10_001'])
    expect(mapping[0]).toMatchObject({
      oldId: '111',
      newId: 'architecture_d10_001',
      topic: 'architecture/d10-duplicate-worker',
    })
  })

  it('does not collide with existing hier-prefix counters when assigning new ids', () => {
    const idx = makeIndex({
      architecture_d10_001: makeEntry({
        id: 'architecture_d10_001',
        topic: 'architecture/d10-duplicate-worker',
      }),
      '111': makeEntry({
        id: '111',
        topic: 'architecture/d10-duplicate-worker',
      }),
    })
    const { index, mapping } = normalizeNumericIds(idx)

    const newKeys = Object.keys(index.entries).sort()
    expect(newKeys).toEqual(['architecture_d10_001', 'architecture_d10_002'])
    expect(mapping).toEqual([
      {
        oldId: '111',
        newId: 'architecture_d10_002',
        topic: 'architecture/d10-duplicate-worker',
        updated: '2026-05-19',
      },
    ])
  })

  it('assigns sequential counters when multiple numeric ids share one topic', () => {
    const idx = makeIndex({
      '113': makeEntry({ id: '113', topic: 'project-context/sprint' }),
      '115': makeEntry({ id: '115', topic: 'project-context/sprint' }),
      '117': makeEntry({ id: '117', topic: 'project-context/sprint' }),
    })
    const { index, mapping } = normalizeNumericIds(idx)

    // generateEntryId behavior: slice(0,16) is applied AFTER the trim, so
    // `project_context_sprint` → slice(0,16) → `project_context_` (trailing
    // underscore preserved). The double-underscore in the final id is a
    // by-product of that existing contract; Phase A is normalize-only and
    // does NOT refactor generateEntryId (Karpathy surgical-changes).
    expect(Object.keys(index.entries).sort()).toEqual([
      'project_context__001',
      'project_context__002',
      'project_context__003',
    ])
    expect(mapping.map((m) => m.oldId)).toEqual(['113', '115', '117'])
    expect(mapping.map((m) => m.newId)).toEqual([
      'project_context__001',
      'project_context__002',
      'project_context__003',
    ])
  })

  it('falls back to "entry" prefix when topic is empty / pathological', () => {
    const idx = makeIndex({
      '999': makeEntry({ id: '999', topic: '///' }),
    })
    const { index, mapping } = normalizeNumericIds(idx)
    expect(Object.keys(index.entries)).toEqual(['entry_001'])
    expect(mapping[0].newId).toBe('entry_001')
  })

  it('preserves the original input index (immutability)', () => {
    const idx = makeIndex({
      '110': makeEntry({ id: '110', topic: 'architecture/x' }),
      keep: makeEntry({ id: 'keep', topic: 'tooling' }),
    })
    const before = JSON.stringify(idx)
    normalizeNumericIds(idx)
    expect(JSON.stringify(idx)).toBe(before)
  })

  it('handles realistic 8-entry production batch (110-117) without collisions', () => {
    const idx = makeIndex({
      '110': makeEntry({ id: '110', topic: 'project-context/team-context-p1-saga' }),
      '111': makeEntry({ id: '111', topic: 'architecture/d10-duplicate-worker' }),
      '112': makeEntry({ id: '112', topic: 'project-context/pr43-native-cutover' }),
      '113': makeEntry({ id: '113', topic: 'project-context/memory-hardening-sprint' }),
      '114': makeEntry({ id: '114', topic: 'troubleshooting-relvetia' }),
      '115': makeEntry({ id: '115', topic: 'troubleshooting-windows' }),
      '116': makeEntry({ id: '116', topic: 'project-creative' }),
      '117': makeEntry({ id: '117', topic: 'self/growth-log' }),
    })
    const { index, mapping } = normalizeNumericIds(idx)

    expect(mapping).toHaveLength(8)
    expect(Object.keys(index.entries)).toHaveLength(8)
    // No id collisions.
    const newIds = mapping.map((m) => m.newId)
    expect(new Set(newIds).size).toBe(newIds.length)
    // No numeric ids remain.
    expect(Object.keys(index.entries).every((k) => !/^\d+$/.test(k))).toBe(true)
  })
})

describe('mergeMappings', () => {
  const a: IdMapping = { oldId: '110', newId: 'foo_001', topic: 't1', updated: '' }
  const b: IdMapping = { oldId: '111', newId: 'foo_002', topic: 't1', updated: '' }
  const c: IdMapping = { oldId: '112', newId: 'foo_003', topic: 't1', updated: '' }

  it('returns the union sorted by numeric oldId', () => {
    const merged = mergeMappings([a, c], [b])
    expect(merged.map((m) => m.oldId)).toEqual(['110', '111', '112'])
  })

  it('latest wins for duplicate oldId', () => {
    const updatedA: IdMapping = { ...a, newId: 'foo_999' }
    const merged = mergeMappings([a, b], [updatedA])
    const ax = merged.find((m) => m.oldId === '110')
    expect(ax?.newId).toBe('foo_999')
  })

  it('sorts non-numeric oldIds lexicographically and after numeric ones', () => {
    const namedX: IdMapping = { oldId: 'xx', newId: 'arch_001', topic: 't', updated: '' }
    const merged = mergeMappings([a], [namedX])
    expect(merged.map((m) => m.oldId)).toEqual(['110', 'xx'])
  })

  it('returns empty when both inputs are empty', () => {
    expect(mergeMappings([], [])).toEqual([])
  })
})
