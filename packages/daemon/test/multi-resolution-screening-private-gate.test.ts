import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { screenMultiResolution } from '../../extracted/screening/multiResolutionScreening.js'
import type { MemoryHeaderLike } from '../../extracted/screening/memoryScreening.js'

const tempDirs: string[] = []
const ORIGINAL_INCLUDE_PRIVATE = process.env.RELVETIA_INCLUDE_PRIVATE

async function makeMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-multires-private-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const fullPath = join(dir, ...rel.split('/'))
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }
  return dir
}

async function writeIndex(memoryDir: string, entries: Record<string, unknown>): Promise<void> {
  await writeFile(join(memoryDir, 'index.json'), JSON.stringify({ version: 1, entries }))
}

function header(filename: string, contentSnippet: string): MemoryHeaderLike {
  return {
    filename,
    filePath: filename,
    mtimeMs: Date.now(),
    description: contentSnippet.slice(0, 200),
    contentSnippet,
  }
}

const cfg = {
  contentThreshold: 0.01,
  conceptThreshold: 0.01,
  topicThreshold: 0.01,
  maxPerResolution: 20,
  maxResults: 20,
  boostRecency: false,
  recencyHalfLifeMs: 86_400_000,
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

describe('screenMultiResolution private gate', () => {
  it('screenByContent excludes private files', async () => {
    const memoryDir = await makeMemoryDir({})
    await writeIndex(memoryDir, {})

    const memories: MemoryHeaderLike[] = [
      header('private/private.md', 'uniqueterm content from a private file'),
      header('topics/public.md', 'uniqueterm content from a public file'),
    ]

    const result = await screenMultiResolution(memories, 'uniqueterm', cfg, memoryDir)
    const filenames = result.memories.map(m => m.filename.replace(/\\/g, '/'))
    expect(filenames.some(f => f.startsWith('private/'))).toBe(false)
    expect(filenames).toContain('topics/public.md')
  })

  it('screenByConcepts skips private entries when building concept text', async () => {
    const memoryDir = await makeMemoryDir({})
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/logs/2026/05/2026-05-18.md:L5'],
        summary: 'sharedconcepttoken topical material from diary',
        concepts: ['sharedconcepttoken', 'diary'],
        topic: 'private/diary',
        updated: '2026-05-18',
        confidence: 1,
      },
      pub_001: {
        id: 'pub_001',
        sources: ['logs/2026/05/2026-05-18.md:L7'],
        summary: 'sharedconcepttoken topical material from a public entry',
        concepts: ['sharedconcepttoken', 'architecture'],
        topic: 'architecture',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const memories: MemoryHeaderLike[] = [
      header('private/diary.md', ''),
      header('topics/architecture.md', ''),
    ]

    const result = await screenMultiResolution(memories, 'sharedconcepttoken', cfg, memoryDir)
    const filenames = result.memories.map(m => m.filename.replace(/\\/g, '/'))
    expect(filenames.some(f => f.startsWith('private/'))).toBe(false)
    expect(filenames).toContain('topics/architecture.md')
  })

  it('screenByTopicSummary excludes private topic summaries', async () => {
    const memoryDir = await makeMemoryDir({})
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/diary.md:L1'],
        summary: 'topictoken description private',
        concepts: ['topictoken'],
        topic: 'private/diary',
        updated: '2026-05-18',
        confidence: 1,
      },
      pub_001: {
        id: 'pub_001',
        sources: ['logs/2026/05/2026-05-18.md:L1'],
        summary: 'topictoken description public',
        concepts: ['topictoken'],
        topic: 'architecture',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const memories: MemoryHeaderLike[] = [
      header('private/diary.md', ''),
      header('topics/architecture.md', ''),
    ]

    const result = await screenMultiResolution(memories, 'topictoken', cfg, memoryDir)
    const filenames = result.memories.map(m => m.filename.replace(/\\/g, '/'))
    expect(filenames.some(f => f.startsWith('private/'))).toBe(false)
    expect(filenames).toContain('topics/architecture.md')
  })

  it('includes private files at all 3 resolutions when opted in', async () => {
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'
    const memoryDir = await makeMemoryDir({})
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/diary.md:L1'],
        summary: 'optintoken summary',
        concepts: ['optintoken'],
        topic: 'private/diary',
        updated: '2026-05-18',
        confidence: 1,
      },
    })

    const memories: MemoryHeaderLike[] = [
      header('private/diary.md', 'optintoken content from diary'),
    ]

    const result = await screenMultiResolution(memories, 'optintoken', cfg, memoryDir)
    const filenames = result.memories.map(m => m.filename.replace(/\\/g, '/'))
    expect(filenames).toContain('private/diary.md')
  })
})
