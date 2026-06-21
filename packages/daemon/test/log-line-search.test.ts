import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchRecentLogLines } from '../../extracted/screening/logLineSearch.js'
import type { ScreeningConfig } from '../../extracted/screening/screening.js'

const cutoffMs = Date.parse('2026-05-01T12:00:00+09:00')
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
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-log-line-'))
  tempDirs.push(dir)
  return dir
}

async function writeMemoryFile(memoryDir: string, relativePath: string, content: string | Buffer): Promise<void> {
  const fullPath = join(memoryDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content)
}

type LogLineSearchResult = Awaited<ReturnType<typeof searchRecentLogLines>>[number] & {
  lineNumber: number
  hhmm: string
  tags: string[]
  epochMs: number
}

describe('searchRecentLogLines', () => {
  it('returns matching recent log lines with line metadata', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      '- [10:15] [phase15][bm25] BM25 deploy completed with green tests\n',
    )

    const results = await searchRecentLogLines(memoryDir, 'BM25 deploy', config, { cutoffMs })
    const first = results[0] as LogLineSearchResult
    expect(first.path).toBe('logs/2026/05/2026-05-03.md')
    expect(first.source).toBe('log-line')
    expect(first.lineNumber).toBe(1)
    expect(first.hhmm).toBe('10:15')
    expect(first.tags).toEqual(['phase15', 'bm25'])
    expect(first.epochMs).toBe(Date.parse('2026-05-03T10:15:00+09:00'))
    expect(first.snippet).toContain('BM25 deploy completed')
  })

  it('filters files whose path date ends before the 48h cutoff', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/04/2026-04-30.md',
      '- [23:58] BM25 deploy should be too old by file date\n',
    )
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      '- [10:00] BM25 deploy recent target\n',
    )

    const results = await searchRecentLogLines(memoryDir, 'BM25 deploy', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect(results[0]!.path).toBe('logs/2026/05/2026-05-03.md')
  })

  it('filters individual lines older than the cutoff inside an included file', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-01.md',
      [
        '- [11:59] BM25 deploy too old by line timestamp',
        '- [12:00] BM25 deploy exactly at cutoff',
      ].join('\n'),
    )

    const results = await searchRecentLogLines(memoryDir, 'BM25 deploy', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect((results[0] as LogLineSearchResult).hhmm).toBe('12:00')
  })

  it('includes tags in the searchable text', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      '- [09:00] [phase15][diagnostics] search completed\n',
    )

    const results = await searchRecentLogLines(memoryDir, 'diagnostics', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect((results[0] as LogLineSearchResult).tags).toContain('diagnostics')
  })

  it('accepts a BOM-prefixed first line and a missing final newline', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      '\uFEFF- [09:30] BM25 parser handles BOM without final newline',
    )

    const results = await searchRecentLogLines(memoryDir, 'parser BOM', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect((results[0] as LogLineSearchResult).lineNumber).toBe(1)
  })

  it('skips invalid UTF-8 replacement-char lines without failing the scan', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      Buffer.concat([
        Buffer.from('- [09:00] BM25 invalid '),
        Buffer.from([0xff]),
        Buffer.from('\n- [10:00] BM25 valid fallback line\n'),
      ]),
    )

    const results = await searchRecentLogLines(memoryDir, 'BM25 valid fallback', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect((results[0] as LogLineSearchResult).hhmm).toBe('10:00')
  })

  it('skips malformed timestamp lines without failing the scan', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(
      memoryDir,
      'logs/2026/05/2026-05-03.md',
      [
        '- [25:00] BM25 malformed timestamp',
        '- [10:30] BM25 valid timestamp',
      ].join('\n'),
    )

    const results = await searchRecentLogLines(memoryDir, 'BM25 timestamp', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect((results[0] as LogLineSearchResult).hhmm).toBe('10:30')
  })

  it('strictly scans only logs/YYYY/MM/YYYY-MM-DD.md paths', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(memoryDir, 'logs/2026/05/foo.md', '- [10:00] BM25 wrong filename\n')
    await writeMemoryFile(memoryDir, 'topics/architecture.md', '- [10:00] BM25 topic should be ignored\n')
    await writeMemoryFile(memoryDir, 'logs/2026/05/2026-05-03.md', '- [10:00] BM25 strict path target\n')

    const results = await searchRecentLogLines(memoryDir, 'BM25', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toContain('strict path target')
  })

  it('excludes private private paths even when they contain log-shaped files', async () => {
    const memoryDir = await makeMemoryDir()
    await writeMemoryFile(memoryDir, 'private/logs/2026/05/2026-05-03.md', '- [10:00] BM25 private line\n')
    await writeMemoryFile(memoryDir, 'logs/2026/05/2026-05-03.md', '- [10:00] BM25 public line\n')

    const results = await searchRecentLogLines(memoryDir, 'BM25', config, { cutoffMs })
    expect(results).toHaveLength(1)
    expect(results[0]!.snippet).toContain('public line')
  })
})
