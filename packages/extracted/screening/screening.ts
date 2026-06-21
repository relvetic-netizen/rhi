// Core screening algorithm inspired by "Screening Is Enough" (arXiv:2604.01178).
//
// Adapts the paper's Trim-and-Square absolute-threshold mechanism for text
// relevance filtering. Uses TF-IDF cosine similarity as the similarity measure
// (no embedding infrastructure required), then applies the paper's activation
// function to achieve hard sparsity: items below the threshold receive exactly
// zero relevance, not a small positive value.
//
// The key insight from the paper: softmax attention's sum-to-1 constraint
// forces irrelevant keys to steal weight from relevant ones (dilution).
// Screening evaluates each key independently against an absolute threshold,
// enabling complete rejection of irrelevant items.

import { STOPWORDS } from './stopwords.js'
import { stem } from './stemmer.js'
import { extractBridgeTokens } from './bilingualBridge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScreeningConfig = {
  /** Acceptance threshold in (0, 1). Items with similarity below this are
   *  completely rejected (mapped to exactly zero).
   *  Sharpness r is derived as 1/(1-threshold).
   *  For TF-IDF, practical range is 0.05-0.30 (short text similarities are low).
   *  For neural embeddings, 0.50-0.90 is typical. */
  threshold: number
  /** Hard cap on returned items (applied after screening). */
  maxResults: number
  /** When true, multiply screening scores by a recency decay factor. */
  boostRecency?: boolean
  /** Half-life in milliseconds for recency decay. */
  recencyHalfLifeMs?: number
}

export type ScoredItem<T> = {
  item: T
  /** Screening score. Exactly 0 for rejected items (never returned). */
  score: number
}

/** Diagnostic stats emitted by screenItems for observability. */
export type ScreeningStats = {
  /** Total items evaluated. */
  inputCount: number
  /** Items that passed screening (score > 0). */
  passedCount: number
  /** Minimum raw cosine similarity observed. */
  minSimilarity: number
  /** Maximum raw cosine similarity observed. */
  maxSimilarity: number
  /** Mean raw cosine similarity across all items. */
  avgSimilarity: number
  /** Sharpness parameter (r) derived from threshold. */
  sharpness: number
  /** Threshold used. */
  threshold: number
}

export type Bm25CorpusStats = {
  N: number
  avgdl: number
  df: Map<string, number>
  idf: Map<string, number>
  defaultIdf: number
}

/** Pre-tokenized corpus + per-doc term-frequency maps + BM25 stats. Built
 *  once per (corpus content version), reused across queries via the search
 *  cache (saga 11 engine-cache-layer). Also produced by `buildCorpusBundle()`
 *  for callers that want the double-tokenization fix without going through
 *  the cache. */
export type CorpusBundle = {
  /** Pre-tokenized doc tokens, parallel to the corpus items. */
  itemTokens: string[][]
  /** Pre-built per-doc term-frequency map, parallel to `itemTokens`. Each
   *  entry is `Map<term, count>` derived from `itemTokens[i]`. Consumed by
   *  `screenItemsBM25WithBundle()` so the per-query BM25 score loop becomes
   *  O(|queryTokens|) per doc instead of O(|docTokens| + |queryTokens|).
   *
   *  Saga 11 Option α (BM25 tf pre-build): pre-compute at bundle build time
   *  so per-query work shrinks. Memory: ~200 docs × ~50-500 tokens × Map
   *  entry overhead ≈ 200KB-500KB additional, acceptable. */
  itemTf: Map<string, number>[]
  /** Pre-built BM25 stats derived from `itemTokens` (zero re-tokenization). */
  stats: Bm25CorpusStats
}

export type Bm25ScreeningOptions = {
  k1?: number
  b?: number
  scale?: number
}

export type Bm25ScreeningStats = {
  inputCount: number
  passedCount: number
  rawMin: number
  rawMax: number
  rawAvg: number
  normalizedMin: number
  normalizedMax: number
  normalizedAvg: number
  sharpness: number
  threshold: number
  k1: number
  b: number
  scale: number
  avgdl: number
  N: number
}

// ---------------------------------------------------------------------------
// Diagnostics callback — set via setScreeningDiagnostics() to observe stats.
// ---------------------------------------------------------------------------

