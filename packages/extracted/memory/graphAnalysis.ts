// Graph Analysis — Phase 13 of the PHOTON-inspired memory hierarchy.
//
// Extends the basic concept graph (conceptGraph.ts, which tracks direct
// co-occurrence only) with three additional relevance signals inspired by
// nashsu/llm_wiki's 4-signal relevance model:
//
//   directLink    ×3.0  — concepts co-occur in the same entry
//   sourceOverlap ×4.0  — concepts co-occur across entries sharing a source
//   adamicAdar    ×1.5  — concepts share common neighbors (rare = higher)
//   typeAffinity  ×1.0  — bonus when concept types are compatible
//
// The combined weighted graph feeds Louvain community detection, which
// discovers natural clusters of concepts without supervision. These
// clusters drive topic split suggestions: when entries in a topic have
// concepts that divide cleanly across multiple Louvain communities, the
// topic is a candidate for splitting along community boundaries.
//
// Non-destructive: this module computes analyses on demand. Actual split
// execution is deferred to a review queue (Phase 13.5, not included here).

import { readFile } from 'fs/promises'
import { join } from 'path'
import { normalizeIndexEntries } from './topicChunking.js'
import type { ResidualEntry } from './residualIndex.js'
import type { ConceptGraph, ConceptNode } from './conceptGraph.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WeightedEdges = Map<string, Map<string, number>>

export type TypeAffinityMap = Record<string, Record<string, number>>

export type GraphSignalWeights = {
  directLink: number
  sourceOverlap: number
  adamicAdar: number
  typeAffinity: number
}

export const DEFAULT_SIGNAL_WEIGHTS: GraphSignalWeights = {
  directLink: 3.0,
  sourceOverlap: 4.0,
  adamicAdar: 1.5,
  typeAffinity: 1.0,
}

// Type affinity following llm_wiki's table (section 4 of their README).
// Concept types default to 'general' if unset; only non-trivial combos listed.
export const DEFAULT_TYPE_AFFINITY: TypeAffinityMap = {
  tool: { tool: 0.8, category: 1.2, pattern: 1.0 },
  category: { tool: 1.2, category: 0.8, pattern: 1.0 },
  pattern: { tool: 1.0, category: 1.0, pattern: 0.8 },
  person: { person: 0.8, project: 1.2 },
  project: { person: 1.2, project: 0.8 },
}

export type Community = {
  /** Community ID (arbitrary integer). */
  id: number
  /** Concept names in this community. */
  members: string[]
  /** Intra-community edge weight sum. */
  intraWeight: number
  /** Cross-community edge weight sum (to other communities). */
  crossWeight: number
  /** Cohesion: intraWeight / (intraWeight + crossWeight). 1.0 = perfect isolation. */
  cohesion: number
}

export type TopicSplitProposal = {
  topic: string
  /** Total entries in this topic. */
  entryCount: number
  /** How entries partition across communities (community id → entry count). */
  communityDistribution: Map<number, number>
  /** Number of distinct communities represented. */
  communityCount: number
  /** Dominance ratio: largest community / total entries. 1.0 = single cluster. */
  dominance: number
  /** Whether this topic should be split. */
  shouldSplit: boolean
  /** If shouldSplit, proposed sub-topics (one per community with ≥2 entries). */
  proposedSubtopics?: Array<{ communityId: number; entryIds: string[]; signature: string[] }>
}

// ---------------------------------------------------------------------------
// Signal computation
// ---------------------------------------------------------------------------

/** Compute directLink weights: co-occurrence within the same entry. */
export function computeDirectLinkEdges(entries: ResidualEntry[]): WeightedEdges {
  const edges: WeightedEdges = new Map()
  const addEdge = (a: string, b: string) => {
    const ma = edges.get(a) ?? new Map()
    ma.set(b, (ma.get(b) ?? 0) + 1)
    edges.set(a, ma)
  }
  for (const e of entries) {
    const concepts = e.concepts.map(c => c.toLowerCase())
    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        addEdge(concepts[i], concepts[j])
        addEdge(concepts[j], concepts[i])
      }
    }
  }
  return edges
}

