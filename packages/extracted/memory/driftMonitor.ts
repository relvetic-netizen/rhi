// Drift Monitor — Phase 12 of the PHOTON-inspired memory hierarchy.
//
// PHOTON paper's L_rec loss (arXiv:2512.20687v2, equation 1) requires that
// bottom-up encoder states match top-down decoder reconstructions at every
// level. In Relvetia, this translates to: the topic file (Level 2 decoder
// output) should faithfully represent the index entries assigned to that
// topic (Level 1 encoder output).
//
// Concretely, if index.json says "this topic covers bun/vitest/tRPC" but
// topics/prefs.md has mostly drifted toward unrelated content, something
// went wrong in distillation — either the index was not refreshed, or the
// topic file was manually edited, or a distill pass dropped material.
//
// This module computes a lightweight drift proxy using TF-IDF cosine —
// no LLM calls required, runs every distill cycle in milliseconds.
//
// Drift semantics:
//   drift[t] = 1 - cosine( tfidf(concat(index entries for t)), tfidf(topic file t) )
//
// Values:
//   0.0      — index and topic are perfectly aligned (or both empty)
//   0.0-0.3  — healthy natural variation (expected)
//   0.3-0.5  — noticeable drift, log warning
//   0.5-1.0  — significant divergence, recommend HierGen refresh
//
// Design note: this is an approximation of PHOTON's L_rec. The paper uses
// cosine distance on learned representations; we use cosine distance on
// TF-IDF vectors because Relvetia has no embedding infrastructure (by
// design — see OPTIMIZATION.md §11).

import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import {
  buildIdfMap,
  tfidfVector,
  cosineSimilarity,
} from '../screening/screening.js'
import { normalizeIndexEntries } from './topicChunking.js'
import type { ResidualEntry } from './residualIndex.js'
import { topicFilePath } from './topicPathForEntry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DriftLevel = 'healthy' | 'warning' | 'critical'

export type TopicDrift = {
  topic: string
  /** Number of index entries assigned to this topic. */
  entryCount: number
  /** Whether a topic file exists on disk. */
  topicFileExists: boolean
  /** Cosine similarity between TF-IDF of index entries and topic file. [0, 1] */
  similarity: number
  /** Drift metric: 1 - similarity. [0, 1], higher = more divergent. */
  drift: number
  /** Severity classification. */
  level: DriftLevel
}

