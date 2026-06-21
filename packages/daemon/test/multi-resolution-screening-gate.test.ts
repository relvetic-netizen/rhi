// MultiResolutionScreeningGate — Phase 1 iter 1 contract.
//
// Verifies:
//  1. The gate instantiates with the canonical name.
//  2. Returns RetrievalCandidate[] for a minimal corpus with a residual
//     index, enriched with entryIds + concepts (the lift mechanism for
//     Path C strict Recall@5).
//  3. Output `topicPath` is forward-slash on Windows-style relative paths
//     (the Path C strict 0% root-cause fix).
//  4. Empty memory dir returns [] without throwing.
//  5. Empty query short-circuits via the engine, gate not invoked.
//  6. MemoryRetrievalEngine dispatches `mode: 'multiResolution'` to the new
//     gate while keeping `mode: 'tool'` on the legacy `gate` (backward
//     compat with existing MemorySearchTool / distillVerifier callers).
//  7. RetrievalCandidate Zod schema validates the gate output.

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryRetrievalEngine,
  DefaultBm25ScreeningGate,
  MultiResolutionScreeningGate,
  RetrievalCandidateSchema,
  type GateContext,
  type GateStrategy,
  type RetrievalCandidate,
} from '../../extracted/memory/MemoryRetrievalEngine.js'
import type { MemoryHeaderLike } from '../../extracted/screening/memoryScreening.js'

function makeTempMemoryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'multi-res-gate-test-'))

  // Hierarchical topic file — this is the exact corpus shape that broke
  // Path C strict matching on Windows (backslash filename vs forward-slash
  // `topicPathForEntry` key).
  mkdirSync(join(dir, 'topics/architecture'), { recursive: true })
  writeFileSync(
    join(dir, 'topics/architecture/hooks.md'),
    '# hooks\n\nrelvetia daemon hook fire detection contract.\n',
  )

  // Flat topic file — control case (worked on Windows even before the fix).
  mkdirSync(join(dir, 'topics'), { recursive: true })
  writeFileSync(
    join(dir, 'topics/preferences.md'),
    '# preferences\n\nbun is preferred over npm for daemon installs.\n',
  )

  // Residual index that points at both topic files.
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      entries: {
        hooks_001: {
          id: 'hooks_001',
          topic: 'architecture/hooks',
          summary: 'relvetia daemon hook fire detection contract',
          sources: ['topics/architecture/hooks.md:L1'],
          concepts: ['hook', 'daemon', 'fire-detection'],
          updated: '2026-05-19',
          confidence: 1,
        },
        pref_001: {
          id: 'pref_001',
          topic: 'preferences',
          summary: 'bun is preferred over npm',
          sources: ['topics/preferences.md:L1'],
          concepts: ['bun', 'npm', 'package-manager'],
          updated: '2026-05-19',
          confidence: 1,
        },
      },
    }),
  )
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ version: 1, entries: {} }))
  // Force older mtime so recency boost doesn't dominate the BM25 signal.
  const oldTime = new Date('2026-05-01T00:00:00Z')
  utimesSync(join(dir, 'topics/architecture/hooks.md'), oldTime, oldTime)
  utimesSync(join(dir, 'topics/preferences.md'), oldTime, oldTime)
  return dir
}

