// Eval framework type definitions with Zod validation.
//
// Follows the screeningConfig.ts pattern: Zod schemas with bounds checking,
// lazy initialization, safeParse + fallback to defaults.
//
// These types power the Better-Harness eval pipeline:
//   EvalCase → EvalRunner → EvalResult → EvalRun (with summary)

import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Eval Category
// ---------------------------------------------------------------------------

export const EvalCategorySchema = z.enum([
  'search-recall',       // Expected items should appear in screening results
  'search-precision',    // Irrelevant items should be rejected
  'novelty-accept',      // Novel observations should pass novelty screening
  'novelty-reject',      // Redundant observations should be rejected
  'cross-lingual',       // CJK↔English bridge should enable cross-language matching
  'concept-expansion',   // Concept graph should expand query reach
  'multi-resolution',    // Multi-resolution screening should catch vocabulary gaps
  // Memory Hardening Phase 5 T5-2 — entry-id-based assertions
  'privacy-safety-valve', // Private/forbidden entry IDs must NOT appear in screening results
  'stale-hit-reject',     // Stale entry IDs must NOT appear in screening results
])
export type EvalCategory = z.infer<typeof EvalCategorySchema>

// ---------------------------------------------------------------------------
// Eval Case — single test case
// ---------------------------------------------------------------------------

export const EvalCaseSchema = z.object({
  id: z.string(),
  category: EvalCategorySchema,
  query: z.string(),
  memoryEntries: z.array(z.string()),
  /** For search-* categories: indices into memoryEntries that SHOULD match. */
  expectedMatchIndices: z.array(z.number().int().min(0)).optional(),
  /** For novelty-* categories: true = should pass as novel. */
  expectedNovel: z.boolean().optional(),
  /**
   * Memory Hardening Phase 5 T5-2 — parallel array (1:1 with memoryEntries)
   * supplying real entry IDs so privacy-safety-valve / stale-hit-reject
   * categories can assert against IDs instead of positional indices.
   *
   * If present, `memoryEntryIds.length` must equal `memoryEntries.length`.
   */
  memoryEntryIds: z.array(z.string()).optional(),
  /** Entry IDs that MUST appear in screening results (entry-id alternative to expectedMatchIndices). */
  mustHitEntryIds: z.array(z.string()).optional(),
  /** Entry IDs that MUST NOT appear in screening results (privacy / staleness gate). */
  mustNotHitEntryIds: z.array(z.string()).optional(),
  /** Glob-like prefixes (substring match against entry IDs) that MUST NOT appear in results. */
  forbiddenIdPrefixes: z.array(z.string()).optional(),
  description: z.string(),
  source: z.enum(['seed', 'benchmark', 'e2e', 'auto-generated', 'manual']),
  tags: z.array(z.string()).optional(),
  createdAt: z.string(),
})
export type EvalCase = z.infer<typeof EvalCaseSchema>

// ---------------------------------------------------------------------------
// Eval Result — outcome of a single case execution
// ---------------------------------------------------------------------------

export const EvalResultSchema = z.object({
  caseId: z.string(),
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  details: z.record(z.string(), z.unknown()).optional(),
  executedAt: z.string(),
})
export type EvalResult = z.infer<typeof EvalResultSchema>

// ---------------------------------------------------------------------------
// Eval Suite — collection of all cases
// ---------------------------------------------------------------------------

export const EvalSuiteSchema = z.object({
  version: z.number().int().min(1),
  cases: z.array(EvalCaseSchema),
})
export type EvalSuite = z.infer<typeof EvalSuiteSchema>

// ---------------------------------------------------------------------------
// Eval Run Summary
// ---------------------------------------------------------------------------

export const EvalRunSummarySchema = z.object({
  totalCases: z.number().int().min(0),
  passedCases: z.number().int().min(0),
  passRate: z.number().min(0).max(1),
  avgScore: z.number().min(0).max(1),
  categoryScores: z.record(z.string(), z.number().min(0).max(1)),
})
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>

// ---------------------------------------------------------------------------
// Eval Run — results from a single execution of the suite
// ---------------------------------------------------------------------------

export const EvalRunSchema = z.object({
  runId: z.string(),
  configSnapshot: z.record(z.string(), z.union([z.number(), z.boolean()])),
  timestamp: z.string(),
  results: z.array(EvalResultSchema),
  summary: EvalRunSummarySchema,
})
export type EvalRun = z.infer<typeof EvalRunSchema>

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

let _suiteSchema: z.ZodType<EvalSuite, any> | null = null

function getSuiteSchema(): z.ZodType<EvalSuite, any> {
  if (!_suiteSchema) _suiteSchema = EvalSuiteSchema
  return _suiteSchema
}

const EMPTY_SUITE: EvalSuite = { version: 1, cases: [] }

/** Parse a raw object as an EvalSuite. Returns empty suite on failure. */
export function parseEvalSuite(raw: unknown): EvalSuite {
  const parsed = getSuiteSchema().safeParse(raw)
  return parsed.success ? parsed.data : EMPTY_SUITE
}

let _runSchema: z.ZodType<EvalRun, any> | null = null

function getRunSchema(): z.ZodType<EvalRun, any> {
  if (!_runSchema) _runSchema = EvalRunSchema
  return _runSchema
}

/** Parse a raw object as an EvalRun. Returns null on failure. */
export function parseEvalRun(raw: unknown): EvalRun | null {
  const parsed = getRunSchema().safeParse(raw)
  return parsed.success ? parsed.data : null
}
