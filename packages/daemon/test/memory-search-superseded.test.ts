import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readResidualIndex } from '../../extracted/memory/residualIndex.js'
import { searchMemoryWithScreening } from '../../extracted/screening/memorySearch.js'
import type { ScreeningConfig } from '../../extracted/screening/screening.js'

const config: ScreeningConfig = { threshold: 0.01, maxResults: 20 }

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

// Two entries with identical search text in different topics, so BM25 gives
// them the same raw score and only `superseded_by` can separate them.
async function makeFixture(oldExtra: Record<string, string>, newExtra: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rhi-superseded-'))
  tempDirs.push(dir)
  const base = {
    sources: ['logs/2026/10/2026-10-01.md:L3'],
    summary: 'apiserver premise leverage',
    concepts: ['apiserver', 'premise'],
    updated: '2026-10-01',
    confidence: 1,
  }
  await writeFile(join(dir, 'index.json'), JSON.stringify({
    version: 1,
    entries: {
      old_001: { ...base, id: 'old_001', topic: 'alpha', ...oldExtra },
      new_001: { ...base, id: 'new_001', topic: 'beta', ...newExtra },
    },
  }))
  return dir
}

describe('entry layer: superseded_by', () => {
  it('ranks a superseded entry below an equal-scoring valid entry and marks it', async () => {
    const dir = await makeFixture({ superseded_by: 'new_001' }, { valid_from: '2026-10-01' })

    const results = await searchMemoryWithScreening(dir, 'apiserver premise', config)

    expect(results.map(r => r.path)).toEqual(['topics/beta.md', 'topics/alpha.md'])
    expect(results[1].score).toBeCloseTo(results[0].score * 0.5)
    expect(results[1].snippet).toBe('[superseded→new_001] apiserver premise leverage')
    expect(results[0].snippet).toBe('apiserver premise leverage')
  })

  it('leaves entries without the new fields unchanged', async () => {
    const dir = await makeFixture({}, {})

    const index = await readResidualIndex(dir)
    expect(Object.keys(index.entries)).toEqual(['old_001', 'new_001'])

    const results = await searchMemoryWithScreening(dir, 'apiserver premise', config)

    expect(results.map(r => r.path)).toEqual(['topics/alpha.md', 'topics/beta.md'])
    expect(results[0].score).toBe(results[1].score)
    expect(results.map(r => r.snippet)).toEqual(['apiserver premise leverage', 'apiserver premise leverage'])
  })
})