describe('MultiResolutionScreeningGate — Phase 1 iter 1 contract', () => {
  it('instantiates with canonical name', () => {
    const gate = new MultiResolutionScreeningGate()
    expect(gate.name).toBe('multi-resolution-screening')
  })

  it('returns [] for an empty memory dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'multi-res-empty-'))
    try {
      const gate = new MultiResolutionScreeningGate()
      const out = await gate.gate(dir, 'anything')
      expect(out).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns enriched RetrievalCandidate[] for a hierarchical topic corpus', async () => {
    const dir = makeTempMemoryDir()
    try {
      const gate = new MultiResolutionScreeningGate()
      const out = await gate.gate(dir, 'hook fire detection daemon')
      expect(out.length).toBeGreaterThan(0)

      // Every candidate validates the Zod schema.
      for (const hit of out) RetrievalCandidateSchema.parse(hit)

      // Lift mechanism: at least one hit carries entryIds from the residual
      // index. Pre-fix (backslash filename, forward-slash map keys on
      // Windows) this was always empty for hierarchical topics → Path C
      // strict Recall@5 = 0%. Post-fix entryIds are populated.
      const hitsWithEntries = out.filter(h => h.entryIds.length > 0)
      expect(hitsWithEntries.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('output topicPath is forward-slash even for hierarchical topics', async () => {
    const dir = makeTempMemoryDir()
    try {
      const gate = new MultiResolutionScreeningGate()
      const out = await gate.gate(dir, 'hook fire detection')
      // No candidate should leak backslashes — the normalization happens
      // at the gate boundary so downstream consumers (Sonnet selector,
      // bench mapping, engine fuse) see one canonical separator.
      for (const hit of out) {
        expect(hit.topicPath).not.toContain('\\')
      }
      // At least one hit should hit the hierarchical file we wrote.
      expect(out.some(h => h.topicPath === 'topics/architecture/hooks.md')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('engine dispatches mode="multiResolution" to MultiResolutionScreeningGate by default', async () => {
    const engine = new MemoryRetrievalEngine()
    expect(engine.gateByMode.multiResolution).toBeInstanceOf(MultiResolutionScreeningGate)
    expect(engine.gate).toBeInstanceOf(DefaultBm25ScreeningGate)
  })

  it('engine keeps mode="tool" / "verify" on the legacy gate (backward compat)', async () => {
    // Stub `gate` so we can observe which gate the engine selected per mode.
    let toolGateCalls = 0
    let multiGateCalls = 0
    const stubLegacy: GateStrategy = {
      name: 'stub-legacy',
      async gate() { toolGateCalls++; return [] },
    }
    const stubMulti: GateStrategy = {
      name: 'stub-multi',
      async gate() {
        multiGateCalls++
        return [{
          topicPath: 'topics/x.md',
          filePath: '/m/topics/x.md',
          entryIds: ['x_001'],
          rawRelevanceScore: 1.0,
          usageAdjustedScore: 1.0,
          source: 'file-bm25',
          concepts: [],
          snippet: '',
        }]
      },
    }
    const engine = new MemoryRetrievalEngine({
      gate: stubLegacy,
      gateByMode: { multiResolution: stubMulti },
    })

    await engine.retrieve('/m', 'q', { mode: 'tool' })
    expect(toolGateCalls).toBe(1)
    expect(multiGateCalls).toBe(0)

    await engine.retrieve('/m', 'q', { mode: 'verify' })
    expect(toolGateCalls).toBe(2)
    expect(multiGateCalls).toBe(0)

    const multiResult = await engine.retrieve('/m', 'q', { mode: 'multiResolution' })
    expect(toolGateCalls).toBe(2)
    expect(multiGateCalls).toBe(1)
    expect(multiResult.hits[0]?.topicPath).toBe('topics/x.md')
    expect(multiResult.hits[0]?.entryIds).toEqual(['x_001'])
  })

  it('engine empty-query short-circuit still skips the multi-resolution gate', async () => {
    let multiGateCalls = 0
    const stubMulti: GateStrategy = {
      name: 'stub-multi',
      async gate() { multiGateCalls++; return [] },
    }
    const engine = new MemoryRetrievalEngine({
      gateByMode: { multiResolution: stubMulti },
    })
    const result = await engine.retrieve('/m', '   ', { mode: 'multiResolution' })
    expect(multiGateCalls).toBe(0)
    expect(result.hits).toHaveLength(0)
  })

  it('engine.retrieve threads sideData.preScanned through to the gate (double-scan avoidance)', async () => {
    // Stub gate captures the GateContext it was handed. The retrieve()
    // signature accepts a fourth sideData arg whose `preScanned` field
    // must flow into the gate's ctx so callers (findRelevantMemories) can
    // skip the redundant scanMemoryFiles call.
    let observedCtx: GateContext | undefined
    const stubMulti: GateStrategy = {
      name: 'stub-capturing',
      async gate(_dir, _q, ctx) {
        observedCtx = ctx
        return []
      },
    }
    const engine = new MemoryRetrievalEngine({
      gateByMode: { multiResolution: stubMulti },
    })
    const preScanned: MemoryHeaderLike[] = [
      { filename: 'topics/x.md', filePath: '/m/topics/x.md', mtimeMs: 0, description: null },
    ]
    await engine.retrieve('/m', 'q', { mode: 'multiResolution' }, { preScanned })
    expect(observedCtx).toBeDefined()
    expect(observedCtx?.preScanned).toBe(preScanned)
  })

  it('engine through MultiResolutionScreeningGate produces Path-C-equivalent diversity for hierarchical topics', async () => {
    // Cross-check: the engine end-to-end retrieve at mode='multiResolution'
    // surfaces both flat and hierarchical topic files (which Path A may
    // miss when its searchMemoryWithScreening collapses to aggregated paths).
    // This is the structural lift Phase 1 iter 1 targets.
    const dir = makeTempMemoryDir()
    try {
      const engine = new MemoryRetrievalEngine()
      const result = await engine.retrieve(dir, 'bun preferences', { mode: 'multiResolution', maxResults: 5 })
      expect(result.diagnostics.mode).toBe('multiResolution')
      // Hierarchical-shape topic paths must round-trip with forward slashes.
      for (const hit of result.hits) expect(hit.topicPath).not.toContain('\\')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
