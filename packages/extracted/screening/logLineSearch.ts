import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  buildCorpusBundle,
  screenItemsBM25,
  screenItemsBM25WithBundle,
  type Bm25ScreeningOptions,
  type ScreeningConfig,
} from './screening.js'
import { logScreeningEvent } from './screeningLog.js'
import { isPrivatePrivatePath, type SearchResult } from './memorySearch.js'
import { getDefaultSearchCache } from './searchCache.js'

export type LogLineItem = {
  path: string
  lineNumber: number
  hhmm: string
  tags: string[]
  body: string
  epochMs: number
}

type LogLineSearchOptions = Bm25ScreeningOptions & {
  cutoffMs?: number
}

const LOG_LINE_RE = /^- \[(\d{2}):(\d{2})\] (?:(\[[^\]]+\](?:\[[^\]]+\])*)\s+)?(.+)$/
const LOG_PATH_RE = /^logs\/(\d{4})\/(\d{2})\/(\d{4})-(\d{2})-(\d{2})\.md$/
const LOG_LINE_RECENCY_HALF_LIFE_MS = 48 * 3600 * 1000
const SNIPPET_LENGTH = 300

export async function searchRecentLogLines(
  memoryDir: string,
  query: string,
  config: ScreeningConfig,
  options: LogLineSearchOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return []

  const referenceNowMs =
    options.cutoffMs === undefined
      ? Date.now()
      : options.cutoffMs + LOG_LINE_RECENCY_HALF_LIFE_MS
  const cutoffMs = options.cutoffMs ?? referenceNowMs - LOG_LINE_RECENCY_HALF_LIFE_MS
  const { files, parserSkipCount } = await readRecentLogLineItems(memoryDir, cutoffMs)

  if (files.items.length === 0) {
    logScreeningEvent('log_line_screening', {
      lineCount: 0,
      passedCount: 0,
      filesScanned: files.scannedCount,
      cutoffMs,
      parserSkipCount,
    })
    return []
  }

  // Saga 11 engine-cache-layer (Phase 4-5 expansion): bundle cache for the
  // log-line corpus. Log files mutate during a session (today's log grows),
  // so the watcher invalidate is what keeps this fresh. Bundle keying: the
  // cutoffMs varies per call (Date.now()-based default), so we round it to
  // the half-life window — within one watcher generation, calls that share
  // a cutoff bucket hit the same bundle. This keeps cache hit rate high
  // while preventing stale results past a half-life boundary.
  const searchCache = getDefaultSearchCache()
  const cutoffBucket = Math.floor(cutoffMs / LOG_LINE_RECENCY_HALF_LIFE_MS)
  const logBundleKey = `log-line:${cutoffBucket}`
  const itemTexts = files.items.map(logLineText)
  const logBundle = searchCache.getBundle(memoryDir, logBundleKey, () =>
    buildCorpusBundle(itemTexts),
  )
  // Defense-in-depth length guard against bundle-vs-corpus shape mismatch
  // (e.g., today's log appended between bundle build and now without a
  // watcher fire yet). Fall back to fresh build when lengths diverge.
  const scored = logBundle.itemTokens.length === files.items.length
    ? screenItemsBM25WithBundle(
        files.items,
        logBundle,
        query,
        {
          ...config,
          boostRecency: true,
          recencyHalfLifeMs: LOG_LINE_RECENCY_HALF_LIFE_MS,
        },
        line => Math.max(0, referenceNowMs - line.epochMs),
        {
          k1: options.k1,
          b: options.b,
          scale: options.scale,
        },
      )
    : screenItemsBM25(
        files.items,
        logLineText,
        query,
        {
          ...config,
          boostRecency: true,
          recencyHalfLifeMs: LOG_LINE_RECENCY_HALF_LIFE_MS,
        },
        line => Math.max(0, referenceNowMs - line.epochMs),
        {
          k1: options.k1,
          b: options.b,
          scale: options.scale,
        },
      )

  logScreeningEvent('log_line_screening', {
    lineCount: files.items.length,
    passedCount: scored.length,
    filesScanned: files.scannedCount,
    cutoffMs,
    parserSkipCount,
  })

  return scored.map(s => toLogLineResult(memoryDir, s.item, s.score, 'log-line'))
}

/**
 * Archive layer: every log line regardless of age, scored by BM25 alone.
 * No recency factor, so an old fact competes on equal terms with a new one.
 * memorySearch calls this only when the upper layers leave room.
 */
