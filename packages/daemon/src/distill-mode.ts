// Distill mode selector — Phase 15 (PHOTON RecGen equivalent).
//
// PHOTON paper's inference-time trick: "RecGen" retains only the top-most
// KV state and reconstructs lower-level summaries via the decoder, skipping
// bottom-up re-encoding of already-stable data. We apply the same principle
// to nightly distillation:
//
//   hier  — full HierGen: re-read all topics, re-classify all entries,
//            rebuild MEMORY.md from scratch. ~10× more expensive.
//   rec   — incremental RecGen: only today's new entries are classified;
//            topic files are appended to; MEMORY.md is patched not rebuilt.
//
// Mode selection rules (evaluated in order — first match wins):
//
//   1. If drift report recommends HierGen (any topic critical)     → hier
//   2. If days since last HierGen ≥ 7                              → hier
//   3. If day-of-week is Sunday                                     → hier (weekly refresh)
//   4. If no cached topology/drift report exists                    → hier (cold start)
//   5. Otherwise                                                    → rec
//
// The cache file `.last-topology.json` is written by topology-runner
// after verify. A companion file `.last-hiergen.json` records the last
// successful hier run timestamp.

import { readFile, stat } from 'fs/promises'
import { join } from 'path'

export type DistillMode = 'hier' | 'rec'

export type ModeDecision = {
  mode: DistillMode
  reason: string
  cacheFound: boolean
  daysSinceLastHier: number | null
  recommendHierGen: boolean | null
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const HIER_REFRESH_DAYS = 7

type TopologyCache = {
  timestamp: string
  recommendHierGen: boolean
  maxDrift: number
  criticalTopics: string[]
}

async function readTopologyCache(memoryDir: string): Promise<TopologyCache | null> {
  try {
    const raw = await readFile(join(memoryDir, '.last-topology.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (
      parsed && typeof parsed === 'object' &&
      typeof parsed.recommendHierGen === 'boolean' &&
      typeof parsed.timestamp === 'string'
    ) {
      return parsed as TopologyCache
    }
    return null
  } catch {
    return null
  }
}

async function readLastHierTimestamp(memoryDir: string): Promise<Date | null> {
  try {
    const raw = await readFile(join(memoryDir, '.last-hiergen.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.timestamp === 'string') {
      const d = new Date(parsed.timestamp)
      if (!isNaN(d.getTime())) return d
    }
    return null
  } catch {
    return null
  }
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / ONE_DAY_MS
}

/**
 * Decide which distillation mode to run based on drift report + schedule.
 * Pure function over inputs; no side effects.
 */
export function decideMode(inputs: {
  cache: TopologyCache | null
  lastHier: Date | null
  now: Date
}): ModeDecision {
  const { cache, lastHier, now } = inputs

  const daysSinceLastHier = lastHier ? daysBetween(now, lastHier) : null
  const recommendHierGen = cache?.recommendHierGen ?? null

  if (!cache) {
    return {
      mode: 'hier',
      reason: 'no cached topology report — cold start forces full hier',
      cacheFound: false,
      daysSinceLastHier,
      recommendHierGen: null,
    }
  }

  if (cache.recommendHierGen) {
    return {
      mode: 'hier',
      reason: `drift report recommends HierGen (critical topics: ${cache.criticalTopics.join(', ') || '—'})`,
      cacheFound: true,
      daysSinceLastHier,
      recommendHierGen: true,
    }
  }

  if (daysSinceLastHier !== null && daysSinceLastHier >= HIER_REFRESH_DAYS) {
    return {
      mode: 'hier',
      reason: `${daysSinceLastHier.toFixed(1)} days since last hier (≥ ${HIER_REFRESH_DAYS}), weekly refresh`,
      cacheFound: true,
      daysSinceLastHier,
      recommendHierGen: false,
    }
  }

  if (now.getDay() === 0) {
    // Sunday: if we haven't run hier today, do so regardless of drift.
    if (!lastHier || daysBetween(now, lastHier) >= 0.9) {
      return {
        mode: 'hier',
        reason: 'Sunday weekly HierGen refresh',
        cacheFound: true,
        daysSinceLastHier,
        recommendHierGen: false,
      }
    }
  }

  return {
    mode: 'rec',
    reason: 'drift ok + within HierGen refresh window → incremental RecGen',
    cacheFound: true,
    daysSinceLastHier,
    recommendHierGen: false,
  }
}

/**
 * Load caches from disk and decide distill mode.
 */
export async function selectDistillMode(memoryDir: string): Promise<ModeDecision> {
  const cache = await readTopologyCache(memoryDir)
  const lastHier = await readLastHierTimestamp(memoryDir)
  return decideMode({ cache, lastHier, now: new Date() })
}

// --- Distill scope (standard vs full) ---

export type DistillScope = 'standard' | 'full'

export function resolveDistillScope(): DistillScope {
  const env = process.env.DISTILL_SCOPE
  if (env === 'standard') return 'standard'
  return 'full'
}
