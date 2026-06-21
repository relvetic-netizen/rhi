// Memory usage statistics — tracks hit counts and penalties for usage-based weighting.
//
// When a memory is returned by MemorySearch, its hitCount is incremented.
// When a user corrects or negates a memory ("それは違う", "古い情報"),
// a penalty is applied. These signals feed into the final scoring formula:
//
//   finalScore = screening(α) × recency(decay) × usefulness(hitCount) × (1 - penalty)
//
// This creates a feedback loop where frequently useful memories rise to the top
// and corrected/stale memories are deprioritized — without requiring LLM training.
//
// Stats file: ~/.claude/memory/stats.json

import { readFile } from 'fs/promises'
import { join } from 'path'
import { isPrivatePrivatePath } from '../screening/memorySearch.js'
import { atomicWriteJSON } from '../util/atomicWrite.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntryStats = {
  /** Number of times this entry was returned in search results. */
  hitCount: number
  /** Timestamp of the last search hit (epoch ms). */
  lastHitAt: number
  /** Penalty from user corrections. 0.0 = no penalty, 1.0 = fully suppressed. */
  penalty: number
}

export type MemoryStatsData = {
  version: number
  /** Stats keyed by entry ID (from residual index) or file path. */
  entries: Record<string, EntryStats>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATS_FILENAME = 'stats.json'
const CURRENT_VERSION = 1

// Default penalty increment when a user negates a memory.
export const DEFAULT_PENALTY_INCREMENT = 0.3
// Maximum penalty value (never fully suppress — allow recovery).
export const MAX_PENALTY = 0.9
// Penalty decay per day (memories can recover over time).
export const PENALTY_DECAY_PER_DAY = 0.05

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function statsPath(memoryDir: string): string {
  return join(memoryDir, STATS_FILENAME)
}

export async function readMemoryStats(memoryDir: string): Promise<MemoryStatsData> {
  try {
    const raw = await readFile(statsPath(memoryDir), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.entries) {
      return { version: parsed.version ?? CURRENT_VERSION, entries: parsed.entries }
    }
    return emptyStats()
  } catch {
    return emptyStats()
  }
}

export async function writeMemoryStats(
  memoryDir: string,
  stats: MemoryStatsData,
): Promise<void> {
  await atomicWriteJSON(statsPath(memoryDir), stats)
}

function emptyStats(): MemoryStatsData {
  return { version: CURRENT_VERSION, entries: {} }
}

// ---------------------------------------------------------------------------
// Hit tracking
// ---------------------------------------------------------------------------

/**
 * Record search hits for the given entry keys.
 * Call this after MemorySearchTool returns results.
 */
export async function recordHits(
  memoryDir: string,
  keys: string[],
): Promise<void> {
  const includePrivate = process.env.RELVETIA_INCLUDE_PRIVATE === '1'
  const filteredKeys = includePrivate
    ? keys
    : keys.filter(key => !isPrivatePrivatePath(key))

  if (filteredKeys.length === 0) return

  const stats = await readMemoryStats(memoryDir)
  const now = Date.now()

  for (const key of filteredKeys) {
    const existing = stats.entries[key]
    stats.entries[key] = {
      hitCount: (existing?.hitCount ?? 0) + 1,
      lastHitAt: now,
      penalty: existing?.penalty ?? 0,
    }
  }

  await writeMemoryStats(memoryDir, stats)
}

// ---------------------------------------------------------------------------
// Penalty management
// ---------------------------------------------------------------------------

/**
 * Apply a penalty to the given entry keys.
 * Called when user negates or corrects a memory.
 */
export async function applyPenalty(
  memoryDir: string,
  keys: string[],
  increment: number = DEFAULT_PENALTY_INCREMENT,
): Promise<void> {
  const stats = await readMemoryStats(memoryDir)

  for (const key of keys) {
    const existing = stats.entries[key]
    const currentPenalty = existing?.penalty ?? 0
    stats.entries[key] = {
      hitCount: existing?.hitCount ?? 0,
      lastHitAt: existing?.lastHitAt ?? 0,
      penalty: Math.min(currentPenalty + increment, MAX_PENALTY),
    }
  }

  await writeMemoryStats(memoryDir, stats)
}

/**
 * Decay penalties over time. Call this during nightly distillation.
 * Memories can recover from penalties as time passes.
 */
export async function decayPenalties(memoryDir: string): Promise<void> {
  const stats = await readMemoryStats(memoryDir)
  const now = Date.now()
  let changed = false

  for (const [key, entry] of Object.entries(stats.entries)) {
    if (entry.penalty > 0 && entry.lastHitAt > 0) {
      const daysSinceHit = (now - entry.lastHitAt) / (24 * 60 * 60 * 1000)
      const decay = daysSinceHit * PENALTY_DECAY_PER_DAY
      const newPenalty = Math.max(entry.penalty - decay, 0)
      if (newPenalty !== entry.penalty) {
        stats.entries[key] = { ...entry, penalty: newPenalty }
        changed = true
      }
    }
  }

  if (changed) {
    await writeMemoryStats(memoryDir, stats)
  }
}

// ---------------------------------------------------------------------------
// Score adjustment
// ---------------------------------------------------------------------------

/**
 * Compute the usage-based score multiplier for an entry.
 *
 * usefulness = log2(hitCount + 1) — logarithmic to prevent runaway scores
 * penalty    = (1 - penalty) — linear suppression
 *
 * Combined: log2(hitCount + 1) × (1 - penalty)
 *
 * Returns 1.0 for entries with no stats (neutral — doesn't boost or suppress).
 */
export function usageMultiplier(stats: EntryStats | undefined): number {
  if (!stats) return 1.0
  const usefulness = Math.log2(stats.hitCount + 1)
  const penaltyFactor = 1 - stats.penalty
  // Clamp to [0.1, 5.0] to prevent extreme values
  return Math.max(0.1, Math.min(5.0, Math.max(usefulness, 1.0) * penaltyFactor))
}
