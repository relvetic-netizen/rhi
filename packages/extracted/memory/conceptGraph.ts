// Concept Graph — explicit relationships between concepts for associative search.
//
// Addresses the fundamental limitation of TF-IDF: it cannot infer that "bun"
// and "パッケージマネージャ" are related without explicit connections.
//
// The concept graph is built during nightly distillation from the residual index.
// Each concept node stores:
//   - related concepts (co-occurrence in the same entries)
//   - type (tool, category, pattern, person, etc.)
//   - instances (for category nodes: specific members)
//
// During search, the query's concepts are expanded by one hop through the graph,
// augmenting the search with related terms before TF-IDF screening.
//
// Inspired by PHOTON's multi-resolution design: the concept graph provides
// a semantic resolution layer between raw tokens and topic summaries.
//
// File: ~/.claude/memory/concepts/graph.json

import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJSON } from '../util/atomicWrite.js'
import {
  readResidualIndex,
  type ResidualIndex,
} from './residualIndex.js'
import { isPrivateEntry, shouldIncludePrivate } from './memoryPrivacy.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConceptNode = {
  /** Related concepts (weighted by co-occurrence frequency). */
  related: Record<string, number>
  /** Semantic type of the concept. */
  type?: 'tool' | 'category' | 'pattern' | 'person' | 'project' | 'topic' | 'general'
  /** For category nodes: specific instances. */
  instances?: string[]
}

export type ConceptGraph = {
  version: number
  concepts: Record<string, ConceptNode>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_PATH = 'concepts/graph.json'
const CURRENT_VERSION = 1
/** Max related concepts per node (prevent unbounded growth). */
const MAX_RELATED = 20
/** Min co-occurrence count to create an edge. */
const MIN_COOCCURRENCE = 1

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function graphPath(memoryDir: string): string {
  return join(memoryDir, GRAPH_PATH)
}

export async function readConceptGraph(memoryDir: string): Promise<ConceptGraph> {
  try {
    const raw = await readFile(graphPath(memoryDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.concepts) {
      return { version: parsed.version ?? CURRENT_VERSION, concepts: parsed.concepts }
    }
    return emptyGraph()
  } catch {
    return emptyGraph()
  }
}

export async function writeConceptGraph(
  memoryDir: string,
  graph: ConceptGraph,
): Promise<void> {
  await atomicWriteJSON(graphPath(memoryDir), graph)
}

function emptyGraph(): ConceptGraph {
  return { version: CURRENT_VERSION, concepts: {} }
}

// ---------------------------------------------------------------------------
// Graph construction from residual index
// ---------------------------------------------------------------------------

/**
 * Build or update the concept graph from the residual index.
 *
 * Algorithm: for each entry in the index, all concept pairs within the entry
 * are connected with an edge. Edge weight = co-occurrence count.
 *
 * This is equivalent to building a co-occurrence matrix from the concept tags
 * of all distilled entries.
 */
export async function buildConceptGraph(
  memoryDir: string,
): Promise<ConceptGraph> {
  const index = await readResidualIndex(memoryDir)
  const graph = emptyGraph()

  // Privacy gate: by default the concept graph is built only from public
  // entries, so private co-occurrences never become edges that expandConcepts
  // could later widen a query through. Opt-in via RELVETIA_INCLUDE_PRIVATE=1
  // (used by the user searching their own diary).
  const includePrivate = shouldIncludePrivate()

  // Count co-occurrences
  for (const entry of Object.values(index.entries)) {
    if (!includePrivate && isPrivateEntry(entry)) continue
    const concepts = entry.concepts.map(c => c.toLowerCase())

    // Ensure all concepts exist as nodes
    for (const concept of concepts) {
      if (!graph.concepts[concept]) {
        graph.concepts[concept] = { related: {} }
      }
    }

    // Create edges between all pairs in this entry
    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const a = concepts[i]!
        const b = concepts[j]!

        graph.concepts[a]!.related[b] = (graph.concepts[a]!.related[b] ?? 0) + 1
        graph.concepts[b]!.related[a] = (graph.concepts[b]!.related[a] ?? 0) + 1
      }
    }
  }

  // Prune weak edges and cap related per node
  for (const [concept, node] of Object.entries(graph.concepts)) {
    const entries = Object.entries(node.related)
      .filter(([, count]) => count >= MIN_COOCCURRENCE)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_RELATED)

    graph.concepts[concept] = {
      ...node,
      related: Object.fromEntries(entries),
    }
  }

  return graph
}