let _onDiagnostics: ((stats: ScreeningStats) => void) | null = null
let _onBm25Diagnostics: ((stats: Bm25ScreeningStats) => void) | null = null

/** Register a callback to receive screening diagnostics on every screenItems call. */
export function setScreeningDiagnostics(
  cb: ((stats: ScreeningStats) => void) | null,
): void {
  _onDiagnostics = cb
}

/** Register a callback to receive BM25 screening diagnostics. */
export function setBm25Diagnostics(
  cb: ((stats: Bm25ScreeningStats) => void) | null,
): void {
  _onBm25Diagnostics = cb
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

// CJK Unified Ideographs + CJK Ext A/B + Katakana + Hiragana + CJK Compat
const CJK_RANGE = /[\u3000-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]/

/**
 * Extract character bigrams from a CJK string.
 * Standard IR technique for languages without word boundaries (Japanese,
 * Chinese). Zero external dependencies — no morphological analyzer needed.
 *
 * "データベース" → ["デー", "ータ", "タベ", "ベー", "ース"]
 * "東京都" and "東京" share bigram "東京" → similarity > 0
 */
function cjkBigrams(text: string): string[] {
  const bigrams: string[] = []
  for (let i = 0; i < text.length - 1; i++) {
    if (CJK_RANGE.test(text[i]!) && CJK_RANGE.test(text[i + 1]!)) {
      bigrams.push(text[i]! + text[i + 1]!)
    }
  }
  return bigrams
}

/**
 * Split text into tokens for TF-IDF vectorization.
 *
 * English/alphanumeric: split on whitespace, remove stopwords and short tokens.
 * CJK (Japanese/Chinese): extract character bigrams — the standard zero-dependency
 * approach for languages without word boundaries. This allows "東京都" and "東京"
 * to share the bigram "東京", producing non-zero similarity.
 *
 * Enhancements for semantic gap recall:
 *   - Stemming: English tokens are stemmed (e.g., "failures"→"fail") and both
 *     original + stem are emitted, so inflectional variants match.
 *   - Bilingual bridge: katakana words produce English tokens and vice versa,
 *     enabling cross-lingual TF-IDF matching (e.g., "データベース"↔"database").
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()

  // Separate CJK runs from ASCII/Latin runs.
  // Replace non-alphanumeric, non-CJK chars with spaces.
  const cleaned = lower.replace(/[^a-z0-9\u3000-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]+/g, ' ')

  // Extract ASCII word tokens (original behavior).
  const asciiTokens = cleaned
    .replace(/[\u3000-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))

  // Stemming: emit both original and stemmed form for each ASCII token.
  // This preserves exact-match signal while enabling stem-level recall.
  const stemmedTokens: string[] = []
  for (const t of asciiTokens) {
    stemmedTokens.push(t)
    const s = stem(t)
    if (s !== t && s.length > 1) {
      stemmedTokens.push(s)
    }
  }

  // Extract CJK bigrams from CJK character runs.
  const cjkTokens = cjkBigrams(cleaned)

  // Bilingual bridge: cross-lingual token expansion.
  // Uses the original (pre-cleaned) text for katakana/kanji word extraction,
  // and the ASCII tokens for English→CJK direction.
  const rawBridgeTokens = extractBridgeTokens(text, asciiTokens)

  // Apply stemming to bridge tokens too, so bridge "monitoring" also
  // produces "monitor" (matching stemmed query tokens).
  const bridgeTokens: string[] = []
  for (const t of rawBridgeTokens) {
    bridgeTokens.push(t)
    const s = stem(t)
    if (s !== t && s.length > 1) {
      bridgeTokens.push(s)
    }
  }

  return [...stemmedTokens, ...cjkTokens, ...bridgeTokens]
}

// ---------------------------------------------------------------------------
// TF-IDF
// ---------------------------------------------------------------------------

/**
 * Build an inverse document frequency map from a corpus of documents.
 * idf(term) = ln(N / (1 + df(term))) where df counts documents containing term.
 */
export function buildIdfMap(documents: string[]): Map<string, number> {
  const N = documents.length
  if (N === 0) return new Map()

  const df = new Map<string, number>()
  for (const doc of documents) {
    const unique = new Set(tokenize(doc))
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const idfMap = new Map<string, number>()
  for (const [term, count] of df) {
    idfMap.set(term, Math.log(N / (1 + count)))
  }
  return idfMap
}

/**
 * Compute a sparse TF-IDF vector for a single document.
 * TF is raw count; IDF comes from the precomputed map.
 * Terms not in the IDF map get a default high IDF (rare term boost).
 */
export function tfidfVector(
  text: string,
  idfMap: Map<string, number>,
): Map<string, number> {
  const tokens = tokenize(text)
  const tf = new Map<string, number>()
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }

  // Default IDF for terms not in the corpus — treat as maximally informative.
  const defaultIdf =
    idfMap.size > 0
      ? Math.max(...idfMap.values()) + 1
      : 1

  const vec = new Map<string, number>()
  for (const [term, count] of tf) {
    const idf = idfMap.get(term) ?? defaultIdf
    vec.set(term, count * idf)
  }
  return vec
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

/**
 * Build Lucene-form BM25 corpus statistics from a corpus of documents.
 *
 * idf(term) = log(1 + (N - df + 0.5) / (df + 0.5))
 *
 * Unlike the legacy TF-IDF idf formula, this stays strictly positive for
 * corpus terms and is suitable for saturation normalization.
 */
export function buildBm25CorpusStats(documents: string[]): Bm25CorpusStats {
  const N = documents.length
  if (N === 0) {
    return {
      N: 0,
      avgdl: 0,
      df: new Map(),
      idf: new Map(),
      defaultIdf: 0,
    }
  }

  const df = new Map<string, number>()
  let totalDocLength = 0

  for (const doc of documents) {
    const tokens = tokenize(doc)
    totalDocLength += tokens.length
    const unique = new Set(tokens)
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + (N - count + 0.5) / (count + 0.5)))
  }

  return {
    N,
    avgdl: totalDocLength / N,
    df,
    idf,
    defaultIdf: Math.log(1 + (N + 0.5) / 0.5),
  }
}

