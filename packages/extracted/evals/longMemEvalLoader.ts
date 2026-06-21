// LongMemEval loader — converts the LongMemEval oracle corpus into EvalCases.
//
// LongMemEval (67K-line oracle JSON at longmemeval/data/longmemeval_oracle.json)
// is the golden retention test: after retention-scored compaction, can the
// screening system still answer multi-turn questions grounded in earlier
// sessions? This loader synthesizes `search-recall` cases from each question.
//
// Shape of one oracle entry (trimmed):
//   {
//     "question_id": "gpt4_...",
//     "question_type": "temporal-reasoning" | "knowledge-update" | ...,
//     "question": "...",
//     "answer": "...",
//     "haystack_sessions": [ [{ role, content, has_answer }, ...], ... ]
//   }
//
// Conversion: flatten every message in every haystack session into a memory
// entry; the question is the query; expectedMatchIndices point at messages
// where `has_answer === true` (oracle-labeled ground truth).
//
// This module is pure — loader only. The eval runner consumes standard
// EvalCase objects and runs them through screening exactly like seed cases.

import { readFile } from 'fs/promises'
import { z } from 'zod/v4'
import type { EvalCase, EvalSuite } from './evalTypes.js'

// ---------------------------------------------------------------------------
// Oracle schema (partial — only fields we consume)
// ---------------------------------------------------------------------------

const OracleMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  has_answer: z.boolean().optional(),
})

const OracleEntrySchema = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  answer: z.string(),
  haystack_sessions: z.array(z.array(OracleMessageSchema)),
})

type OracleEntry = z.infer<typeof OracleEntrySchema>

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export type LongMemEvalOptions = {
  /** Max entries to include (default: 50). Full corpus is 500+. */
  maxEntries?: number
  /** Filter by question type (e.g. 'temporal-reasoning'). */
  questionTypes?: string[]
  /** Truncate each message to this character count (default: 500). */
  maxMessageChars?: number
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

export function oracleEntryToEvalCase(
  entry: OracleEntry,
  createdAt: string,
  maxMessageChars: number,
): EvalCase {
  // Flatten all messages across all haystack sessions into a flat corpus.
  const memoryEntries: string[] = []
  const expectedIndices: number[] = []

  for (const session of entry.haystack_sessions) {
    for (const msg of session) {
      const idx = memoryEntries.length
      memoryEntries.push(truncate(`[${msg.role}] ${msg.content}`, maxMessageChars))
      if (msg.has_answer) expectedIndices.push(idx)
    }
  }

  return {
    id: `lme_${entry.question_id}`,
    category: 'search-recall',
    query: entry.question,
    memoryEntries,
    expectedMatchIndices: expectedIndices,
    description: `LongMemEval (${entry.question_type}): ${truncate(entry.question, 100)}`,
    source: 'benchmark',
    tags: ['longmemeval', entry.question_type],
    createdAt,
  }
}

/**
 * Load the LongMemEval oracle JSON and convert to an EvalSuite.
 *
 * Each question becomes one search-recall case whose memoryEntries are the
 * flattened haystack messages. The ground truth (expectedMatchIndices)
 * comes from oracle-labeled has_answer=true messages.
 */
export async function loadLongMemEvalSuite(
  oraclePath: string,
  options: LongMemEvalOptions = {},
): Promise<EvalSuite> {
  const maxEntries = options.maxEntries ?? 50
  const maxMessageChars = options.maxMessageChars ?? 500
  const typeFilter = options.questionTypes ? new Set(options.questionTypes) : null

  const raw = await readFile(oraclePath, 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`LongMemEval oracle is not an array: ${oraclePath}`)
  }

  const createdAt = new Date().toISOString()
  const cases: EvalCase[] = []

  for (const rawEntry of parsed) {
    if (cases.length >= maxEntries) break
    const validated = OracleEntrySchema.safeParse(rawEntry)
    if (!validated.success) continue
    const entry = validated.data
    if (typeFilter && !typeFilter.has(entry.question_type)) continue
    // Skip entries with no ground-truth messages — can't score recall.
    const hasAnswer = entry.haystack_sessions.some(s => s.some(m => m.has_answer))
    if (!hasAnswer) continue
    cases.push(oracleEntryToEvalCase(entry, createdAt, maxMessageChars))
  }

  return { version: 1, cases }
}
