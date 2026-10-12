#!/usr/bin/env node
// longMemEvalRun.ts — LongMemEval retrieval baseline for memory search.
//
// For each question, the haystack sessions are written into a throwaway
// memory dir as L3 daily logs (`logs/YYYY/MM/YYYY-MM-DD.md`, one message per
// line `- [HH:MM] [longmemeval] <content>`, empty index.json), then
// `searchMemoryWithScreening` is called with the question using the same
// config as the production gate (`DefaultBm25ScreeningGate`).
//
// Each session gets its own day file: sessions keep their `haystack_dates`
// order and HH:MM, but are dated one day apart counting back from the day
// before question_date (real dates collide within a day). A file hit is
// therefore a session hit, i.e. standard session-level recall.
//
// Gold = sessions that contain a `has_answer === true` message (LongMemEval
// labels, unmodified). A returned log line is relevant when its session is
// gold. No LLM is called.
//
// Two clock conditions per question (same store):
//   real — Date.now() as is. The log-line layer only sees the last 48h, so
//          2023-dated logs are outside it (current production behaviour);
//          only the all-time log-archive layer reaches their lines.
//   qdate — Date.now() pinned to the question_date, i.e. as if the haystack
//          had been logged right before the question was asked.
//
// Usage: npm run eval:longmemeval -- --set s   (from packages/daemon/)
//        --set oracle|s   (default: oracle)

import { readFileSync } from 'fs'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod/v4'
import { searchMemoryWithScreening, type SearchResult } from '../screening/memorySearch.js'
import { resetDefaultSearchCache } from '../screening/searchCache.js'
import { getScreeningConfig } from '../screening/screeningConfig.js'

const MessageSchema = z.object({
  role: z.string(),
  content: z.string(),
  has_answer: z.boolean().optional(),
})

export const LmeEntrySchema = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  question_date: z.string(),
  haystack_dates: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_sessions: z.array(z.array(MessageSchema)),
})

export type LmeEntry = z.infer<typeof LmeEntrySchema>

export const CONDITIONS = ['real', 'qdate'] as const
export type Condition = (typeof CONDITIONS)[number]

export type QuestionResult = {
  questionId: string
  questionType: string
  abstention: boolean
  /** 1-based rank of the first relevant result per condition; null = none. */
  rank: Record<Condition, number | null>
  resultCount: Record<Condition, number>
  /** Results from the all-time log-archive layer (layer 4). */
  archiveCount: Record<Condition, number>
  /** Expected Recall@5/@10 if the sessions were ranked at random. */
  chance: { r5: number; r10: number }
}

// "2023/05/20 (Sat) 02:21" → parts. Times are treated as JST, like real logs.
const DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2}) \(\w+\) (\d{2}):(\d{2})$/

function parseLmeDate(s: string): { ymd: string; hhmm: string; epochMs: number } {
  const match = DATE_RE.exec(s)
  if (!match) throw new Error(`Unexpected LongMemEval date: ${s}`)
  const [, y, m, d, hh, mm] = match as unknown as [string, string, string, string, string, string]
  return {
    ymd: `${y}-${m}-${d}`,
    hhmm: `${hh}:${mm}`,
    epochMs: Date.parse(`${y}-${m}-${d}T${hh}:${mm}:00+09:00`),
  }
}

/** Calendar day `daysBack` days before `ymd`, as YYYY-MM-DD. */
function daysBefore(ymd: string, daysBack: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - daysBack * 24 * 3600 * 1000).toISOString().slice(0, 10)
}

export type Store = {
  /** relative path → file lines (line N is lines[N - 1]). */
  files: Map<string, string[]>
  /** `${path}#${lineNumber}` → session id. */
  lineSession: Map<string, string>
  /** relative path → the one session in that file. */
  fileSession: Map<string, string>
}

