// Topic chunking — Phase 11 of the PHOTON-inspired memory hierarchy.
//
// Maps PHOTON Level 2 (chunks of M_1 level-1 units grouped into M_2 units)
// onto Relvetia topic files. Each topic corresponds to one or more chunks;
// when entry count or line count exceeds the configured chunk size, the
// topic is flagged for split/promotion rather than unbounded growth.
//
// Design principle (from Screening Is Enough): absolute thresholds, not
// fixed-budget eviction. This module does NOT delete entries — it only
// reports structural imbalance. Actual split decisions are made by the
// distillation process (Phase 13) or by human review.
//
// Soft vs hard:
//   - soft limit: non-binding warning (logged, surfaced in dashboard)
//   - hard limit: triggers forced promotion at next distill cycle
//
// Line vs entry counts:
//   - entry count is primary (matches PHOTON's M_l semantic units)
//   - line count is legacy safety valve (matches pre-Phase 11 distill.md)
//   - whichever triggers first wins — we measure both

import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getScreeningConfig } from '../screening/screeningConfig.js'
import {
  readResidualIndex,
  type ResidualIndex,
  type ResidualEntry,
} from './residualIndex.js'
import { topicFilePath } from './topicPathForEntry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChunkLimitStatus = 'under' | 'soft' | 'hard'

export type TopicChunkReport = {
  /** Topic name (e.g., "troubleshooting"). */
  topic: string
  /** Number of index entries with this topic. */
  entryCount: number
  /** Physical line count of the topic file (0 if file missing). */
  lineCount: number
  /** Worst-case status across both dimensions. */
  status: ChunkLimitStatus
  /** Which dimension triggered the current status. */
  triggeredBy: 'entries' | 'lines' | 'none'
  /** Human-readable summary. */
  message: string
}

