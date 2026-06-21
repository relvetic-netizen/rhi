import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchMemoryWithScreening } from '../../extracted/screening/memorySearch.js'
import type { ScreeningConfig } from '../../extracted/screening/screening.js'
import { executeMemorySearch } from '../../extracted/tools/MemorySearchTool.js'

const config: ScreeningConfig = {
  threshold: 0.01,
  maxResults: 20,
}

let tempDirs: string[] = []

async function makeMemoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-memory-search-private-'))
  tempDirs.push(dir)
  return dir
}

async function writeMemoryFile(memoryDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(memoryDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content)
}

async function writeIndex(memoryDir: string, entries: Record<string, unknown>): Promise<void> {
  await writeMemoryFile(memoryDir, 'index.json', JSON.stringify({ version: 1, entries }))
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 4) {
        throw error
      }
      await sleep(25)
    }
  }
}

function normalizedPath(result: { path: string }): string {
  return result.path.replace(/\\/g, '/')
}

function resultPaths(results: { path: string }[]): string[] {
  return results.map(normalizedPath)
}

async function writeFileLayerFixture(memoryDir: string): Promise<void> {
  await writeIndex(memoryDir, {})
  await writeMemoryFile(memoryDir, 'private/topics/private.md', 'secretkeyword foo private body\n')
  await writeMemoryFile(memoryDir, 'topics/public.md', 'secretkeyword foo public body\n')
}

describe('private memory search privacy gate', () => {
  beforeEach(() => {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
  })

  afterEach(async () => {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
    await Promise.all(tempDirs.map(removeTempDir))
    tempDirs = []
  })

  it('excludes private files by default at the file layer', async () => {
    const memoryDir = await makeMemoryDir()
    await writeFileLayerFixture(memoryDir)

    const results = await searchMemoryWithScreening(memoryDir, 'secretkeyword foo', config)
    const paths = resultPaths(results)

    expect(paths.filter(path => path.startsWith('private/'))).toHaveLength(0)
    expect(paths).toContain('topics/public.md')
  })

  it('excludes private residual entries by default at the entry layer', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      reb_001: {
        id: 'reb_001',
        sources: ['private/logs/2026/05/2026-05-03.md:L5'],
        summary: 'entrylayer secretwordA',
        concepts: ['entrylayer', 'secretwordA'],
        topic: 'shared',
        updated: '2026-05-03',
        confidence: 1,
      },
      pub_001: {
        id: 'pub_001',
        sources: ['logs/2026/05/2026-05-03.md:L7'],
        summary: 'entrylayer secretwordA',
        concepts: ['entrylayer', 'secretwordA'],
        topic: 'shared-public',
        updated: '2026-05-03',
        confidence: 1,
      },
    })
    await writeMemoryFile(memoryDir, 'topics/shared.md', '')
    await writeMemoryFile(memoryDir, 'topics/shared-public.md', '')

    const results = await searchMemoryWithScreening(memoryDir, 'entrylayer secretwordA', config)
    const paths = resultPaths(results)

    expect(paths).not.toContain('topics/shared.md')
    expect(paths).toContain('topics/shared-public.md')
  })

  it('includes private files when explicitly opted in', async () => {
    const memoryDir = await makeMemoryDir()
    await writeFileLayerFixture(memoryDir)
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'

    const results = await searchMemoryWithScreening(memoryDir, 'secretkeyword foo', config)
    const paths = resultPaths(results)

    expect(paths).toContain('private/topics/private.md')
    expect(paths).toContain('topics/public.md')
  })

  it('excludes private files through the MCP-facing wrapper by default', async () => {
    const memoryDir = await makeMemoryDir()
    await writeFileLayerFixture(memoryDir)

    const output = await executeMemorySearch(memoryDir, { query: 'secretkeyword foo' })
    const paths = resultPaths(output.results)

    expect(paths.filter(path => path.startsWith('private/'))).toHaveLength(0)
  })
})