export function buildStore(entry: LmeEntry): Store {
  const store: Store = { files: new Map(), lineSession: new Map(), fileSession: new Map() }
  const order = entry.haystack_sessions
    .map((session, i) => ({ session, id: entry.haystack_session_ids[i]!, date: parseLmeDate(entry.haystack_dates[i]!) }))
    .sort((a, b) => a.date.epochMs - b.date.epochMs)
  const questionDay = parseLmeDate(entry.question_date).ymd

  order.forEach(({ session, id, date }, k) => {
    const ymd = daysBefore(questionDay, order.length - k)
    const path = `logs/${ymd.slice(0, 4)}/${ymd.slice(5, 7)}/${ymd}.md`
    const lines = session.map(msg => `- [${date.hhmm}] [longmemeval] ${msg.content.replace(/\r?\n/g, ' ')}`)
    store.files.set(path, lines)
    store.fileSession.set(path, id)
    lines.forEach((_, i) => store.lineSession.set(`${path}#${i + 1}`, id))
  })
  return store
}

export function goldSessions(entry: LmeEntry): Set<string> {
  const gold = new Set<string>()
  entry.haystack_sessions.forEach((session, i) => {
    if (session.some(m => m.has_answer)) gold.add(entry.haystack_session_ids[i]!)
  })
  return gold
}

export function firstRelevantRank(results: SearchResult[], store: Store, gold: Set<string>): number | null {
  for (let i = 0; i < results.length; i++) {
    const r = results[i] as SearchResult & { lineNumber?: number }
    // The file layer reports OS-native separators (backslashes on Windows).
    const path = r.path.replace(/\\/g, '/')
    const session = r.source === 'log-line' || r.source === 'log-archive'
      ? store.lineSession.get(`${path}#${r.lineNumber}`)
      : store.fileSession.get(path)
    const relevant = gold.has(session ?? '')
    if (relevant) return i + 1
  }
  return null
}

/** P(at least one of `gold` relevant files lands in a random top-k of `files`). */
export function chanceRecall(files: number, gold: number, k: number): number {
  if (gold === 0) return 0
  let missAll = 1
  for (let i = 0; i < Math.min(k, files); i++) missAll *= Math.max(0, files - gold - i) / (files - i)
  return 1 - missAll
}

async function searchAt(memoryDir: string, query: string, nowMs: number | null): Promise<SearchResult[]> {
  const cfg = getScreeningConfig()
  const realNow = Date.now
  if (nowMs !== null) Date.now = () => nowMs
  try {
    return await searchMemoryWithScreening(memoryDir, query, {
      threshold: cfg.searchThreshold,
      maxResults: cfg.searchMaxResults,
    })
  } finally {
    Date.now = realNow
  }
}

