import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readResidualIndex,
  writeResidualIndex,
  type ResidualEntry,
} from '../../extracted/memory/residualIndex.js'

function makeEntry(overrides: Partial<ResidualEntry> = {}): ResidualEntry {
  return {
    id: overrides.id ?? 't_1',
    topic: overrides.topic ?? 'tool',
    summary: overrides.summary ?? 'entry',
    sources: overrides.sources ?? [],
    concepts: overrides.concepts ?? [],
    updated: overrides.updated ?? '2026-04-21',
    confidence: overrides.confidence ?? 1,
  }
}

// ---------------------------------------------------------------------------
// readResidualIndex — schema drift handling
// ---------------------------------------------------------------------------

describe('readResidualIndex', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-index-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty index when file does not exist', async () => {
    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries)).toEqual([])
    expect(idx.version).toBe(1)
  })

  it('returns empty index when file is malformed JSON', async () => {
    await writeFile(join(dir, 'index.json'), 'not json {{{')
    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries)).toEqual([])
  })

  it('reads canonical schema format (object with .entries)', async () => {
    const canonical = {
      version: 1,
      entries: {
        a_1: makeEntry({ id: 'a_1' }),
        b_2: makeEntry({ id: 'b_2' }),
      },
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(canonical))

    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries).sort()).toEqual(['a_1', 'b_2'])
    expect(idx.entries.a_1.id).toBe('a_1')
  })

  it('applies score to confidence fallback without overwriting confidence', async () => {
    const canonical = {
      version: 1,
      entries: {
        legacy: {
          id: 'legacy',
          topic: 'preferences',
          summary: 'legacy score only',
          sources: [],
          concepts: [],
          updated: '2026-05-17',
          score: 0.7,
        },
        current: makeEntry({ id: 'current', confidence: 0.8 }),
        both: {
          ...makeEntry({ id: 'both', confidence: 0.9 }),
          score: 0.5,
        },
      },
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(canonical))

    const idx = await readResidualIndex(dir)
    expect(idx.entries.legacy.confidence).toBe(0.7)
    expect((idx.entries.legacy as ResidualEntry & { score?: number }).score).toBe(0.7)
    expect(idx.entries.current.confidence).toBe(0.8)
    expect(idx.entries.both.confidence).toBe(0.9)
    expect((idx.entries.both as ResidualEntry & { score?: number }).score).toBe(0.5)
  })

  it('reads legacy array format and normalizes to schema format', async () => {
    const legacy = [
      makeEntry({ id: 'legacy_1', topic: 'tooling' }),
      makeEntry({ id: 'legacy_2', topic: 'pref' }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(legacy))

    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries).sort()).toEqual(['legacy_1', 'legacy_2'])
    expect(idx.entries.legacy_1.topic).toBe('tooling')
    expect(idx.entries.legacy_2.topic).toBe('pref')
  })

  it('skips entries in legacy array that lack an id', async () => {
    const mixed = [
      makeEntry({ id: 'valid' }),
      { summary: 'no id', topic: 'x' }, // invalid
      null,
      makeEntry({ id: 'also_valid' }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(mixed))

    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries).sort()).toEqual(['also_valid', 'valid'])
  })

  it('defaults version to 1 when reading legacy array', async () => {
    await writeFile(join(dir, 'index.json'), JSON.stringify([makeEntry()]))
    const idx = await readResidualIndex(dir)
    expect(idx.version).toBe(1)
  })

  it('preserves version from canonical format', async () => {
    await writeFile(
      join(dir, 'index.json'),
      JSON.stringify({ version: 7, entries: {} }),
    )
    const idx = await readResidualIndex(dir)
    expect(idx.version).toBe(7)
  })

  it('returns empty index when file has an unrecognized shape', async () => {
    await writeFile(join(dir, 'index.json'), JSON.stringify('just a string'))
    const idx1 = await readResidualIndex(dir)
    expect(Object.keys(idx1.entries)).toEqual([])

    await writeFile(join(dir, 'index.json'), JSON.stringify(42))
    const idx2 = await readResidualIndex(dir)
    expect(Object.keys(idx2.entries)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Round-trip: legacy read → canonical write → canonical read
// ---------------------------------------------------------------------------

describe('readResidualIndex round-trip', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-index-rt-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('legacy array → normalized object → canonical on disk after write', async () => {
    const legacy = [makeEntry({ id: 'x_1' }), makeEntry({ id: 'y_2' })]
    await writeFile(join(dir, 'index.json'), JSON.stringify(legacy))

    // First read normalizes in-memory, file is still array on disk
    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries)).toHaveLength(2)

    // Explicit write migrates the file to canonical format
    await writeResidualIndex(dir, idx)

    const raw = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    expect(Array.isArray(raw)).toBe(false)
    expect(raw).toHaveProperty('entries')
    expect(raw.entries).toHaveProperty('x_1')

    // Subsequent read returns the same data
    const idx2 = await readResidualIndex(dir)
    expect(Object.keys(idx2.entries).sort()).toEqual(['x_1', 'y_2'])
  })
})

// ---------------------------------------------------------------------------
// Production drift: { version, entries: Array } shape
// memory-hardening-followup Phase D (2026-05-19) — observed in production
// index.json as a silent drift from the canonical { version, entries: Record }
// schema. readResidualIndex must rebuild the object from the array, and a
// round-trip through writeResidualIndex must persist the canonical shape.
// ---------------------------------------------------------------------------

describe('readResidualIndex — entries-as-array drift (production-observed)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-index-drift-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads { version, entries: Array } and re-keys by entry.id', async () => {
    const drift = {
      version: 1,
      entries: [
        makeEntry({ id: 'arch_001', topic: 'architecture' }),
        makeEntry({ id: 'pref_002', topic: 'preferences' }),
      ],
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift))

    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries).sort()).toEqual(['arch_001', 'pref_002'])
    expect(idx.entries.arch_001.topic).toBe('architecture')
    expect(idx.entries.pref_002.topic).toBe('preferences')
  })

  it('preserves version field from drift shape', async () => {
    const drift = {
      version: 3,
      entries: [makeEntry({ id: 'a_1' })],
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift))

    const idx = await readResidualIndex(dir)
    expect(idx.version).toBe(3)
  })

  it('round-trips drift shape to canonical on disk after write', async () => {
    const drift = {
      version: 1,
      entries: [makeEntry({ id: 'a_1' }), makeEntry({ id: 'b_2' })],
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift))

    const idx = await readResidualIndex(dir)
    await writeResidualIndex(dir, idx)

    const raw = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    expect(Array.isArray(raw)).toBe(false)
    expect(Array.isArray(raw.entries)).toBe(false)
    expect(typeof raw.entries).toBe('object')
    expect(raw.entries).toHaveProperty('a_1')
    expect(raw.entries).toHaveProperty('b_2')
  })

  it('drops entries lacking string id but keeps the rest', async () => {
    const drift = {
      version: 1,
      entries: [
        makeEntry({ id: 'good' }),
        { summary: 'no id' },
        makeEntry({ id: 'also_good' }),
      ],
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift))

    const idx = await readResidualIndex(dir)
    expect(Object.keys(idx.entries).sort()).toEqual(['also_good', 'good'])
  })
})