/** Compute sourceOverlap weights: concepts in entries sharing a source file. */
export function computeSourceOverlapEdges(entries: ResidualEntry[]): WeightedEdges {
  // Map source → concepts that appear in entries citing this source
  const sourceConcepts = new Map<string, Set<string>>()
  for (const e of entries) {
    for (const src of e.sources) {
      // Strip ":Lnn" suffix — file-level overlap is what matters
      const file = src.replace(/:L\d+$/, '')
      const set = sourceConcepts.get(file) ?? new Set()
      for (const c of e.concepts) set.add(c.toLowerCase())
      sourceConcepts.set(file, set)
    }
  }

  const edges: WeightedEdges = new Map()
  const addEdge = (a: string, b: string) => {
    const ma = edges.get(a) ?? new Map()
    ma.set(b, (ma.get(b) ?? 0) + 1)
    edges.set(a, ma)
  }
  for (const set of sourceConcepts.values()) {
    const arr = [...set]
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        addEdge(arr[i], arr[j])
        addEdge(arr[j], arr[i])
      }
    }
  }
  return edges
}

/**
 * Compute Adamic-Adar weights: for edge (a,b), sum over common neighbors c
 * of 1/log(deg(c)+1). Rare shared neighbors contribute more than popular ones.
 */
export function computeAdamicAdarEdges(baseEdges: WeightedEdges): WeightedEdges {
  const degree = new Map<string, number>()
  for (const [node, neighbors] of baseEdges) {
    degree.set(node, neighbors.size)
  }

  const edges: WeightedEdges = new Map()
  const setEdge = (a: string, b: string, w: number) => {
    const ma = edges.get(a) ?? new Map()
    ma.set(b, (ma.get(b) ?? 0) + w)
    edges.set(a, ma)
  }

  // For each pair (a, b) that shares at least one neighbor, compute AA
  for (const [a, aNeighbors] of baseEdges) {
    for (const [b, _] of baseEdges) {
      if (a >= b) continue // unordered pairs only, skip self
      // Find common neighbors
      let aa = 0
      for (const c of aNeighbors.keys()) {
        const bNeighborsOfC = baseEdges.get(b)
        if (bNeighborsOfC && bNeighborsOfC.has(c)) {
          const d = degree.get(c) ?? 0
          if (d > 1) aa += 1 / Math.log(d + 1)
        }
      }
      if (aa > 0) {
        setEdge(a, b, aa)
        setEdge(b, a, aa)
      }
    }
  }
  return edges
}

/** Compute typeAffinity weights using concept types from the base graph. */
export function computeTypeAffinityEdges(
  baseEdges: WeightedEdges,
  graph: ConceptGraph,
  affinity: TypeAffinityMap = DEFAULT_TYPE_AFFINITY,
): WeightedEdges {
  const edges: WeightedEdges = new Map()
  const setEdge = (a: string, b: string, w: number) => {
    const ma = edges.get(a) ?? new Map()
    ma.set(b, w)
    edges.set(a, ma)
  }

  for (const [a, aNeighbors] of baseEdges) {
    const typeA = graph.concepts[a]?.type ?? 'general'
    for (const b of aNeighbors.keys()) {
      const typeB = graph.concepts[b]?.type ?? 'general'
      const bonus = affinity[typeA]?.[typeB] ?? 1.0
      if (bonus !== 1.0) setEdge(a, b, bonus)
    }
  }
  return edges
}

/**
 * Combine 4-signal edges using the configured weights.
 * Returns composite edge weights: w(a,b) = Σ_signal weight_signal × signal(a,b)
 */
export function combineWeightedEdges(
  direct: WeightedEdges,
  source: WeightedEdges,
  adamic: WeightedEdges,
  typeAff: WeightedEdges,
  weights: GraphSignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): WeightedEdges {
  const combined: WeightedEdges = new Map()
  const addEdge = (a: string, b: string, w: number) => {
    const ma = combined.get(a) ?? new Map()
    ma.set(b, (ma.get(b) ?? 0) + w)
    combined.set(a, ma)
  }

  const visit = (src: WeightedEdges, weight: number) => {
    for (const [a, aNeighbors] of src) {
      for (const [b, w] of aNeighbors) {
        addEdge(a, b, weight * w)
      }
    }
  }
  visit(direct, weights.directLink)
  visit(source, weights.sourceOverlap)
  visit(adamic, weights.adamicAdar)
  visit(typeAff, weights.typeAffinity)

  return combined
}