export type TopologyReport = {
  /** Per-topic reports, sorted by status severity descending. */
  topics: TopicChunkReport[]
  /** Counts of each status level. */
  counts: Record<ChunkLimitStatus, number>
  /** Total entries across all topics. */
  totalEntries: number
  /** Config snapshot used for this report. */
  limits: {
    softEntries: number
    hardEntries: number
    softLines: number
    hardLines: number
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize index input to a flat array of entries.
 *
 * The schema in residualIndex.ts defines `{ version, entries: Record<id, entry> }`,
 * but production memory/index.json has been observed as a flat Array<entry>
 * during migration (see daily log 2026-04-21). Accept both shapes so this
 * module works regardless of which format is on disk.
 */
export function normalizeIndexEntries(
  raw: ResidualIndex | ResidualEntry[] | unknown,
): ResidualEntry[] {
  if (Array.isArray(raw)) return raw as ResidualEntry[]
  if (raw && typeof raw === 'object' && 'entries' in raw) {
    const entries = (raw as ResidualIndex).entries
    return Object.values(entries)
  }
  return []
}

/** Count entries per topic. */
export function countEntriesByTopic(entries: ResidualEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const e of entries) {
    counts.set(e.topic, (counts.get(e.topic) ?? 0) + 1)
  }
  return counts
}

/** Count lines in a topic file. Returns 0 if the file doesn't exist. */
async function countTopicFileLines(memoryDir: string, topic: string): Promise<number> {
  const path = topicFilePath(memoryDir, topic)
  try {
    await stat(path)
    const content = await readFile(path, 'utf8')
    return content.split('\n').length
  } catch {
    return 0
  }
}

/**
 * Classify a topic against soft/hard limits for both entries and lines.
 * Worst-case wins: if entries are 'hard' and lines are 'soft', status is 'hard'.
 */
export function classifyTopic(
  entryCount: number,
  lineCount: number,
  limits: TopologyReport['limits'],
): { status: ChunkLimitStatus; triggeredBy: TopicChunkReport['triggeredBy'] } {
  const entryStatus: ChunkLimitStatus =
    entryCount >= limits.hardEntries ? 'hard' :
    entryCount >= limits.softEntries ? 'soft' : 'under'

  const lineStatus: ChunkLimitStatus =
    lineCount >= limits.hardLines ? 'hard' :
    lineCount >= limits.softLines ? 'soft' : 'under'

  // Worst case wins.
  const rank = (s: ChunkLimitStatus) => s === 'hard' ? 2 : s === 'soft' ? 1 : 0
  if (rank(entryStatus) >= rank(lineStatus)) {
    return {
      status: entryStatus,
      triggeredBy: entryStatus === 'under' ? 'none' : 'entries',
    }
  }
  return {
    status: lineStatus,
    triggeredBy: lineStatus === 'under' ? 'none' : 'lines',
  }
}

function formatMessage(report: Omit<TopicChunkReport, 'message'>): string {
  const { topic, entryCount, lineCount, status, triggeredBy } = report
  const prefix = status === 'hard' ? 'HARD LIMIT' :
                 status === 'soft' ? 'soft limit' : 'ok'
  const trigger = triggeredBy === 'entries' ? `${entryCount} entries` :
                  triggeredBy === 'lines' ? `${lineCount} lines` :
                  `${entryCount}e/${lineCount}L`
  return `[${prefix}] ${topic}: ${trigger}`
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Generate a topology report for all topics in the memory directory.
 *
 * Reads index.json for entry counts and topics/*.md for line counts.
 * Non-destructive: only measures and classifies, never modifies state.
 *
 * @param memoryDir - Path to memory directory (default: ~/.claude/memory)
 * @returns TopologyReport with per-topic status sorted by severity
 */
export async function buildTopologyReport(memoryDir: string): Promise<TopologyReport> {
  const config = getScreeningConfig()
  const limits = {
    softEntries: config.topicSoftLimitEntries,
    hardEntries: config.topicHardLimitEntries,
    softLines: config.topicSoftLimitLines,
    hardLines: config.topicHardLimitLines,
  }

  const rawIndex = await readResidualIndex(memoryDir).catch(() => null)
  const entries = normalizeIndexEntries(rawIndex)

  // Also attempt to read raw file for legacy array format — readResidualIndex
  // returns empty index if the schema doesn't match, but the file may still
  // contain a flat array (migration artifact).
  let allEntries = entries
  if (entries.length === 0) {
    try {
      const raw = await readFile(join(memoryDir, 'index.json'), 'utf8')
      const parsed = JSON.parse(raw)
      allEntries = normalizeIndexEntries(parsed)
    } catch {
      // no index available
    }
  }

  const countsByTopic = countEntriesByTopic(allEntries)
  const topicReports: TopicChunkReport[] = []

  for (const [topic, entryCount] of countsByTopic) {
    const lineCount = await countTopicFileLines(memoryDir, topic)
    const { status, triggeredBy } = classifyTopic(entryCount, lineCount, limits)
    const partial = { topic, entryCount, lineCount, status, triggeredBy }
    topicReports.push({ ...partial, message: formatMessage(partial) })
  }

  // Sort: hard > soft > under, then by entry count desc within each tier.
  const rank = (s: ChunkLimitStatus) => s === 'hard' ? 2 : s === 'soft' ? 1 : 0
  topicReports.sort((a, b) => {
    const diff = rank(b.status) - rank(a.status)
    if (diff !== 0) return diff
    return b.entryCount - a.entryCount
  })

  const counts: Record<ChunkLimitStatus, number> = { under: 0, soft: 0, hard: 0 }
  for (const r of topicReports) counts[r.status]++

  return {
    topics: topicReports,
    counts,
    totalEntries: allEntries.length,
    limits,
  }
}

/**
 * Return topics that exceed the hard limit — these should trigger forced
 * split/promotion at the next distillation cycle.
 */
export function getTopicsRequiringPromotion(
  report: TopologyReport,
): TopicChunkReport[] {
  return report.topics.filter(t => t.status === 'hard')
}

/**
 * Return topics that are approaching the hard limit — these should surface
 * split suggestions in the review queue (non-binding).
 */
export function getTopicsApproachingLimit(
  report: TopologyReport,
): TopicChunkReport[] {
  return report.topics.filter(t => t.status === 'soft')
}

/**
 * Format a topology report as a human-readable string, suitable for logging
 * or daily briefing output.
 */
export function formatTopologyReport(report: TopologyReport): string {
  const lines: string[] = []
  lines.push(
    `[topology] ${report.totalEntries} entries, ${report.topics.length} topics ` +
    `(hard=${report.counts.hard}, soft=${report.counts.soft}, under=${report.counts.under})`,
  )
  lines.push(
    `  limits: entries ${report.limits.softEntries}/${report.limits.hardEntries}, ` +
    `lines ${report.limits.softLines}/${report.limits.hardLines}`,
  )
  for (const t of report.topics) {
    if (t.status === 'under') continue // Only show topics needing attention
    lines.push(`  ${t.message}`)
  }
  return lines.join('\n')
}
