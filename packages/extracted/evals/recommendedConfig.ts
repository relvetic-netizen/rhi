// Recommended config — persists and formats optimization recommendations.
//
// The hill-climb optimizer produces a recommended config that a human reviews
// before applying. This module handles persistence and human-readable diffs.

import type { ScreeningConfigShape } from '../screening/screeningConfig.js'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecommendedConfig = {
  config: ScreeningConfigShape
  basedOnBaseline: string
  optimizationPassRate: number
  holdoutPassRate: number
  changes: Array<{ param: string; oldValue: number | boolean; newValue: number | boolean }>
  createdAt: string
  status: 'pending-review' | 'approved' | 'rejected'
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const FILENAME = 'recommended-config.json'

export async function writeRecommendedConfig(
  dir: string,
  rec: RecommendedConfig,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, FILENAME), JSON.stringify(rec, null, 2))
}

export async function readRecommendedConfig(
  dir: string,
): Promise<RecommendedConfig | null> {
  try {
    const raw = await readFile(join(dir, FILENAME), 'utf8')
    return JSON.parse(raw) as RecommendedConfig
  } catch {
    return null
  }
}

export async function updateRecommendedStatus(
  dir: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  const rec = await readRecommendedConfig(dir)
  if (!rec) return
  rec.status = status
  await writeRecommendedConfig(dir, rec)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatConfigDiff(rec: RecommendedConfig): string {
  const lines: string[] = [
    '=== Recommended Config Changes ===',
    `Based on baseline: ${rec.basedOnBaseline}`,
    `Status: ${rec.status}`,
    '',
    'Changes:',
  ]

  if (rec.changes.length === 0) {
    lines.push('  (no changes — current config is optimal)')
  } else {
    for (const c of rec.changes) {
      const delta = typeof c.oldValue === 'number' && typeof c.newValue === 'number'
        ? ` (${c.newValue > c.oldValue ? '+' : ''}${Math.round((c.newValue - c.oldValue) * 1000) / 1000})`
        : ''
      lines.push(`  ${c.param}: ${c.oldValue} → ${c.newValue}${delta}`)
    }
  }

  lines.push('')
  lines.push(`Optimization pass rate: ${(rec.optimizationPassRate * 100).toFixed(1)}%`)
  lines.push(`Holdout pass rate: ${(rec.holdoutPassRate * 100).toFixed(1)}%`)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildRecommendedConfig(
  baseConfig: ScreeningConfigShape,
  recommendedConfig: ScreeningConfigShape,
  baselineId: string,
  optPassRate: number,
  holdoutPassRate: number,
): RecommendedConfig {
  const changes: RecommendedConfig['changes'] = []

  for (const key of Object.keys(baseConfig) as (keyof ScreeningConfigShape)[]) {
    const oldVal = baseConfig[key]
    const newVal = recommendedConfig[key]
    if (oldVal !== newVal) {
      changes.push({
        param: key,
        oldValue: oldVal as number | boolean,
        newValue: newVal as number | boolean,
      })
    }
  }

  return {
    config: recommendedConfig,
    basedOnBaseline: baselineId,
    optimizationPassRate: optPassRate,
    holdoutPassRate: holdoutPassRate,
    changes,
    createdAt: new Date().toISOString(),
    status: 'pending-review',
  }
}
