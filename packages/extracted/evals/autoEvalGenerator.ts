// Auto eval generator ��� creates new eval cases from runtime events.
//
// When the screening pipeline encounters edge cases (safety valve, verification
// misses, user corrections), this module converts them into eval cases that
// prevent future regressions.

import type { EvalCase } from './evalTypes.js'

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

let _autoCounter = 0

function nextId(prefix: string): string {
  return `auto_${prefix}_${String(++_autoCounter).padStart(4, '0')}`
}

/**
 * Generate an eval case from a safety valve activation.
 *
 * Safety valve fires when screenItems() rejects ALL items (everything below
 * threshold). The query that triggered this is interesting — it should have
 * found SOMETHING, so we record it as a search-recall case.
 */
export function generateEvalFromSafetyValve(
  query: string,
  memoryTexts: string[],
  timestamp: string,
): EvalCase {
  // We don't know which entries SHOULD match (that's the problem),
  // so we mark all indices as potential matches. The human review
  // or subsequent optimization will refine this.
  return {
    id: nextId('valve'),
    category: 'search-recall',
    query,
    memoryEntries: memoryTexts,
    expectedMatchIndices: [], // Empty = just test that SOMETHING passes
    description: `Safety valve activation: "${query.slice(0, 50)}..." found no matches`,
    source: 'auto-generated',
    tags: ['safety-valve', 'auto'],
    createdAt: timestamp,
  }
}

/**
 * Generate an eval case from a distill verification miss.
 *
 * When distillVerifier finds an entry that can't be retrieved via search,
 * the entry's concepts and summary become a search-recall test case.
 */
export function generateEvalFromVerification(
  entryId: string,
  entrySummary: string,
  entryConcepts: string[],
  memoryTexts: string[],
  timestamp: string,
): EvalCase {
  // Use concepts as the query (that's what should find the entry)
  const query = entryConcepts.join(' ') + ' ' + entrySummary.split(' ').slice(0, 5).join(' ')

  return {
    id: nextId('verify'),
    category: 'search-recall',
    query,
    memoryEntries: memoryTexts,
    expectedMatchIndices: [], // Would need manual annotation
    description: `Verification miss: entry "${entryId}" not found via search`,
    source: 'auto-generated',
    tags: ['verification-miss', 'auto'],
    createdAt: timestamp,
  }
}

/**
 * Generate an eval case from a user correction.
 *
 * When a user says "that's wrong" or corrects a search result, the original
 * query + expected result becomes a regression test.
 */
export function generateEvalFromUserCorrection(
  query: string,
  expectedEntryIndex: number,
  memoryTexts: string[],
  timestamp: string,
): EvalCase {
  return {
    id: nextId('correction'),
    category: 'search-recall',
    query,
    memoryEntries: memoryTexts,
    expectedMatchIndices: [expectedEntryIndex],
    description: `User correction: "${query.slice(0, 50)}..." should find entry at index ${expectedEntryIndex}`,
    source: 'auto-generated',
    tags: ['user-correction', 'auto'],
    createdAt: timestamp,
  }
}

// ---------------------------------------------------------------------------
// Safety valve callback (for integration with memoryScreening.ts)
// ---------------------------------------------------------------------------

export type SafetyValveCallback = (query: string, memoryTexts: string[]) => void

let _pendingCases: EvalCase[] = []

/** Get and clear pending auto-generated cases. */
export function drainPendingCases(): EvalCase[] {
  const cases = _pendingCases
  _pendingCases = []
  return cases
}

/**
 * Create a safety valve callback that buffers auto-generated eval cases.
 * Use with setOnSafetyValve() from memoryScreening.ts.
 */
export function createSafetyValveHandler(): SafetyValveCallback {
  return (query: string, memoryTexts: string[]) => {
    const evalCase = generateEvalFromSafetyValve(
      query,
      memoryTexts,
      new Date().toISOString(),
    )
    _pendingCases.push(evalCase)
  }
}