/**
 * Build a `CorpusBundle` (pre-tokenized items + BM25 stats) from a corpus.
 *
 * Saga 11 engine-cache-layer: this is the cache-friendly factory. Consumers
 * either tokenize once via this helper and cache the result (production
 * path), or call the public `buildBm25CorpusStats` + per-item tokenize
 * (legacy path; tokenizes everything twice).
 *
 * The bundle returned here drives `screenItemsBM25WithBundle()` directly:
 * the per-item BM25 score loop reads `bundle.itemTokens[i]` instead of
 * re-tokenizing `itemTexts[i]` each query.
 */
export function buildCorpusBundle(itemTexts: string[]): CorpusBundle {
  const itemTokens = itemTexts.map(t => tokenize(t))
  const itemTf = itemTokens.map(tokens => {
    const tf = new Map<string, number>()
    for (const token of tokens) {
      tf.set(token, (tf.get(token) ?? 0) + 1)
    }
    return tf
  })
  const stats = buildBm25CorpusStatsFromTokens(itemTokens)
  return { itemTokens, itemTf, stats }
}

/** Same as `buildBm25CorpusStats(documents)` but consumes already-tokenized
 *  token arrays. Used inside `buildCorpusBundle` so we tokenize once per
 *  cached corpus instead of twice (once in buildBm25CorpusStats, once in
 *  the per-item BM25 loop). */
function buildBm25CorpusStatsFromTokens(itemTokens: string[][]): Bm25CorpusStats {
  const N = itemTokens.length
  if (N === 0) {
    return {
      N: 0,
      avgdl: 0,
      df: new Map(),
      idf: new Map(),
      defaultIdf: 0,
    }
  }

  const df = new Map<string, number>()
  let totalDocLength = 0

  for (const tokens of itemTokens) {
    totalDocLength += tokens.length
    const unique = new Set(tokens)
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const idf = new Map<string, number>()
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + (N - count + 0.5) / (count + 0.5)))
  }

  return {
    N,
    avgdl: totalDocLength / N,
    df,
    idf,
    defaultIdf: Math.log(1 + (N + 0.5) / 0.5),
  }
}