// ---------------------------------------------------------------------------
// Query expansion
// ---------------------------------------------------------------------------

/**
 * Expand a set of query concepts by one hop through the concept graph.
 *
 * For each input concept, adds its top-N related concepts (by edge weight).
 * This allows "bun" to expand to ["bun", "package-manager", "npm", "speed"]
 * if those are co-occurring concepts in the graph.
 *
 * @param concepts - Input concept terms (from query tokenization or extraction)
 * @param graph - The concept graph
 * @param maxExpansion - Max related concepts to add per input concept (default: 3)
 * @returns Expanded concept set (original + related), deduplicated
 */
export function expandConcepts(
  concepts: string[],
  graph: ConceptGraph,
  maxExpansion: number = 3,
): string[] {
  const expanded = new Set(concepts.map(c => c.toLowerCase()))

  for (const concept of concepts) {
    const node = graph.concepts[concept.toLowerCase()]
    if (!node) continue

    // Get top-N related by weight
    const related = Object.entries(node.related)
      .sort(([, a], [, b]) => b - a)
      .slice(0, maxExpansion)

    for (const [relatedConcept] of related) {
      expanded.add(relatedConcept)
    }
  }

  return [...expanded]
}

/**
 * Extract potential concept terms from a query string.
 *
 * Simple heuristic: lowercase, split on whitespace/punctuation,
 * filter short tokens, look up in the graph to find known concepts.
 *
 * @param query - Raw search query
 * @param graph - The concept graph (for known concept matching)
 * @returns Concept terms found in the query that exist in the graph
 */
export function extractQueryConcepts(
  query: string,
  graph: ConceptGraph,
): string[] {
  const knownConcepts = new Set(Object.keys(graph.concepts))
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s\u3000-\u9fff\u3040-\u309f\u30a0-\u30ff-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)

  return tokens.filter(t => knownConcepts.has(t))
}

/**
 * Full query expansion pipeline: extract concepts → expand → return augmented query.
 *
 * Prepends expanded concept terms to the original query for TF-IDF screening.
 * This is the "concept resolution" layer in the multi-resolution pipeline.
 *
 * @param query - Original search query
 * @param graph - The concept graph
 * @returns Augmented query string with expanded concepts prepended
 */
export function augmentQueryWithConcepts(
  query: string,
  graph: ConceptGraph,
): string {
  const queryConcepts = extractQueryConcepts(query, graph)
  if (queryConcepts.length === 0) return query

  const expanded = expandConcepts(queryConcepts, graph)
  // Only add terms not already in the query
  const queryLower = query.toLowerCase()
  const newTerms = expanded.filter(t => !queryLower.includes(t))

  if (newTerms.length === 0) return query
  return `${newTerms.join(' ')} ${query}`
}

// ---------------------------------------------------------------------------
// Graph statistics (for diagnostics)
// ---------------------------------------------------------------------------

export type GraphStats = {
  nodeCount: number
  edgeCount: number
  avgDegree: number
  topConcepts: { concept: string; degree: number }[]
}

export function getGraphStats(graph: ConceptGraph): GraphStats {
  const nodes = Object.entries(graph.concepts)
  const nodeCount = nodes.length
  let edgeCount = 0

  for (const [, node] of nodes) {
    edgeCount += Object.keys(node.related).length
  }
  // Each edge is counted twice (undirected)
  edgeCount = Math.floor(edgeCount / 2)

  const avgDegree = nodeCount > 0 ? (edgeCount * 2) / nodeCount : 0

  const topConcepts = nodes
    .map(([concept, node]) => ({
      concept,
      degree: Object.keys(node.related).length,
    }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 10)

  return { nodeCount, edgeCount, avgDegree, topConcepts }
}
