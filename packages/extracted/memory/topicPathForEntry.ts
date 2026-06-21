// Topic path helper — single source of truth for the `topics/<topic>.md`
// convention used across the screening + retrieval pipeline.
//
// Phase 3 (memory-hardening sprint) T1 deliverable. Replaces six template-literal
// callsites in memorySearch.ts + multiResolutionScreening.ts and two helpers in
// topicChunking.ts + driftMonitor.ts. Future hierarchical-topic work (T4) only
// needs to touch this module instead of chasing every callsite.
//
// Three exports:
//   topicPath(topic)              → "topics/<topic>.md" (relative)
//   topicPathForEntry(entry)      → sugar over topicPath(entry.topic)
//   topicFilePath(memoryDir, t)   → join(memoryDir, topicPath(t)) for filesystem access

import { join } from 'path'

/**
 * Topic-string → relative topic file path.
 *
 * Returns `topics/<topic>.md`. Hierarchical topics round-trip unchanged:
 * `architecture/hooks` → `topics/architecture/hooks.md`.
 */
export function topicPath(topic: string): string {
  return `topics/${topic}.md`
}

/**
 * Entry → relative topic file path.
 *
 * Sugar over `topicPath(entry.topic)`. Uses a structural `{ topic: string }`
 * parameter instead of importing `ResidualEntry` so this module stays
 * dependency-light and any caller holding a topic-like value can use it.
 */
export function topicPathForEntry(entry: { topic: string }): string {
  return topicPath(entry.topic)
}

/**
 * Topic-string → absolute topic file path under a memoryDir root.
 *
 * For callers (topicChunking, driftMonitor) that need filesystem access.
 * Always go through this helper instead of `join(memoryDir, 'topics', ...)`
 * so the `topics/` directory prefix lives in exactly one place.
 */
export function topicFilePath(memoryDir: string, topic: string): string {
  return join(memoryDir, topicPath(topic))
}