/**
 * Build the full weighted graph from entries + concept graph. Convenience
 * wrapper that chains all signal computations.
 */
export function buildWeightedGraph(
  entries: ResidualEntry[],
  baseGraph: ConceptGraph,
  weights: GraphSignalWeights = DEFAULT_SIGNAL_WEIGHTS,
): WeightedEdges {
  const direct = computeDirectLinkEdges(entries)
  const source = computeSourceOverlapEdges(entries)
  const adamic = computeAdamicAdarEdges(direct)
  const typeAff = computeTypeAffinityEdges(direct, baseGraph)
  return combineWeightedEdges(direct, source, adamic, typeAff, weights)
}

// ---------------------------------------------------------------------------
// Louvain community detection
// ---------------------------------------------------------------------------

/**
 * Minimal Louvain community detection (Blondel et al. 2008).
 *
 * Greedy modularity maximization: each node starts in its own community,
 * then iteratively moves to the neighboring community that maximizes
 * modularity gain. Converges when no move improves Q.
 *
 * Complexity: O(E) per pass, typically 3-10 passes to converge for our scale.
 *
 * Returns a map from node → community id. IDs are small non-negative integers
 * assigned in order of discovery, so they are stable within a single run but
 * may differ across runs on the same graph (modularity-equivalent).
 */
export function louvain(edges: WeightedEdges): Map<string, number> {
  const nodes = [...edges.keys()]
  if (nodes.length === 0) return new Map()

  // Start: each node its own community
  const community = new Map<string, number>()
  nodes.forEach((n, i) => community.set(n, i))

  // Compute node degree (sum of adjacent weights) and total m
  const degree = new Map<string, number>()
  let twoM = 0
  for (const [node, neighbors] of edges) {
    let deg = 0
    for (const w of neighbors.values()) deg += w
    degree.set(node, deg)
    twoM += deg
  }
  if (twoM === 0) return community

  // Community → sum of its members' total degrees (tot) and internal weight (in)
  const tot = new Map<number, number>()
  const inW = new Map<number, number>()
  for (const n of nodes) {
    const c = community.get(n)!
    tot.set(c, (tot.get(c) ?? 0) + (degree.get(n) ?? 0))
    inW.set(c, inW.get(c) ?? 0)
  }

  // Iterative moves.
  //
  // Blondel et al. modularity gain for moving node i into community c:
  //   ΔQ(c) = 2 * k_{i,c} / 2m - 2 * k_i * Σ_tot(c) / (2m)²
  // where k_{i,c} is the edge weight from i to community c (excluding i itself
  // after removal), and Σ_tot(c) is the sum of degrees of nodes in c.
  //
  // The baseline "rejoin original ci" gain must be included as a candidate,
  // not assumed to be zero — otherwise the algorithm can strand a node in a
  // singleton community after it was briefly removed.
  const gainFor = (kICommunity: number, totCommunity: number, kI: number) =>
    2 * kICommunity / twoM - 2 * (kI * totCommunity) / (twoM * twoM)

  const MAX_PASSES = 30
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let improved = false
    for (const node of nodes) {
      const ci = community.get(node)!
      const kI = degree.get(node) ?? 0
      const neighbors = edges.get(node) ?? new Map()

      // Edge weights grouped by neighbor community
      const kIn = new Map<number, number>() // weight from node to community c
      for (const [nb, w] of neighbors) {
        const cNb = community.get(nb)
        if (cNb === undefined) continue
        kIn.set(cNb, (kIn.get(cNb) ?? 0) + w)
      }
      const kInSelf = kIn.get(ci) ?? 0

      // Remove node from its community
      tot.set(ci, (tot.get(ci) ?? 0) - kI)
      inW.set(ci, (inW.get(ci) ?? 0) - 2 * kInSelf)

      // Gain baseline: rejoin ci (with i removed, tot[ci] now excludes k_i)
      let bestC = ci
      let bestGain = gainFor(kInSelf, tot.get(ci) ?? 0, kI)

      // Try moving to each neighboring community
      for (const [cj, kIj] of kIn) {
        if (cj === ci) continue
        const gain = gainFor(kIj, tot.get(cj) ?? 0, kI)
        if (gain > bestGain) {
          bestGain = gain
          bestC = cj
        }
      }

      // Rejoining ci or moving to bestC: commit the chosen destination
      community.set(node, bestC)
      tot.set(bestC, (tot.get(bestC) ?? 0) + kI)
      inW.set(bestC, (inW.get(bestC) ?? 0) + 2 * (kIn.get(bestC) ?? 0))
      if (bestC !== ci) improved = true
    }
    if (!improved) break
  }

  // Renumber communities to compact 0..k-1
  const remap = new Map<number, number>()
  for (const c of community.values()) {
    if (!remap.has(c)) remap.set(c, remap.size)
  }
  const final = new Map<string, number>()
  for (const [n, c] of community) final.set(n, remap.get(c)!)
  return final
}

