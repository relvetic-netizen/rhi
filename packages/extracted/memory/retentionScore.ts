// Retention Score — Phase 14 of the PHOTON-inspired memory hierarchy.
//
// The final softmax-style "fixed budget" constraint in Relvetia is retention:
// which entries survive the nightly distill, and which get promoted, merged,
// or dropped. Phase 11-13 identified *where* to split topics; Phase 14
// decides *what* to keep within each chunk under the Screening-Is-Enough
// philosophy: absolute thresholds, hard sparsity, no fixed-size competition.
//
// Each entry receives a retention score in [0, 1] combining six signals:
//
//   hit         — usage-weighted utility (log2(hitCount+1), penalty-modulated)
//   centrality  — concept-graph centrality (sum of edge weights in the
//                  weighted graph from Phase 13; captures "bridge" entries)
//   novelty     — inverse similarity to other entries in the same topic
//                  (high = unique within its chunk, low = redundant)
//   diversity   — source breadth (distinct source log files); preserves
//                  entries that span multiple events over time
//   recency     — exponential decay on `updated`; half-life from config
//   bridge      — binary 1.0 if the entry's concepts span ≥ 2 Louvain
//                  communities (from Phase 13 analysis); these entries
//                  are structural glue and MUST be protected
//
// Each signal is weighted via screeningConfig.retentionW_* and combined:
//
//   retentionScore = clip01(
//       w_hit       * hit
//     + w_central   * centrality
//     + w_novelty   * novelty
//     + w_diversity * diversity
//     + w_recency   * recency
//     + w_bridge    * bridge
//   ) / (w_hit + w_central + w_novelty + w_diversity + w_recency + w_bridge)
//
// Entries below retentionThreshold are candidates for promotion/merge within
// their topic. The threshold lives in screeningConfig so Hill-Climb can
// benchmark-tune it, consistent with Phase 10's eval framework.
//
// Philosophy: this module *scores*. It does not evict. Distillation decides
// what to do with low-scoring entries — typically merge them into a
// summary block or promote them to a sub-topic. Never delete silently.

import {
  buildIdfMap,
  tfidfVector,
  cosineSimilarity,
} from '../screening/screening.js'
import type { ResidualEntry } from './residualIndex.js'
import type { EntryStats } from './memoryStats.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RetentionSignals = {
  hit: number
  centrality: number
  novelty: number
  diversity: number
  recency: number
  bridge: number
}

export type RetentionWeights = {
  hit: number
  centrality: number
  novelty: number
  diversity: number
  recency: number
  bridge: number
}

export type RetentionConfig = {
  threshold: number
  halfLifeMs: number
  weights: RetentionWeights
}

export type RetentionScore = {
  entryId: string
  signals: RetentionSignals
  score: number
  /** True when score >= threshold (keep as-is). */
  passes: boolean
  /** True when entry is flagged as a bridge node (must protect). */
  isBridge: boolean
}

// ---------------------------------------------------------------------------
// Signal computations
// ---------------------------------------------------------------------------

/**
 * Hit signal: log2(hitCount + 1) normalized by a soft ceiling, modulated by
 * penalty. Range [0, 1]. 0 hits → 0.0. ~31 hits → 1.0 (log2(32)=5).
 * Penalty of 0.9 (max) multiplies by 0.1.
 */
export function computeHitSignal(stats: EntryStats | undefined): number {
  if (!stats) return 0
  const hits = Math.max(0, stats.hitCount)
  const raw = Math.log2(hits + 1) / 5 // log2(32)=5 is soft ceiling
  const penalty = Math.min(1, Math.max(0, stats.penalty))
  return Math.min(1, Math.max(0, raw * (1 - penalty)))
}

/**
 * Centrality signal: fraction of total weighted edges this entry's concepts
 * participate in. Range [0, 1]. Uses the 4-signal weighted graph from
 * Phase 13 (directLink×3 + sourceOverlap×4 + adamicAdar×1.5 + typeAffinity×1).
 */
export function computeCentralitySignal(
  entry: ResidualEntry,
  weightedEdges: Map<string, Map<string, number>>,
  totalWeight: number,
): number {
  if (totalWeight <= 0) return 0
  let sum = 0
  for (const concept of entry.concepts) {
    const neighbors = weightedEdges.get(concept)
    if (!neighbors) continue
    for (const w of neighbors.values()) sum += w
  }
  // Each edge is counted once per endpoint — divide by 2 to get a symmetric
  // fraction. Normalize by totalWeight (already summed symmetrically).
  const frac = sum / 2 / totalWeight
  return Math.min(1, Math.max(0, frac * 10)) // centrality is usually tiny;
                                               // scale by 10 so realistic
                                               // entries land in [0, 1]
}