export async function searchAllLogLines(
  memoryDir: string,
  query: string,
  config: ScreeningConfig,
  options: Bm25ScreeningOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const { files } = await readRecentLogLineItems(memoryDir, -Infinity)
  const scored = screenItemsBM25(files.items, logLineText, query, config, undefined, {
    k1: options.k1,
    b: options.b,
    scale: options.scale,
  })
  return scored.map(s => toLogLineResult(memoryDir, s.item, s.score, 'log-archive'))
}

function logLineText(line: LogLineItem): string {
  return `${line.path.replace(/[-_./]/g, ' ')} ${line.tags.join(' ')} ${line.body}`
}

function toLogLineResult(
  memoryDir: string,
  item: LogLineItem,
  score: number,
  source: 'log-line' | 'log-archive',
): SearchResult {
  return {
    path: item.path,
    filePath: join(memoryDir, item.path),
    snippet: `${item.hhmm} ${item.tags.map(t => `[${t}]`).join(' ')} ${item.body}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SNIPPET_LENGTH),
    score,
    source,
    lineNumber: item.lineNumber,
    hhmm: item.hhmm,
    tags: item.tags,
    epochMs: item.epochMs,
  } as unknown as SearchResult
}

async function readRecentLogLineItems(
  memoryDir: string,
  cutoffMs: number,
): Promise<{
  files: { items: LogLineItem[]; scannedCount: number }
  parserSkipCount: number
}> {
  let entries: string[]
  try {
    entries = (await readdir(memoryDir, { recursive: true })) as string[]
  } catch {
    return { files: { items: [], scannedCount: 0 }, parserSkipCount: 0 }
  }

  const logPaths = entries
    .map(path => path.replace(/\\/g, '/'))
    .filter(path => isStrictLogPath(path))
    .filter(path => !isPrivatePrivatePath(path))
    .filter(path => logFileEndOfDayEpochMs(path) >= cutoffMs)

  let parserSkipCount = 0
  const results = await Promise.allSettled(
    logPaths.map(async path => {
      const buffer = await readFile(join(memoryDir, path))
      const text = buffer.toString('utf8')
      const items: LogLineItem[] = []
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = parseLogLine(path, i + 1, lines[i] ?? '', cutoffMs)
          if (parsed) {
            items.push(parsed)
          } else if (shouldCountParserSkip(lines[i] ?? '')) {
            parserSkipCount++
          }
        } catch {
          parserSkipCount++
        }
      }
      return items
    }),
  )

  const items = results
    .filter((r): r is PromiseFulfilledResult<LogLineItem[]> => r.status === 'fulfilled')
    .flatMap(r => r.value)

  return {
    files: { items, scannedCount: logPaths.length },
    parserSkipCount,
  }
}

function isStrictLogPath(relativePath: string): boolean {
  const match = LOG_PATH_RE.exec(relativePath)
  if (!match) return false
  const [, pathYear, pathMonth, fileYear, fileMonth] = match
  return pathYear === fileYear && pathMonth === fileMonth
}

function logFileEndOfDayEpochMs(relativePath: string): number {
  const match = LOG_PATH_RE.exec(relativePath)
  if (!match) return 0
  const [, , , year, month, day] = match
  return Date.parse(`${year}-${month}-${day}T23:59:59.999+09:00`)
}

function parseLogLine(
  relativePath: string,
  lineNumber: number,
  rawLine: string,
  cutoffMs: number,
): LogLineItem | null {
  let line = rawLine.replace(/^\uFEFF/, '')
  if (line.includes('\uFFFD')) return null
  if (line.trim().length === 0) return null

  const lineMatch = LOG_LINE_RE.exec(line)
  if (!lineMatch) return null

  const [, hh, mm, tagBlock, body] = lineMatch
  const hour = Number(hh)
  const minute = Number(mm)
  if (hour > 23 || minute > 59) return null

  const pathMatch = LOG_PATH_RE.exec(relativePath)
  if (!pathMatch) return null
  const [, , , year, month, day] = pathMatch
  const epochMs = Date.parse(`${year}-${month}-${day}T${hh}:${mm}:00+09:00`)
  if (!Number.isFinite(epochMs) || epochMs < cutoffMs) return null

  const tags = tagBlock
    ? [...tagBlock.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]!)
    : []

  return {
    path: relativePath,
    lineNumber,
    hhmm: `${hh}:${mm}`,
    tags,
    body,
    epochMs,
  }
}

function shouldCountParserSkip(rawLine: string): boolean {
  const line = rawLine.replace(/^\uFEFF/, '')
  return line.trim().length > 0 && (line.includes('\uFFFD') || line.startsWith('- ['))
}