/** Build Community[] summary from a Louvain assignment and weighted edges. */
export function summarizeCommunities(
  assignment: Map<string, number>,
  edges: WeightedEdges,
): Community[] {
  const members = new Map<number, string[]>()
  for (const [node, c] of assignment) {
    const list = members.get(c) ?? []
    list.push(node)
    members.set(c, list)
  }

  const intra = new Map<number, number>()
  const cross = new Map<number, number>()
  for (const [a, neighbors] of edges) {
    const ca = assignment.get(a)
    if (ca === undefined) continue
    for (const [b, w] of neighbors) {
      if (a >= b) continue // count each undirected edge once
      const cb = assignment.get(b)
      if (cb === undefined) continue
      if (ca === cb) {
        intra.set(ca, (intra.get(ca) ?? 0) + w)
      } else {
        cross.set(ca, (cross.get(ca) ?? 0) + w)
        cross.set(cb, (cross.get(cb) ?? 0) + w)
      }
    }
  }

  const out: Community[] = []
  for (const [id, mlist] of members) {
    const iw = intra.get(id) ?? 0
    const cw = cross.get(id) ?? 0
    const total = iw + cw
    out.push({
      id,
      members: mlist.sort(),
      intraWeight: iw,
      crossWeight: cw,
      cohesion: total > 0 ? iw / total : 0,
    })
  }
  out.sort((a, b) => b.members.length - a.members.length)
  return out
}

// ---------------------------------------------------------------------------
// Topic split proposals
// ---------------------------------------------------------------------------

const SPLIT_MIN_DOMINANCE = 0.7   // below this, topic is fragmented
const SPLIT_MIN_ENTRIES = 5       // topics with fewer entries skip analysis
const SPLIT_MIN_SUBGROUP = 2      // sub-topic needs at least this many entries

/**
 * For a given topic, determine how its entries partition across Louvain
 * communities. If entries split cleanly into multiple communities (dominance
 * below threshold), propose a split with sub-topics named after each community.
 */