/**
 * Novelty signal: 1 - maxCosine(this entry, any other in same topic).
 * Range [0, 1]. Unique entries score high; near-duplicates score low.
 * Empty/single-entry topics return 1.0 (nothing to be redundant against).
 */
export function computeNoveltySignal(
  entry: ResidualEntry,
  sameTopicEntries: ResidualEntry[],
): number {
  const others = sameTopicEntries.filter(e => e.id !== entry.id)
  if (others.length === 0) return 1

  const entryText = `${entry.summary} ${entry.concepts.join(' ')}`
  const otherTexts = others.map(e => `${e.summary} ${e.concepts.join(' ')}`)
  const corpus = [entryText, ...otherTexts]
  const idf = buildIdfMap(corpus)
  const entryVec = tfidfVector(entryText, idf)

  let maxSim = 0
  for (const t of otherTexts) {
    const sim = cosineSimilarity(entryVec, tfidfVector(t, idf))
    if (sim > maxSim) maxSim = sim
  }
  return Math.min(1, Math.max(0, 1 - maxSim))
}

/**
 * Diversity signal: distinct source file count normalized by a soft ceiling.
 * Range [0, 1]. 1 source → low (0.2), 5+ sources → 1.0.
 * Captures entries whose insight spans many sessions/days.
 */
export function computeDiversitySignal(entry: ResidualEntry): number {
  const distinctFiles = new Set(
    entry.sources.map(s => s.replace(/:L\d+$/, '')),
  )
  if (distinctFiles.size === 0) return 0
  // 1 source = 0.2, 5+ sources = 1.0 (saturating linear)
  return Math.min(1, distinctFiles.size / 5)
}

/**
 * Recency signal: exponential decay on `updated`. Range [0, 1].
 * Now → 1.0, one half-life ago → 0.5, two half-lives ago → 0.25.
 */
export function computeRecencySignal(
  entry: ResidualEntry,
  now: number,
  halfLifeMs: number,
): number {
  const updatedMs = Date.parse(entry.updated)
  if (isNaN(updatedMs)) return 0.5 // unparseable date → neutral
  const ageMs = Math.max(0, now - updatedMs)
  return Math.pow(0.5, ageMs / halfLifeMs)
}

/**
 * Bridge signal: 1.0 when the entry's concepts span ≥ 2 distinct Louvain
 * communities, else 0.0. Bridge entries are structural glue — protect them.
 */
export function computeBridgeSignal(
  entry: ResidualEntry,
  conceptToCommunity: Map<string, number>,
): number {
  const communities = new Set<number>()
  for (const c of entry.concepts) {
    const cid = conceptToCommunity.get(c)
    if (cid !== undefined) communities.add(cid)
  }
  return communities.size >= 2 ? 1 : 0
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

function sumWeights(w: RetentionWeights): number {
  return w.hit + w.centrality + w.novelty + w.diversity + w.recency + w.bridge
}

/**
 * Compute the retention score for a single entry given all required context.
 * Pure function — no I/O.
 */
export function computeRetentionScore(
  entry: ResidualEntry,
  ctx: {
    stats: EntryStats | undefined
    weightedEdges: Map<string, Map<string, number>>
    totalEdgeWeight: number
    conceptToCommunity: Map<string, number>
    sameTopicEntries: ResidualEntry[]
    now: number
    config: RetentionConfig
  },
): RetentionScore {
  const signals: RetentionSignals = {
    hit: computeHitSignal(ctx.stats),
    centrality: computeCentralitySignal(entry, ctx.weightedEdges, ctx.totalEdgeWeight),
    novelty: computeNoveltySignal(entry, ctx.sameTopicEntries),
    diversity: computeDiversitySignal(entry),
    recency: computeRecencySignal(entry, ctx.now, ctx.config.halfLifeMs),
    bridge: computeBridgeSignal(entry, ctx.conceptToCommunity),
  }

  const w = ctx.config.weights
  const denom = sumWeights(w)
  const rawScore = denom > 0
    ? (w.hit * signals.hit
      + w.centrality * signals.centrality
      + w.novelty * signals.novelty
      + w.diversity * signals.diversity
      + w.recency * signals.recency
      + w.bridge * signals.bridge) / denom
    : 0

  const score = Math.min(1, Math.max(0, rawScore))
  const isBridge = signals.bridge === 1

  return {
    entryId: entry.id,
    signals,
    score,
    // Bridge entries are always retained regardless of other signals.
    passes: isBridge || score >= ctx.config.threshold,
    isBridge,
  }
}

/**
 * Compute total edge weight of the weighted graph (used for centrality
 * normalization). Summed once over all edges counted twice (endpoint view).
 */
export function totalEdgeWeight(
  weightedEdges: Map<string, Map<string, number>>,
): number {
  let total = 0
  for (const neighbors of weightedEdges.values()) {
    for (const w of neighbors.values()) total += w
  }
  return total
}