/**
 * Compute Okapi BM25 score from a pre-built per-doc term-frequency map and
 * shared corpus stats. Saga 11 Option α: skip the per-call tf rebuild that
 * `bm25Score()` does, which is O(|docTokens|) per doc per query.
 *
 * The returned score is identical to `bm25Score(queryTokens, docTokens,
 * stats, k1, b)` when `docTf` was built by counting `docTokens` and `dl`
 * equals `docTokens.length`. Tests assert numeric equality on the same
 * inputs.
 */
export function bm25ScoreWithTf(
  queryTokens: string[],
  docTf: Map<string, number>,
  dl: number,
  stats: Bm25CorpusStats,
  k1: number = 1.2,
  b: number = 0.75,
): number {
  if (stats.N === 0 || stats.avgdl === 0 || dl === 0 || k1 <= 0) {
    return 0
  }
  let score = 0
  for (const term of new Set(queryTokens)) {
    const termFrequency = docTf.get(term) ?? 0
    if (termFrequency === 0) continue
    const idf = stats.idf.get(term) ?? stats.defaultIdf
    const numerator = termFrequency * (k1 + 1)
    const denominator = termFrequency + k1 * (1 - b + b * dl / stats.avgdl)
    score += idf * (numerator / denominator)
  }
  return score
}

/**
 * Compute Okapi BM25 score for tokenized query and document.
 */
export function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  stats: Bm25CorpusStats,
  k1: number = 1.2,
  b: number = 0.75,
): number {
  if (stats.N === 0 || stats.avgdl === 0 || docTokens.length === 0 || k1 <= 0) {
    return 0
  }

  const tf = new Map<string, number>()
  for (const token of docTokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }

  let score = 0
  const dl = docTokens.length
  for (const term of new Set(queryTokens)) {
    const termFrequency = tf.get(term) ?? 0
    if (termFrequency === 0) continue

    const idf = stats.idf.get(term) ?? stats.defaultIdf
    const numerator = termFrequency * (k1 + 1)
    const denominator = termFrequency + k1 * (1 - b + b * dl / stats.avgdl)
    score += idf * (numerator / denominator)
  }

  return score
}

// ---------------------------------------------------------------------------
// Cosine Similarity
// ---------------------------------------------------------------------------

/** Cosine similarity between two sparse vectors. Returns [0, 1] for TF-IDF
 *  vectors (all non-negative). Returns 0 for zero vectors. */
