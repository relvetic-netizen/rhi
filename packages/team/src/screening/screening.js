// Core screening algorithm inspired by "Screening Is Enough" (arXiv:2604.01178).
//
// Adapts the paper's Trim-and-Square absolute-threshold mechanism for text
// relevance filtering. Uses TF-IDF cosine similarity as the similarity measure
// (no embedding infrastructure required), then applies the paper's activation
// function to achieve hard sparsity: items below the threshold receive exactly
// zero relevance, not a small positive value.
//
// Vendored from upstream relvetia/screening/screening.ts (see UPSTREAM.md).
// 8 TF-IDF core functions ported, logic-identical; BM25 variants, diagnostics
// callbacks, and all type declarations were excluded by design (see UPSTREAM.md).

import { STOPWORDS } from './stopwords.js'
import { stem } from './stemmer.js'
import { extractBridgeTokens } from './bilingualBridge.js'

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

// CJK Unified Ideographs + CJK Ext A/B + Katakana + Hiragana + CJK Compat
const CJK_RANGE = /[　-鿿豈-﫿぀-ゟ゠-ヿ]/

function cjkBigrams(text) {
  const bigrams = []
  for (let i = 0; i < text.length - 1; i++) {
    if (CJK_RANGE.test(text[i]) && CJK_RANGE.test(text[i + 1])) {
      bigrams.push(text[i] + text[i + 1])
    }
  }
  return bigrams
}

/**
 * Split text into tokens for TF-IDF vectorization.
 * English/alphanumeric: split on whitespace, remove stopwords and short tokens.
 * CJK (Japanese/Chinese): extract character bigrams.
 * Enhancements: stemming + bilingual bridge.
 */
export function tokenize(text) {
  const lower = text.toLowerCase()

  const cleaned = lower.replace(/[^a-z0-9　-鿿豈-﫿぀-ゟ゠-ヿ]+/g, ' ')

  const asciiTokens = cleaned
    .replace(/[　-鿿豈-﫿぀-ゟ゠-ヿ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t))

  const stemmedTokens = []
  for (const t of asciiTokens) {
    stemmedTokens.push(t)
    const s = stem(t)
    if (s !== t && s.length > 1) {
      stemmedTokens.push(s)
    }
  }

  const cjkTokens = cjkBigrams(cleaned)

  const rawBridgeTokens = extractBridgeTokens(text, asciiTokens)

  const bridgeTokens = []
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
export function buildIdfMap(documents) {
  const N = documents.length
  if (N === 0) return new Map()

  const df = new Map()
  for (const doc of documents) {
    const unique = new Set(tokenize(doc))
    for (const term of unique) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  const idfMap = new Map()
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
export function tfidfVector(text, idfMap) {
  const tokens = tokenize(text)
  const tf = new Map()
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1)
  }

  const defaultIdf =
    idfMap.size > 0
      ? Math.max(...idfMap.values()) + 1
      : 1

  const vec = new Map()
  for (const [term, count] of tf) {
    const idf = idfMap.get(term) ?? defaultIdf
    vec.set(term, count * idf)
  }
  return vec
}

// ---------------------------------------------------------------------------
// Cosine Similarity
// ---------------------------------------------------------------------------

/** Cosine similarity between two sparse vectors. Returns [0, 1] for TF-IDF
 *  vectors (all non-negative). Returns 0 for zero vectors. */
export function cosineSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0

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

  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// ---------------------------------------------------------------------------
// Trim-and-Square (Paper's Core Mechanism)
// ---------------------------------------------------------------------------

/**
 * Trim-and-Square activation from "Screening Is Enough".
 * α = [max(1 - r·(1 - s), 0)]²
 */
export function trimAndSquare(similarity, r) {
  const raw = 1 - r * (1 - similarity)
  const trimmed = Math.max(raw, 0)
  return trimmed * trimmed
}

/**
 * Derive the sharpness parameter `r` from a desired threshold.
 * r = 1 / (1 - threshold), clamped to >= 1.01.
 */
export function sharpnessFromThreshold(threshold) {
  if (threshold >= 1) return Infinity
  const r = 1 / (1 - Math.max(threshold, 0))
  return Math.max(r, 1.01)
}

// ---------------------------------------------------------------------------
// Recency Boost
// ---------------------------------------------------------------------------

/**
 * Exponential decay factor based on age.
 * Returns 2^(-age/halfLife) so the factor is 0.5 at halfLife.
 */
export function recencyFactor(ageMs, halfLifeMs) {
  if (ageMs <= 0 || halfLifeMs <= 0) return 1.0
  return Math.pow(2, -ageMs / halfLifeMs)
}

// ---------------------------------------------------------------------------
// Main Screening API
// ---------------------------------------------------------------------------

/**
 * Screen a list of items against a query using TF-IDF + Trim-and-Square.
 * Items with similarity below the absolute threshold receive exactly zero
 * relevance and are excluded from results.
 *
 * @param {T[]} items - Items to screen
 * @param {(item: T) => string} getText - Extract text content from an item
 * @param {string} query - Query string to screen against
 * @param {object} config
 * @param {number} config.threshold - Acceptance threshold in (0, 1)
 * @param {number} config.maxResults - Hard cap on returned items
 * @param {boolean} [config.boostRecency]
 * @param {number} [config.recencyHalfLifeMs]
 * @param {(item: T) => number} [getAge] - Optional: extract age in ms for recency boosting
 * @returns {{ item: T, score: number }[]} - Sorted by score descending; rejected items omitted.
 */
export function screenItems(items, getText, query, config, getAge) {
  if (items.length === 0 || query.trim().length === 0) return []

  const r = sharpnessFromThreshold(config.threshold)

  const allTexts = items.map(getText)
  allTexts.push(query)
  const idfMap = buildIdfMap(allTexts)

  const queryVec = tfidfVector(query, idfMap)
  if (queryVec.size === 0) return []

  const scored = []

  for (const item of items) {
    const itemVec = tfidfVector(getText(item), idfMap)
    const sim = cosineSimilarity(queryVec, itemVec)

    let score = trimAndSquare(sim, r)

    if (score > 0 && config.boostRecency && getAge && config.recencyHalfLifeMs) {
      score *= recencyFactor(getAge(item), config.recencyHalfLifeMs)
      if (score < 1e-10) score = 0
    }

    if (score > 0) {
      scored.push({ item, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, config.maxResults)
}