export async function runQuestion(entry: LmeEntry): Promise<QuestionResult> {
  const store = buildStore(entry)
  const gold = goldSessions(entry)
  const dir = await mkdtemp(join(tmpdir(), 'lme-'))
  try {
    for (const [path, lines] of store.files) {
      const filePath = join(dir, path)
      await mkdir(join(filePath, '..'), { recursive: true })
      await writeFile(filePath, lines.join('\n') + '\n', 'utf8')
    }
    await writeFile(join(dir, 'index.json'), JSON.stringify({ entries: {} }), 'utf8')

    const rank = {} as QuestionResult['rank']
    const resultCount = {} as QuestionResult['resultCount']
    const archiveCount = {} as QuestionResult['archiveCount']
    for (const condition of CONDITIONS) {
      const nowMs = condition === 'qdate' ? parseLmeDate(entry.question_date).epochMs : null
      const results = await searchAt(dir, entry.question, nowMs)
      rank[condition] = firstRelevantRank(results, store, gold)
      resultCount[condition] = results.length
      archiveCount[condition] = results.filter(r => r.source === 'log-archive').length
    }
    return {
      questionId: entry.question_id,
      questionType: entry.question_type,
      abstention: entry.question_id.endsWith('_abs'),
      rank,
      resultCount,
      archiveCount,
      chance: { r5: chanceRecall(store.files.size, gold.size, 5), r10: chanceRecall(store.files.size, gold.size, 10) },
    }
  } finally {
    resetDefaultSearchCache()
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export type Scores = { n: number; r5: number; r10: number; mrr: number }

export function score(results: QuestionResult[], condition: Condition): Scores {
  const n = results.length
  if (n === 0) return { n, r5: 0, r10: 0, mrr: 0 }
  const ranks = results.map(r => r.rank[condition])
  const within = (k: number) => ranks.filter(r => r !== null && r <= k).length / n
  const mrr = ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / n
  return { n, r5: within(5), r10: within(10), mrr }
}

export function chanceScore(results: QuestionResult[]): { r5: number; r10: number } {
  const n = results.length || 1
  return {
    r5: results.reduce((sum, r) => sum + r.chance.r5, 0) / n,
    r10: results.reduce((sum, r) => sum + r.chance.r10, 0) / n,
  }
}

export function emptyRate(results: QuestionResult[], condition: Condition): number {
  return results.length === 0 ? 0 : results.filter(r => r.resultCount[condition] === 0).length / results.length
}

const IE_TYPES = ['single-session-user', 'single-session-assistant', 'single-session-preference']

export function renderTables(results: QuestionResult[]): string {
  const answerable = results.filter(r => !r.abstention)
  const abstention = results.filter(r => r.abstention)
  const types = [...new Set(answerable.map(r => r.questionType))].sort()
  const rows: [string, QuestionResult[]][] = [
    ...types.map((t): [string, QuestionResult[]] => [t, answerable.filter(r => r.questionType === t)]),
    ['information-extraction (single-session-*)', answerable.filter(r => IE_TYPES.includes(r.questionType))],
    ['overall (non-abstention)', answerable],
  ]
  const f = (x: number) => x.toFixed(3)
  const out = [
    '| question_type | n | real R@5 | real R@10 | real MRR | qdate R@5 | qdate R@10 | qdate MRR | chance R@5 | chance R@10 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const [label, rs] of rows) {
    const a = score(rs, 'real')
    const b = score(rs, 'qdate')
    const c = chanceScore(rs)
    out.push(`| ${label} | ${a.n} | ${f(a.r5)} | ${f(a.r10)} | ${f(a.mrr)} | ${f(b.r5)} | ${f(b.r10)} | ${f(b.mrr)} | ${f(c.r5)} | ${f(c.r10)} |`)
  }
  out.push(
    '',
    '| abstention (0 results returned) | n | real | qdate |',
    '|---|---:|---:|---:|',
    `| \`_abs\` questions (higher = better) | ${abstention.length} | ${f(emptyRate(abstention, 'real'))} | ${f(emptyRate(abstention, 'qdate'))} |`,
    `| non-abstention questions (reference) | ${answerable.length} | ${f(emptyRate(answerable, 'real'))} | ${f(emptyRate(answerable, 'qdate'))} |`,
    '',
    `log-archive results returned (all ${results.length} questions): ` +
      CONDITIONS.map(c => `${c}=${results.reduce((sum, r) => sum + r.archiveCount[c], 0)}`).join(' '),
  )
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const setIdx = process.argv.indexOf('--set')
  const set = setIdx >= 0 ? process.argv[setIdx + 1] : 'oracle'
  if (set !== 'oracle' && set !== 's') throw new Error(`--set must be oracle or s (got ${set})`)
  const dataPath = fileURLToPath(new URL(`../../../longmemeval/data/longmemeval_${set}.json`, import.meta.url))

  const raw: unknown = JSON.parse(readFileSync(dataPath, 'utf8'))
  const entries = z.array(LmeEntrySchema).parse(raw)

  const started = Date.now()
  const results: QuestionResult[] = []
  let sessionCount = 0
  for (const entry of entries) {
    sessionCount += entry.haystack_sessions.length
    results.push(await runQuestion(entry))
    if (results.length % 50 === 0) {
      process.stderr.write(`${results.length}/${entries.length} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`)
    }
  }

  process.stdout.write(`set=${set} questions=${entries.length} avgSessionsPerQuestion=${(sessionCount / entries.length).toFixed(1)}\n\n`)
  process.stdout.write(renderTables(results) + '\n')
  process.stderr.write(`elapsed ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
    process.exit(1)
  })
}
