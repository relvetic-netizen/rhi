import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchMemoryWithScreening } from '../../extracted/screening/memorySearch.js'
import type { ScreeningConfig } from '../../extracted/screening/screening.js'

const config: ScreeningConfig = {
  threshold: 0.01,
  maxResults: 20,
}

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function makeMemoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-memory-search-'))
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

function sourceOf(result: { source?: unknown }): string | undefined {
  return typeof result.source === 'string' ? result.source : undefined
}

function normalizedPath(result: { path: string }): string {
  return result.path.replace(/\\/g, '/')
}

// Production code (logLineSearch.ts) gates log lines by a 48h moving cutoff
// and parses both the file-path date and the [HH:MM] tag as Asia/Tokyo time
// (parseLogLine builds 'YYYY-MM-DDTHH:MM:00+09:00'). Hardcoded fixture dates
// fall out of that window after ~2 days, so the test must use a recent
// JST-derived date regardless of the runner's local timezone (CI is UTC).
function todayLogPath(): { path: string; hhmm: string } {
  const past = new Date(Date.now() - 60_000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(past)
      .map(p => [p.type, p.value]),
  )
  const yyyy = parts.year as string
  const mm = parts.month as string
  const dd = parts.day as string
  return {
    path: `logs/${yyyy}/${mm}/${yyyy}-${mm}-${dd}.md`,
    hhmm: `${parts.hour}:${parts.minute}`,
  }
}

describe('searchMemoryWithScreening log-line layer merge', () => {
  it('keeps entry, file, then log-line layer order', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      ent_001: {
        id: 'ent_001',
        summary: 'phase15 bm25 layerorder entry summary',
        sources: [],
        concepts: ['phase15', 'bm25', 'layerorder'],
        topic: 'entry-layer',
        updated: '2026-05-03',
        confidence: 1,
      },
    })
    await writeMemoryFile(memoryDir, 'topics/file-layer.md', 'phase15 bm25 layerorder file body\n')
    const today = todayLogPath()
    await writeMemoryFile(memoryDir, today.path, `- [${today.hhmm}] phase15 bm25 layerorder log line body\n`)

    const results = await searchMemoryWithScreening(memoryDir, 'phase15 bm25 layerorder', config)
    const entryIndex = results.findIndex(r => normalizedPath(r) === 'topics/entry-layer.md')
    const fileIndex = results.findIndex(r => normalizedPath(r) === 'topics/file-layer.md')
    const logLineIndex = results.findIndex(r => sourceOf(r) === 'log-line')

    expect(entryIndex).toBeGreaterThanOrEqual(0)
    expect(fileIndex).toBeGreaterThan(entryIndex)
    expect(logLineIndex).toBeGreaterThan(fileIndex)
  })

  it('dedups entry/file by path while preserving distinct log-line keys', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {
      dup_001: {
        id: 'dup_001',
        summary: 'dedup bm25 shared topic entry',
        sources: [],
        concepts: ['dedup', 'bm25'],
        topic: 'shared',
        updated: '2026-05-03',
        confidence: 1,
      },
    })
    await writeMemoryFile(memoryDir, 'topics/shared.md', 'dedup bm25 shared topic file duplicate\n')
    const today = todayLogPath()
    await writeMemoryFile(
      memoryDir,
      today.path,
      [
        `- [${today.hhmm}] dedup bm25 first log line`,
        `- [${today.hhmm}] dedup bm25 second log line`,
      ].join('\n'),
    )

    const results = await searchMemoryWithScreening(memoryDir, 'dedup bm25', config)
    expect(results.filter(r => r.path === 'topics/shared.md')).toHaveLength(1)
    expect(results.filter(r => sourceOf(r) === 'log-line')).toHaveLength(2)
  })

  it('applies the log-line private scope gate during merged search', async () => {
    const memoryDir = await makeMemoryDir()
    await writeIndex(memoryDir, {})
    const today = todayLogPath()
    await writeMemoryFile(memoryDir, `private/${today.path}`, `- [${today.hhmm}] privategate bm25 private line\n`)
    await writeMemoryFile(memoryDir, today.path, `- [${today.hhmm}] privategate bm25 public line\n`)

    const results = await searchMemoryWithScreening(memoryDir, 'privategate bm25', config)
    expect(results.some(r => r.path.startsWith('private/'))).toBe(false)
    expect(results.some(r => sourceOf(r) === 'log-line' && r.snippet.includes('public line'))).toBe(true)
  })
})