export function cosineSimilarity(
  a: Map<string, number>,
  b: Map<string, number>,
): number {
  if (a.size === 0 || b.size === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0

  // Iterate over the smaller map for the dot product — we only hit terms
  // both vectors share, so iterating the smaller side is cheaper.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]

  for (const [term, valS] of small) {
    const valL = large.get(term)
    if (valL !== undefined) {
      dot += valS * valL
    }
    normA += valS * valS
  }
  for (const valL of large.values()) {
    normB += valL * valL
  }

  // normA = ‖small‖², normB = ‖large‖². The cosine denominator
  // sqrt(normA)*sqrt(normB) is symmetric, so it equals sqrt(‖a‖²)*sqrt(‖b‖²)
  // regardless of which vector was `small`. No swap needed.
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ---------------------------------------------------------------------------
// Trim-and-Square (Paper's Core Mechanism)
// ---------------------------------------------------------------------------

/**
 * Trim-and-Square activation from "Screening Is Enough".
 *
 * α = [max(1 - r·(1 - s), 0)]²
 *
 * Where `r` is the sharpness parameter (paper: r = e^(s_r) + 1).
 * When s < 1 - 1/r, the result is exactly 0 (complete rejection).
 * Above that threshold, quadratic ramp-up provides smooth transition.
 *
 * @param similarity - Cosine similarity in [0, 1] (for TF-IDF vectors)
 * @param r - Sharpness parameter. Higher = narrower acceptance window.
 * @returns Screening score in [0, 1]. Exactly 0 for rejected items.
 */
export function trimAndSquare(similarity: number, r: number): number {
  const raw = 1 - r * (1 - similarity)
  const trimmed = Math.max(raw, 0)
  return trimmed * trimmed
}

/**
 * Derive the sharpness parameter `r` from a desired threshold.
 * The threshold is the similarity value below which items are rejected.
 * r = 1 / (1 - threshold).
 *
 * Note: the paper constrains r >= 2 (neural embeddings with high similarity
 * ranges). For TF-IDF where cosine similarities are typically 0.0-0.3,
 * lower r values (1.1-1.5) are necessary for effective screening.
 * The r >= 1.01 clamp prevents degenerate behavior at threshold → 0.
 */
export function sharpnessFromThreshold(threshold: number): number {
  if (threshold >= 1) return Infinity
  const r = 1 / (1 - Math.max(threshold, 0))
  return Math.max(r, 1.01)
}

// ---------------------------------------------------------------------------
// Recency Boost
// ---------------------------------------------------------------------------

/**
 * Exponential decay factor based on age.
 * Returns exp(-age / halfLife * ln(2)), so the factor is 0.5 at halfLife,
 * 0.25 at 2*halfLife, etc. Returns 1.0 when age <= 0.
 */
export function recencyFactor(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0 || halfLifeMs <= 0) return 1.0
  return Math.pow(2, -ageMs / halfLifeMs)
}

// ---------------------------------------------------------------------------
// Main Screening API
// ---------------------------------------------------------------------------

/**
 * Screen a list of items against a query using TF-IDF + Trim-and-Square.
 *
 * Items with similarity below the absolute threshold receive exactly zero
 * relevance and are excluded from results. This is the core "screening"
 * concept from the paper: independent absolute evaluation, not relative
 * ranking with softmax normalization.
 *
 * @param items - Items to screen
 * @param getText - Extract text content from an item
 * @param query - Query string to screen against
 * @param config - Screening configuration
 * @param getAge - Optional: extract age in ms for recency boosting
 * @returns Items that passed screening, sorted by score descending.
 *          Items with score === 0 are never returned.
 */
export function screenItems<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  config: ScreeningConfig,
  getAge?: (item: T) => number,
): ScoredItem<T>[] {
  if (items.length === 0 || query.trim().length === 0) return []

  const r = sharpnessFromThreshold(config.threshold)

  // Build IDF map from all documents + query.
  const allTexts = items.map(getText)
  allTexts.push(query)
  const idfMap = buildIdfMap(allTexts)

  // Compute query vector once.
  const queryVec = tfidfVector(query, idfMap)
  if (queryVec.size === 0) return []

  // Score each item, collecting similarity stats for diagnostics.
  const scored: ScoredItem<T>[] = []
  let simSum = 0
  let simMin = Infinity
  let simMax = -Infinity

  for (const item of items) {
    const itemVec = tfidfVector(getText(item), idfMap)
    const sim = cosineSimilarity(queryVec, itemVec)

    // Track raw similarity for diagnostics.
    simSum += sim
    if (sim < simMin) simMin = sim
    if (sim > simMax) simMax = sim

    let score = trimAndSquare(sim, r)

    // Apply recency boost if configured.
    if (score > 0 && config.boostRecency && getAge && config.recencyHalfLifeMs) {
      score *= recencyFactor(getAge(item), config.recencyHalfLifeMs)
      // Re-apply threshold after recency decay — old items may drop below.
      if (score < 1e-10) score = 0
    }

    if (score > 0) {
      scored.push({ item, score })
    }
  }

  // Emit diagnostics if a callback is registered.
  if (_onDiagnostics) {
    _onDiagnostics({
      inputCount: items.length,
      passedCount: scored.length,
      minSimilarity: items.length > 0 ? simMin : 0,
      maxSimilarity: items.length > 0 ? simMax : 0,
      avgSimilarity: items.length > 0 ? simSum / items.length : 0,
      sharpness: r,
      threshold: config.threshold,
    })
  }

  // Sort descending by score and cap at maxResults.
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, config.maxResults)
}

/**
 * Screen a list of items against a query using BM25 + saturation normalization
 * + Trim-and-Square. Kept separate from screenItems so callers can migrate
 * search paths without changing legacy TF-IDF behavior.
 *
 * Saga 11 engine-cache-layer refactor: this delegates to
 * `screenItemsBM25WithBundle()` after building the corpus bundle once. The
 * legacy implementation tokenized each item twice — once inside
 * `buildBm25CorpusStats(itemTexts)`, then again in the per-item loop. The
 * delegated path tokenizes once via `buildCorpusBundle()`, halving the
 * tokenize work without changing observable behavior.
 */
