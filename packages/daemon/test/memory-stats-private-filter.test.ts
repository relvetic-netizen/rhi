import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordHits,
  readMemoryStats,
  type MemoryStatsData,
} from '../../extracted/memory/memoryStats.js'

const ORIGINAL_INCLUDE_PRIVATE = process.env.RELVETIA_INCLUDE_PRIVATE

function makeStats(): MemoryStatsData {
  return {
    version: 1,
    entries: {
      'topics/preferences.md': {
        hitCount: 3,
        lastHitAt: 1000,
        penalty: 0,
      },
    },
  }
}

describe('recordHits private filter', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-stats-private-'))
    delete process.env.RELVETIA_INCLUDE_PRIVATE
  })

  afterEach(async () => {
    if (ORIGINAL_INCLUDE_PRIVATE === undefined) {
      delete process.env.RELVETIA_INCLUDE_PRIVATE
    } else {
      process.env.RELVETIA_INCLUDE_PRIVATE = ORIGINAL_INCLUDE_PRIVATE
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('skips private keys when RELVETIA_INCLUDE_PRIVATE is unset', async () => {
    await writeFile(join(dir, 'stats.json'), JSON.stringify(makeStats(), null, 2))

    await recordHits(dir, ['private/foo.md', 'topics/preferences.md'])

    const stats = await readMemoryStats(dir)
    expect(stats.entries['private/foo.md']).toBeUndefined()
    expect(stats.entries['topics/preferences.md'].hitCount).toBe(4)
  })

  it('does not write stats when all hit keys are private and env is unset', async () => {
    const original = JSON.stringify(makeStats(), null, 2)
    await writeFile(join(dir, 'stats.json'), original)

    await recordHits(dir, ['private/foo.md', 'private/diary/2026-04.md'])

    const after = await readFile(join(dir, 'stats.json'), 'utf8')
    expect(after).toBe(original)
  })

  it('records private keys when RELVETIA_INCLUDE_PRIVATE=1', async () => {
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'

    await recordHits(dir, ['private/foo.md'])

    const stats = await readMemoryStats(dir)
    expect(stats.entries['private/foo.md'].hitCount).toBe(1)
    expect(stats.entries['private/foo.md'].penalty).toBe(0)
  })
})
