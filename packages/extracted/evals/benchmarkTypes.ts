// Benchmark types — Relvetia vs Vanilla A/B comparison.
//
// Follows evalTypes.ts pattern: Zod schemas, lazy init, safeParse + fallback.
// Measures 5 categories across 3 conditions (Vanilla, Flat Memory, Relvetia).

import { z } from 'zod/v4'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const BenchmarkCategorySchema = z.enum([
  'cross-session-recall',
  'preference-adherence',
  'context-token-efficiency',
  'task-accuracy-prior',
  'noise-rejection',
])
export type BenchmarkCategory = z.infer<typeof BenchmarkCategorySchema>

export const BenchmarkConditionSchema = z.enum([
  'vanilla',
  'flat-memory',
  'relvetia',
])
export type BenchmarkCondition = z.infer<typeof BenchmarkConditionSchema>

// ---------------------------------------------------------------------------
// Scenario — single test case
// ---------------------------------------------------------------------------

export const BenchmarkScenarioSchema = z.object({
  id: z.string(),
  category: BenchmarkCategorySchema,
  query: z.string(),
  memoryEntries: z.array(z.string()),
  /** Indices that SHOULD be found (recall targets). */
  expectedMatchIndices: z.array(z.number().int().min(0)).optional(),
  /** Indices of user preference entries (for MRR scoring). */
  preferenceIndices: z.array(z.number().int().min(0)).optional(),
  /** Indices of correct/current entries. */
  correctIndices: z.array(z.number().int().min(0)).optional(),
  /** Indices of outdated/contradicted entries. */
  outdatedIndices: z.array(z.number().int().min(0)).optional(),
  /** Indices of noise (irrelevant) entries. */
  noiseIndices: z.array(z.number().int().min(0)).optional(),
  description: z.string(),
})
export type BenchmarkScenario = z.infer<typeof BenchmarkScenarioSchema>

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export const ConditionResultSchema = z.object({
  condition: BenchmarkConditionSchema,
  score: z.number().min(0).max(1),
  returnedCount: z.number().int().min(0),
  returnedCharCount: z.number().int().min(0),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type ConditionResult = z.infer<typeof ConditionResultSchema>

export const ScenarioResultSchema = z.object({
  scenarioId: z.string(),
  category: BenchmarkCategorySchema,
  results: z.array(ConditionResultSchema),
})
export type ScenarioResult = z.infer<typeof ScenarioResultSchema>

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export const CategoryScoreSchema = z.object({
  vanilla: z.number(),
  flatMemory: z.number(),
  relvetia: z.number(),
  deltaKV: z.number(),
})
export type CategoryScore = z.infer<typeof CategoryScoreSchema>

export const BenchmarkSummarySchema = z.object({
  categoryScores: z.record(z.string(), CategoryScoreSchema),
  overall: CategoryScoreSchema,
})
export type BenchmarkSummary = z.infer<typeof BenchmarkSummarySchema>

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export const BenchmarkRunSchema = z.object({
  runId: z.string(),
  timestamp: z.string(),
  configSnapshot: z.record(z.string(), z.union([z.number(), z.boolean()])),
  scenarioResults: z.array(ScenarioResultSchema),
  summary: BenchmarkSummarySchema,
})
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>