export type DriftReport = {
  topics: TopicDrift[]
  /** Topics classified as critical — recommend HierGen next distill. */
  criticalTopics: string[]
  /** Topics classified as warning — log but don't force HierGen. */
  warningTopics: string[]
  /** Maximum drift across all topics. */
  maxDrift: number
  /** Thresholds used for classification. */
  thresholds: { warning: number; critical: number }
  /** Whether this report recommends HierGen at the next distill cycle. */
  recommendHierGen: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Thresholds chosen empirically (2026-04-21). TF-IDF cosines are typically
// 0.1-0.4 for "related but different" text, so 1 - sim ≈ 0.6-0.9. A healthy
// topic with 10+ entries and a derived topic file should land at sim >= 0.7
// (drift <= 0.3) because entry summaries and topic prose share terminology.
export const DRIFT_WARNING_THRESHOLD = 0.3
export const DRIFT_CRITICAL_THRESHOLD = 0.5

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyDrift(drift: number): DriftLevel {
  if (drift >= DRIFT_CRITICAL_THRESHOLD) return 'critical'
  if (drift >= DRIFT_WARNING_THRESHOLD) return 'warning'
  return 'healthy'
}

/** Concatenate summary + concepts for all entries in a topic. */
function entriesToText(entries: ResidualEntry[]): string {
  return entries
    .map(e => `${e.summary} ${e.concepts.join(' ')}`)
    .join('\n')
}

async function readTopicFile(memoryDir: string, topic: string): Promise<string | null> {
  const path = topicFilePath(memoryDir, topic)
  try {
    await stat(path)
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Strip YAML frontmatter and structural markers before drift comparison.
 * We want to compare semantic content, not presentation markup.
 */
function stripMarkup(text: string): string {
  return text
    .replace(/^---\n[\s\S]*?\n---\n?/m, '') // YAML frontmatter
    .replace(/```[\s\S]*?```/g, '') // code fences
    .replace(/#+\s+/g, '') // heading markers
    .replace(/\*\*|__|\*|_/g, '') // emphasis
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // wikilink target
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links
    .trim()
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Compute drift between index entries and topic file for a single topic.
 * Returns similarity=1, drift=0 when both sides are empty (degenerate
 * alignment). Returns drift=1 when one side exists and the other doesn't.
 */
export async function computeTopicDrift(
  memoryDir: string,
  topic: string,
  entries: ResidualEntry[],
): Promise<TopicDrift> {
  const topicFileContent = await readTopicFile(memoryDir, topic)
  const topicFileExists = topicFileContent !== null

  // Degenerate cases
  if (entries.length === 0 && !topicFileExists) {
    return {
      topic,
      entryCount: 0,
      topicFileExists: false,
      similarity: 1,
      drift: 0,
      level: 'healthy',
    }
  }
  if (entries.length === 0 || !topicFileExists) {
    return {
      topic,
      entryCount: entries.length,
      topicFileExists,
      similarity: 0,
      drift: 1,
      level: 'critical',
    }
  }

  // Build TF-IDF with both sides as corpus (small but sufficient for IDF).
  const indexText = entriesToText(entries)
  const topicText = stripMarkup(topicFileContent)
  const idfMap = buildIdfMap([indexText, topicText])
  const indexVec = tfidfVector(indexText, idfMap)
  const topicVec = tfidfVector(topicText, idfMap)
  const similarity = cosineSimilarity(indexVec, topicVec)
  const drift = 1 - similarity

  return {
    topic,
    entryCount: entries.length,
    topicFileExists: true,
    similarity,
    drift,
    level: classifyDrift(drift),
  }
}

/**
 * Build a full drift report by examining every topic in the index.
 *
 * Non-destructive: reads index.json and topics/*.md, writes nothing.
 * Callers typically log the report and, if recommendHierGen is true,
 * schedule a full HierGen pass at the next distill cycle.
 */
export async function buildDriftReport(memoryDir: string): Promise<DriftReport> {
  // Load index — handle both array and object formats (see topicChunking.ts)
  let raw: unknown = null
  try {
    const content = await readFile(join(memoryDir, 'index.json'), 'utf8')
    raw = JSON.parse(content)
  } catch {
    // no index
  }

  const allEntries = normalizeIndexEntries(raw)
  const byTopic = new Map<string, ResidualEntry[]>()
  for (const e of allEntries) {
    const list = byTopic.get(e.topic) ?? []
    list.push(e)
    byTopic.set(e.topic, list)
  }

  const drifts: TopicDrift[] = []
  for (const [topic, entries] of byTopic) {
    drifts.push(await computeTopicDrift(memoryDir, topic, entries))
  }

  // Sort: critical > warning > healthy, then by drift desc within each level.
  const rank = (l: DriftLevel) => l === 'critical' ? 2 : l === 'warning' ? 1 : 0
  drifts.sort((a, b) => {
    const diff = rank(b.level) - rank(a.level)
    if (diff !== 0) return diff
    return b.drift - a.drift
  })

  const criticalTopics = drifts.filter(d => d.level === 'critical').map(d => d.topic)
  const warningTopics = drifts.filter(d => d.level === 'warning').map(d => d.topic)
  const maxDrift = drifts.length > 0 ? Math.max(...drifts.map(d => d.drift)) : 0

  return {
    topics: drifts,
    criticalTopics,
    warningTopics,
    maxDrift,
    thresholds: {
      warning: DRIFT_WARNING_THRESHOLD,
      critical: DRIFT_CRITICAL_THRESHOLD,
    },
    recommendHierGen: criticalTopics.length > 0,
  }
}

/**
 * Format a drift report for daily log output.
 * Returns one line per non-healthy topic, plus a summary line.
 */
export function formatDriftReport(report: DriftReport): string {
  const lines: string[] = []
  const total = report.topics.length
  const crit = report.criticalTopics.length
  const warn = report.warningTopics.length
  const healthy = total - crit - warn

  lines.push(
    `[drift] ${total} topics (critical=${crit}, warning=${warn}, healthy=${healthy}), ` +
    `max=${report.maxDrift.toFixed(3)}, hiergen=${report.recommendHierGen}`,
  )

  for (const d of report.topics) {
    if (d.level === 'healthy') continue
    const tag = d.level === 'critical' ? 'CRITICAL' : 'warning'
    const reason = !d.topicFileExists ? 'no topic file' :
                   d.entryCount === 0 ? 'no index entries' :
                   `sim=${d.similarity.toFixed(3)}`
    lines.push(`  [${tag}] ${d.topic}: drift=${d.drift.toFixed(3)} (${reason})`)
  }

  return lines.join('\n')
}
