import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkHierIdRate } from '../../../extracted/memory/distillVerifier.js'

// ---------------------------------------------------------------------------
// Phase C regression fixture — hier-id-rate axis
// memory-hardening followup regression guard
//
// Intentional-break dogfood: a single numeric-id entry MUST fail the axis,
// and the canonical hierarchical form MUST pass. This pins the contract
// the bootstrap normalizer (ensureHierarchicalEntryIds) restores.
// ---------------------------------------------------------------------------

describe('regression: hier-id-rate detection', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shape-numericid-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('FAILS the axis when index has a single numeric-id entry', async () => {
    const drift = {
      version: 1,
      entries: {
        '110': {
          id: '110',
          topic: 'project-context/team-context-p1-saga',
          summary: 'silently numeric id',
          sources: [],
          concepts: [],
          updated: '2026-05-19',
          confidence: 1,
        },
      },
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift), 'utf8')

    const result = await checkHierIdRate(dir)
    expect(result.axis).toBe('hier-id-rate')
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(1)
    expect(result.samples).toContain('110')
    expect(result.message).toMatch(/1\/1 entries use bare numeric ids/)
  })

  it('FAILS with all 8 production-observed numeric ids reported', async () => {
    const entries: Record<string, unknown> = {}
    for (let i = 110; i <= 117; i++) {
      entries[String(i)] = {
        id: String(i),
        topic: 'x',
        summary: '',
        sources: [],
        concepts: [],
        updated: '2026-05-19',
        confidence: 1,
      }
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify({ version: 1, entries }), 'utf8')

    const result = await checkHierIdRate(dir)
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(8)
    expect(result.samples).toHaveLength(5)
  })

  it('PASSES when every id follows the hierarchical convention', async () => {
    const clean = {
      version: 1,
      entries: {
        project_context__001: {
          id: 'project_context__001',
          topic: 'project-context/team-context-p1-saga',
          summary: '',
          sources: [],
          concepts: [],
          updated: '2026-05-19',
          confidence: 1,
        },
        architecture_d10_001: {
          id: 'architecture_d10_001',
          topic: 'architecture/d10-duplicate-worker',
          summary: '',
          sources: [],
          concepts: [],
          updated: '2026-05-19',
          confidence: 1,
        },
      },
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(clean), 'utf8')

    const result = await checkHierIdRate(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
    expect(result.samples).toEqual([])
  })

  it('PASSES on a missing index file (treated as clean)', async () => {
    // No file written — readResidualIndex returns empty index.
    const result = await checkHierIdRate(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
  })
})
