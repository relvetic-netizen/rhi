import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildConceptGraph } from '../../extracted/memory/conceptGraph.js'

const tempDirs: string[] = []
const ORIGINAL_INCLUDE_PRIVATE = process.env.RELVETIA_INCLUDE_PRIVATE

async function makeMemoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-graph-private-'))
  tempDirs.push(dir)
  return dir
}

async function writeIndex(memoryDir: string, entries: Record<string, unknown>): Promise<void> {
  await writeFile(join(memoryDir, 'index.json'), JSON.stringify({ version: 1, entries }))
}

beforeEach(() => {
  delete process.env.RELVETIA_INCLUDE_PRIVATE
})

afterEach(async () => {
  if (ORIGINAL_INCLUDE_PRIVATE === undefined) {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
  } else {
    process.env.RELVETIA_INCLUDE_PRIVATE = ORIGINAL_INCLUDE_PRIVATE
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
})

describe('buildConceptGraph private gate', () => {
  it('does not create edges from concepts that only co-occur in private entries', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/diary.md:L1'],
        summary: '',
        concepts: ['privateonlyA', 'privateonlyB'],
        topic: 'private/diary',
        updated: '2026-05-18',
        confidence: 1,
      },
      pub_001: {
        id: 'pub_001',
        sources: ['logs/2026/05/2026-05-18.md:L1'],
        summary: '',
        concepts: ['publicX', 'publicY'],
        topic: 'architecture',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const graph = await buildConceptGraph(memoryDir)
    expect(graph.concepts['privateonlya']).toBeUndefined()
    expect(graph.concepts['privateonlyb']).toBeUndefined()
    expect(graph.concepts['publicx']).toBeDefined()
    expect(graph.concepts['publicy']).toBeDefined()
    expect(graph.concepts['publicx']!.related['publicy']).toBe(1)
  })

  it('drops private entries whose source is private/ even when the topic is public', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      mixed_001: {
        id: 'mixed_001',
        sources: ['private/diary.md:L1'],
        summary: '',
        concepts: ['leakcandidate', 'shouldnotleak'],
        topic: 'architecture',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const graph = await buildConceptGraph(memoryDir)
    expect(graph.concepts['leakcandidate']).toBeUndefined()
    expect(graph.concepts['shouldnotleak']).toBeUndefined()
  })

  it('includes private co-occurrences when opted in', async () => {
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/diary.md:L1'],
        summary: '',
        concepts: ['optinA', 'optinB'],
        topic: 'private/diary',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const graph = await buildConceptGraph(memoryDir)
    expect(graph.concepts['optina']).toBeDefined()
    expect(graph.concepts['optinb']).toBeDefined()
    expect(graph.concepts['optina']!.related['optinb']).toBe(1)
  })
})