export function screenItemsBM25<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  config: ScreeningConfig,
  getAge?: (item: T) => number,
  bm25Opts: Bm25ScreeningOptions = {},
): ScoredItem<T>[] {
  if (items.length === 0 || query.trim().length === 0) return []
  const itemTexts = items.map(getText)
  const bundle = buildCorpusBundle(itemTexts)
  return screenItemsBM25WithBundle(items, bundle, query, config, getAge, bm25Opts)
}

/**
 * Variant of `screenItemsBM25` that consumes a pre-built `CorpusBundle`.
 *
 * Saga 11: the cache holds the bundle, so cache-hit queries skip the
 * `tokenize` × N items + `buildBm25CorpusStats(...)` work entirely. The
 * per-query cost shrinks to query tokenization + N × per-doc BM25 score.
 *
 * Behavior is identical to `screenItemsBM25` when called with
 * `buildCorpusBundle(items.map(getText))` — the same diagnostic event is
 * emitted, the same `ScoredItem<T>` shape is returned. Tests asserting
 * the legacy output still pass.
 *
 * @throws if `items.length !== bundle.itemTokens.length` — the bundle is a
 *         parallel array contract and a length mismatch is always a bug.
 */
export function screenItemsBM25WithBundle<T>(
  items: T[],
  bundle: CorpusBundle,
  query: string,
  config: ScreeningConfig,
  getAge?: (item: T) => number,
  bm25Opts: Bm25ScreeningOptions = {},
): ScoredItem<T>[] {
  if (items.length === 0 || query.trim().length === 0) return []
  if (items.length !== bundle.itemTokens.length) {
    throw new Error(
      `screenItemsBM25WithBundle: items.length=${items.length} ` +
        `!= bundle.itemTokens.length=${bundle.itemTokens.length}`,
    )
  }

  const k1 = bm25Opts.k1 ?? 1.2
  const b = bm25Opts.b ?? 0.75
  const scale = bm25Opts.scale ?? 5.0
  if (scale <= 0) return []

  const r = sharpnessFromThreshold(config.threshold)
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const stats = bundle.stats
  const scored: ScoredItem<T>[] = []
  let rawSum = 0
  let rawMin = Infinity
  let rawMax = -Infinity
  let normalizedSum = 0
  let normalizedMin = Infinity
  let normalizedMax = -Infinity

  // Saga 11 Option α: prefer the pre-built tf map. Older cached bundles
  // (built before this code shipped) may lack `itemTf` — fall back to
  // recomputing from `itemTokens` in that case so the rollout is safe.
  const itemTf = bundle.itemTf

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const docTokens = bundle.itemTokens[i]!
    const tf = itemTf?.[i]
    const raw = tf
      ? bm25ScoreWithTf(queryTokens, tf, docTokens.length, stats, k1, b)
      : bm25Score(queryTokens, docTokens, stats, k1, b)
    const normalized = 1 - Math.exp(-raw / scale)

    rawSum += raw
    if (raw < rawMin) rawMin = raw
    if (raw > rawMax) rawMax = raw
    normalizedSum += normalized
    if (normalized < normalizedMin) normalizedMin = normalized
    if (normalized > normalizedMax) normalizedMax = normalized

    let score = trimAndSquare(normalized, r)

    if (score > 0 && config.boostRecency && getAge && config.recencyHalfLifeMs) {
      score *= recencyFactor(getAge(item), config.recencyHalfLifeMs)
      if (score < 1e-10) score = 0
    }

    if (score > 0) {
      scored.push({ item, score })
    }
  }

  if (_onBm25Diagnostics) {
    _onBm25Diagnostics({
      inputCount: items.length,
      passedCount: scored.length,
      rawMin: items.length > 0 ? rawMin : 0,
      rawMax: items.length > 0 ? rawMax : 0,
      rawAvg: items.length > 0 ? rawSum / items.length : 0,
      normalizedMin: items.length > 0 ? normalizedMin : 0,
      normalizedMax: items.length > 0 ? normalizedMax : 0,
      normalizedAvg: items.length > 0 ? normalizedSum / items.length : 0,
      sharpness: r,
      threshold: config.threshold,
      k1,
      b,
      scale,
      avgdl: stats.avgdl,
      N: stats.N,
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, config.maxResults)
}