export function analyzeTopicForSplit(
  topic: string,
  topicEntries: ResidualEntry[],
  conceptToCommunity: Map<string, number>,
): TopicSplitProposal {
  if (topicEntries.length < SPLIT_MIN_ENTRIES) {
    return {
      topic,
      entryCount: topicEntries.length,
      communityDistribution: new Map(),
      communityCount: 0,
      dominance: 1,
      shouldSplit: false,
    }
  }

  // Assign each entry to its dominant community (majority vote over concepts)
  const entryCommunity = new Map<string, number>()
  const communityDistribution = new Map<number, number>()
  const entriesByCommunity = new Map<number, ResidualEntry[]>()

  for (const e of topicEntries) {
    const votes = new Map<number, number>()
    for (const c of e.concepts) {
      const cid = conceptToCommunity.get(c.toLowerCase())
      if (cid !== undefined) votes.set(cid, (votes.get(cid) ?? 0) + 1)
    }
    if (votes.size === 0) continue
    // Majority community for this entry
    let best = -1, bestV = 0
    for (const [cid, v] of votes) {
      if (v > bestV) { bestV = v; best = cid }
    }
    entryCommunity.set(e.id, best)
    communityDistribution.set(best, (communityDistribution.get(best) ?? 0) + 1)
    const list = entriesByCommunity.get(best) ?? []
    list.push(e)
    entriesByCommunity.set(best, list)
  }

  const maxCount = Math.max(0, ...communityDistribution.values())
  const dominance = topicEntries.length > 0 ? maxCount / topicEntries.length : 1
  const communityCount = communityDistribution.size

  const shouldSplit =
    communityCount >= 2 &&
    dominance < SPLIT_MIN_DOMINANCE &&
    [...communityDistribution.values()].filter(n => n >= SPLIT_MIN_SUBGROUP).length >= 2

  let proposedSubtopics: TopicSplitProposal['proposedSubtopics'] | undefined
  if (shouldSplit) {
    proposedSubtopics = []
    for (const [cid, list] of entriesByCommunity) {
      if (list.length < SPLIT_MIN_SUBGROUP) continue
      // Signature = most common concepts in this sub-group
      const conceptFreq = new Map<string, number>()
      for (const e of list) {
        for (const c of e.concepts) {
          conceptFreq.set(c, (conceptFreq.get(c) ?? 0) + 1)
        }
      }
      const signature = [...conceptFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c]) => c)
      proposedSubtopics.push({
        communityId: cid,
        entryIds: list.map(e => e.id),
        signature,
      })
    }
  }

  return {
    topic,
    entryCount: topicEntries.length,
    communityDistribution,
    communityCount,
    dominance,
    shouldSplit,
    proposedSubtopics,
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export type FullGraphAnalysis = {
  weightedEdges: WeightedEdges
  communities: Community[]
  conceptToCommunity: Map<string, number>
  splitProposals: TopicSplitProposal[]
  /** Topics with shouldSplit=true. */
  topicsToSplit: string[]
}

/**
 * End-to-end analysis: read memory state, build weighted graph, run Louvain,
 * analyze every topic for potential splits. Non-destructive.
 */
export async function analyzeMemoryGraph(memoryDir: string): Promise<FullGraphAnalysis> {
  // Load index
  let indexRaw: unknown = null
  try {
    const content = await readFile(join(memoryDir, 'index.json'), 'utf8')
    indexRaw = JSON.parse(content)
  } catch {
    // no index
  }
  const entries = normalizeIndexEntries(indexRaw)

  // Load concept graph
  let baseGraph: ConceptGraph = { version: 1, concepts: {} }
  try {
    const content = await readFile(join(memoryDir, 'concepts', 'graph.json'), 'utf8')
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object' && parsed.concepts) {
      baseGraph = { version: parsed.version ?? 1, concepts: parsed.concepts }
    }
  } catch {
    // no graph — we'll derive from entries
  }

  const weightedEdges = buildWeightedGraph(entries, baseGraph)
  const conceptToCommunity = louvain(weightedEdges)
  const communities = summarizeCommunities(conceptToCommunity, weightedEdges)

  // Group entries by topic
  const byTopic = new Map<string, ResidualEntry[]>()
  for (const e of entries) {
    const list = byTopic.get(e.topic) ?? []
    list.push(e)
    byTopic.set(e.topic, list)
  }

  const splitProposals: TopicSplitProposal[] = []
  for (const [topic, tEntries] of byTopic) {
    splitProposals.push(analyzeTopicForSplit(topic, tEntries, conceptToCommunity))
  }
  splitProposals.sort((a, b) => a.dominance - b.dominance) // most fragmented first

  const topicsToSplit = splitProposals.filter(p => p.shouldSplit).map(p => p.topic)

  return {
    weightedEdges,
    communities,
    conceptToCommunity,
    splitProposals,
    topicsToSplit,
  }
}

/** Format analysis for daily log. */
export function formatGraphAnalysis(analysis: FullGraphAnalysis): string {
  const lines: string[] = []
  lines.push(
    `[topology] ${analysis.communities.length} communities, ` +
    `${analysis.conceptToCommunity.size} concepts, ` +
    `${analysis.topicsToSplit.length} split candidates`,
  )

  for (const c of analysis.communities.slice(0, 5)) {
    lines.push(
      `  community #${c.id}: ${c.members.length} concepts, ` +
      `cohesion=${c.cohesion.toFixed(2)}, ` +
      `top=[${c.members.slice(0, 3).join(', ')}]`,
    )
  }

  for (const p of analysis.splitProposals) {
    if (!p.shouldSplit) continue
    const groups = p.proposedSubtopics?.map(s => `${s.signature.join('/')}×${s.entryIds.length}`).join(' | ')
    lines.push(
      `  [SPLIT] ${p.topic}: ${p.entryCount} entries, ` +
      `${p.communityCount} communities, ` +
      `dominance=${p.dominance.toFixed(2)}, ` +
      `groups=[${groups}]`,
    )
  }

  return lines.join('\n')
}
