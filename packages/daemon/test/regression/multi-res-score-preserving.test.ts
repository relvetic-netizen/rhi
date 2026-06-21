// Phase 0 regression fixture 2 (Plan v3 § Phase 0 T0-4)
//
// Asserts post-fix behavior: a strong concept match outranks a recency-only
// weak match in the multi-resolution screening pipeline.
//
// Pre-fix expectation: this fails because multiResolutionScreening.ts:264-265
// preserves the input order (newest first from scanMemoryFiles) instead of
// re-ranking by score after union. So the newest weak match wins position 0.
//
// Phase 3 T5 (RRF + BM25) flips this green by reciprocal-rank fusing scores
// across resolutions instead of collapsing to Set<string> union.

import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { findRelevantMemories } from '../../../extracted/screening/findRelevantMemories.js'

let tempDirs: string[] = []

async function setupTempMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-multires-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
  tempDirs = []
})

describe('regression: multi-resolution score should outrank recency', () => {
  it('a strong concept match wins position 0 over a recency-only weak match', async () => {
    // Topic file with many on-query terms — strong content-resolution signal.
    const strongConcept = [
      '# Strong Concept',
      '',
      'relvetia daemon relvetia daemon relvetia daemon',
      'daemon scheduler daemon scheduler relvetia daemon',
      'relvetia daemon pipeline relvetia daemon executor',
      'daemon relvetia daemon relvetia daemon relvetia',
    ].join('\n')

    // Topic file with one weak occurrence — barely passes the content threshold.
    const recentWeak = [
      '# Recent Weak',
      '',
      'unrelated content about coffee makers and printer drivers',
      'relvetia daemon',
      'more unrelated content',
    ].join('\n')

    const memoryDir = await setupTempMemoryDir({
      'topics/strong-concept.md': strongConcept,
      'topics/recent-weak.md': recentWeak,
    })

    // Force recent-weak to be the freshest mtime so scanMemoryFiles places it
    // first in the input array. screenMultiResolution preserves that order on
    // its filtered output (multiResolutionScreening.ts:264-265).
    const future = new Date(Date.now() + 60_000)
    const past = new Date(Date.now() - 60_000)
    await utimes(join(memoryDir, 'topics', 'recent-weak.md'), future, future)
    await utimes(join(memoryDir, 'topics', 'strong-concept.md'), past, past)

    const result = await findRelevantMemories('relvetia daemon', memoryDir, {
      enableSonnet: false, // keep the test offline; Stage 1 ordering is the assertion
      enableMultiResolution: true,
    })

    expect(result.length).toBeGreaterThan(0)
    // POST-FIX expectation: score-aware ranking puts strong-concept at [0].
    //
    // PRE-FIX: this fails — input is newest-first, screenMultiResolution preserves
    // input order on filter(), so recent-weak wins position 0.
    expect(result[0]?.filename).toContain('strong-concept')
  })
})
