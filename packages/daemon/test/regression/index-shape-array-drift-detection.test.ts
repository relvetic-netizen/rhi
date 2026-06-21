import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { checkArrayDriftAbsent } from '../../../extracted/memory/distillVerifier.js'

// ---------------------------------------------------------------------------
// Phase C regression fixture — array-drift axis
// memory-hardening followup regression guard
//
// Intentional-break dogfood: the production-observed `{ version, entries: [] }`
// drift MUST fail the axis, top-level array MUST also fail, and the canonical
// `{ version, entries: {} }` shape MUST pass. This pins the contract behind
// the Phase D bootstrap normalizer (ensureCanonicalIndexFormat).
// ---------------------------------------------------------------------------

describe('regression: array-drift detection', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shape-arraydrift-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('FAILS the axis on production-observed { version, entries: Array } shape', async () => {
    const drift = {
      version: 1,
      entries: [
        { id: 'a_1', topic: 'tooling', summary: '', sources: [], concepts: [], updated: '2026-05-19', confidence: 1 },
        { id: 'b_2', topic: 'tooling', summary: '', sources: [], concepts: [], updated: '2026-05-19', confidence: 1 },
      ],
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(drift), 'utf8')

    const result = await checkArrayDriftAbsent(dir)
    expect(result.axis).toBe('array-drift')
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(2)
    expect(result.message).toMatch(/entries field is an Array\(2\)/)
  })

  it('FAILS on legacy top-level array shape', async () => {
    const legacy = [
      { id: 'x', topic: 't', summary: '', sources: [], concepts: [], updated: '2026-05-19', confidence: 1 },
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(legacy), 'utf8')

    const result = await checkArrayDriftAbsent(dir)
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(1)
    expect(result.message).toMatch(/top-level is an Array/)
  })

  it('PASSES on canonical { version, entries: Record } shape', async () => {
    const canonical = {
      version: 1,
      entries: {
        a_1: { id: 'a_1', topic: 't', summary: '', sources: [], concepts: [], updated: '2026-05-19', confidence: 1 },
      },
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify(canonical), 'utf8')

    const result = await checkArrayDriftAbsent(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
    expect(result.message).toMatch(/canonical Record/)
  })

  it('PASSES on absent index.json (treated as clean canonical)', async () => {
    const result = await checkArrayDriftAbsent(dir)
    expect(result.passed).toBe(true)
    expect(result.offenderCount).toBe(0)
    expect(result.message).toMatch(/absent/)
  })

  it('FAILS on malformed JSON (surfacing the error rather than swallowing it)', async () => {
    await writeFile(join(dir, 'index.json'), 'not json {{{', 'utf8')

    const result = await checkArrayDriftAbsent(dir)
    expect(result.passed).toBe(false)
    expect(result.offenderCount).toBe(-1)
    expect(result.message).toMatch(/read\/parse failed/)
  })
})
