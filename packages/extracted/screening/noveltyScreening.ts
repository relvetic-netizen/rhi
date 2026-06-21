// Novelty screening — inverse Trim-and-Square for write-side filtering.
//
// The read-side screening (screening.ts) keeps items SIMILAR to a query.
// Novelty screening does the OPPOSITE: keeps items DISSIMILAR to existing
// memory — i.e., genuinely new information worth recording.
//
// Mathematical symmetry with the paper's Trim-and-Square:
//   Read:  α = [max(1 - r·(1 - s), 0)]²   →  high similarity → pass
//   Write: α = [max(1 - r·s, 0)]²          →  low similarity → pass (novel)
//
// When an observation's max similarity to ANY existing memory exceeds 1/r,
// its novelty score is exactly zero — complete rejection of redundant info.
// This is the Screening philosophy applied to the write side.

import {
  tokenize,
  buildIdfMap,
  tfidfVector,
  cosineSimilarity,
  type ScoredItem,
} from './screening.js'
import { logScreeningEvent } from './screeningLog.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NoveltyConfig = {
  /** Similarity threshold above which an observation is considered redundant.
   *  Must be in (0, 0.5]. Sharpness r is derived as 1/threshold, clamped to
   *  r >= 2 per the paper's constraint. Observations with max similarity to
   *  any memory > threshold are scored exactly zero. */
  threshold: number
  /** Maximum number of novel observations to return per invocation. */
  maxObservations: number
}

// ---------------------------------------------------------------------------
// Inverse Trim-and-Square
// ---------------------------------------------------------------------------

/**
 * Inverse Trim-and-Square: scores NOVELTY, not relevance.
 *
 * α = [max(1 - r·s, 0)]²
 *
 * When similarity s > 1/r, the novelty score is exactly 0 (redundant).
 * When s is low (dissimilar to all existing memory), the score is high (novel).
 *
 * @param similarity - Max cosine similarity to any existing memory item [0, 1]
 * @param r - Sharpness parameter. Higher = stricter novelty requirement.
 * @returns Novelty score in [0, 1]. Exactly 0 for redundant observations.
 */
export function trimAndSquareNovelty(similarity: number, r: number): number {
  const raw = 1 - r * similarity
  const trimmed = Math.max(raw, 0)
  return trimmed * trimmed
}

// ---------------------------------------------------------------------------
// Observation splitting
// ---------------------------------------------------------------------------

/**
 * Split text into individual observation candidates at sentence boundaries.
 * Filters out fragments shorter than 15 chars (noise).
 */
export function splitIntoObservations(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length >= 15)
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Screen observations for novelty against existing memory.
 *
 * Each observation is compared to ALL existing memory items. If the
 * observation's MAX similarity to any memory item exceeds the threshold,
 * it is scored exactly zero (redundant, not worth recording).
 *
 * This is the write-side counterpart to screenItems (read-side).
 *
 * @param observations - Candidate observation strings
 * @param existingMemory - Existing memory texts to compare against
 * @param config - Novelty screening configuration
 * @returns Observations that passed novelty screening (genuinely new info),
 *          sorted by novelty score descending.
 *          Returns all observations if existingMemory is empty (everything is novel).
 */
export function screenForNovelty(
  observations: string[],
  existingMemory: string[],
  config: NoveltyConfig,
): ScoredItem<string>[] {
  if (observations.length === 0) return []

  // When no existing memory, everything is novel.
  if (existingMemory.length === 0) {
    return observations
      .slice(0, config.maxObservations)
      .map(obs => ({ item: obs, score: 1.0 }))
  }

  // Build IDF map from all documents (existing memory + observations).
  const allTexts = [...existingMemory, ...observations]
  const idfMap = buildIdfMap(allTexts)

  // Pre-compute memory vectors once.
  const memoryVecs = existingMemory.map(m => tfidfVector(m, idfMap))

  // Derive sharpness from threshold: r = 1/threshold, clamped to r >= 2.
  const r = Math.max(1 / config.threshold, 2)
  const scored: ScoredItem<string>[] = []

  for (const obs of observations) {
    const obsVec = tfidfVector(obs, idfMap)
    if (obsVec.size === 0) continue

    // Find MAX similarity to any existing memory item.
    let maxSim = 0
    for (const memVec of memoryVecs) {
      const sim = cosineSimilarity(obsVec, memVec)
      if (sim > maxSim) maxSim = sim
    }

    // Apply inverse Trim-and-Square.
    const novelty = trimAndSquareNovelty(maxSim, r)

    if (novelty > 0) {
      scored.push({ item: obs, score: novelty })
    }
  }

  // Also check inter-observation redundancy: if two new observations are
  // very similar to each other, keep only the first one.
  const deduped: ScoredItem<string>[] = []
  const keptVecs: Map<string, number>[] = []

  for (const s of scored) {
    const obsVec = tfidfVector(s.item, idfMap)
    let isDuplicate = false
    for (const keptVec of keptVecs) {
      if (cosineSimilarity(obsVec, keptVec) > 1 / r) {
        isDuplicate = true
        break
      }
    }
    if (!isDuplicate) {
      deduped.push(s)
      keptVecs.push(obsVec)
    }
  }

  // Sort by novelty score descending and cap.
  deduped.sort((a, b) => b.score - a.score)
  const result = deduped.slice(0, config.maxObservations)

  const dedupRejected = scored.length - deduped.length
  if (scored.length === 0 && observations.length > 0) {
    logScreeningEvent('novelty_all_rejected', {
      observationCount: observations.length,
      memoryCount: existingMemory.length,
      message: 'All observations deemed redundant — nothing recorded',
    })
  } else {
    logScreeningEvent('novelty_screened', {
      observationCount: observations.length,
      novelCount: scored.length,
      dedupRejected,
      finalCount: result.length,
      memoryCount: existingMemory.length,
    })
  }

  return result
}
