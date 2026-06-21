#!/usr/bin/env node
// verify-runner - standalone and native entry point for distillation verification.
//
// CLI usage:
//   node dist-runners/verify-runner.js                         # verify today's entries
//   node dist-runners/verify-runner.js --memory-dir /path      # custom memory dir
//   node dist-runners/verify-runner.js --scope all             # verify all entries

import { homedir } from 'os'
import { join, resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  verifyDistillation,
  remediateMissingEntries,
  logVerificationResults,
  verifyIndexShape,
  type IndexShapeAxisResult,
} from '../../extracted/memory/distillVerifier.js'

export type VerifyScope = 'today' | 'all'

export type VerifyRunnerContext = {
  memoryDir: string
  scope?: VerifyScope
}

export type VerifyRunnerResult = {
  success: boolean
  summary: string
  scope: VerifyScope
  hitRate: number
  totalEntries: number
  foundEntries: number
  missingCount: number
  missingIds: string[]
  remediatedEntries: number
  maxEntries: number
  /** Phase C — per-axis index-shape verification (3 axes, all-pass required). */
  indexShapeAxes?: IndexShapeAxisResult[]
  indexShapePassed?: boolean
  error?: string
}

function parseScope(value: string | undefined, fallback: VerifyScope): VerifyScope {
  return value === 'today' || value === 'all' ? value : fallback
}

function parseMaxEntries(): number {
  const raw = process.env.RELVETIA_MAX_VERIFY_ENTRIES
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 20
}

function defaultMemoryDir(): string {
  return process.env.RELVETIA_MEMORY_DIR ?? join(homedir(), '.claude', 'memory')
}

export async function verifyRunner(ctx: VerifyRunnerContext): Promise<VerifyRunnerResult> {
  const scope = ctx.scope ?? parseScope(process.env.RELVETIA_VERIFY_SCOPE, 'all')
  const maxEntries = parseMaxEntries()

  if (process.env.RELVETIA_VERIFY_FORCE_FAIL === '1') {
    return {
      success: false,
      summary: 'forced failure for debug',
      scope,
      hitRate: 0,
      totalEntries: 0,
      foundEntries: 0,
      missingCount: 0,
      missingIds: [],
      remediatedEntries: 0,
      maxEntries,
    }
  }

  try {
    console.log(`[verify-runner] verifying scope=${scope} memoryDir=${ctx.memoryDir}`)
    const result = await verifyDistillation(ctx.memoryDir, scope)

    console.log(
      `[verify-runner] hit rate: ${Math.round(result.hitRate * 100)}% ` +
      `(${result.foundEntries}/${result.totalEntries}) - ${result.passed ? 'PASSED' : 'FAILED'}`,
    )

    let remediatedEntries = 0
    if (result.missingEntries.length > 0) {
      remediatedEntries = await remediateMissingEntries(ctx.memoryDir, result.missingEntries)
      console.log(`[verify-runner] remediated ${remediatedEntries} entries with expanded concepts`)
    }

    await logVerificationResults(ctx.memoryDir, result)

    // Phase C — index-shape 3-axis dogfood. Logs one PASSED/FAILED line per
    // axis; aggregate `success` fails closed if either hit-rate OR any shape
    // axis fails. (Phase 5 hit-rate contract preserved; axes are additive.)
    const shape = await verifyIndexShape(ctx.memoryDir)
    for (const axis of shape.axes) {
      console.log(
        `[verify-runner] index-shape ${axis.axis}: ${axis.passed ? 'PASSED' : 'FAILED'} — ${axis.message}` +
        (axis.samples.length > 0 ? ` (samples: ${axis.samples.join(', ')})` : ''),
      )
    }

    const missingIds = result.missingEntries.map(m => m.entry.id)
    const missingCount = missingIds.length
    const hitRatePct = Math.round(result.hitRate * 100)
    const shapeSuffix = shape.passed
      ? ' indexShape=PASS'
      : ` indexShape=FAIL(${shape.axes.filter(a => !a.passed).map(a => a.axis).join(',')})`
    const summary =
      `hitRate=${hitRatePct}% found=${result.foundEntries}/${result.totalEntries} ` +
      `missing=${missingCount} remediated=${remediatedEntries} scope=${scope}${shapeSuffix}`

    return {
      success: result.passed && shape.passed,
      summary,
      scope,
      hitRate: result.hitRate,
      totalEntries: result.totalEntries,
      foundEntries: result.foundEntries,
      missingCount,
      missingIds,
      remediatedEntries,
      maxEntries,
      indexShapeAxes: shape.axes,
      indexShapePassed: shape.passed,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    return {
      success: false,
      summary: `verify-runner exception: ${error}`,
      scope,
      hitRate: 0,
      totalEntries: 0,
      foundEntries: 0,
      missingCount: 0,
      missingIds: [],
      remediatedEntries: 0,
      maxEntries,
      error,
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const memDirIdx = args.indexOf('--memory-dir')
  const memoryDir = memDirIdx >= 0 && args[memDirIdx + 1]
    ? args[memDirIdx + 1]!
    : defaultMemoryDir()

  if (!memoryDir) {
    console.error('[verify-runner] cannot determine memory directory')
    process.exit(1)
  }

  const scopeIdx = args.indexOf('--scope')
  const scope = parseScope(args[scopeIdx + 1], 'today')
  const result = await verifyRunner({ memoryDir, scope })

  const output = {
    hitRate: result.hitRate,
    totalEntries: result.totalEntries,
    foundEntries: result.foundEntries,
    passed: result.success,
    missingIds: result.missingIds,
    remediatedEntries: result.remediatedEntries,
    summary: result.summary,
    ...(result.error ? { error: result.error } : {}),
  }
  process.stdout.write(JSON.stringify(output))

  // Exit 2 preserves the spawn-path failure signal added in Layer 2.
  if (!result.success) {
    process.exitCode = 2
  }
}

function isCliEntrypoint(): boolean {
  const argvPath = process.argv[1]
  if (!argvPath) return false
  return fileURLToPath(import.meta.url) === resolve(argvPath)
}

if (isCliEntrypoint()) {
  main().catch(e => {
    console.error('[verify-runner] fatal:', e)
    process.exit(1)
  })
}
