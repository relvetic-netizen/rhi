// CorpusManifest — Phase 2 iter 2 (memory-search-improvement-loop saga).
//
// Validates the Zod schema, default factory, and `matchesCorpus` evaluation
// rules. Coverage focuses on the cases that drove the design:
//   - log file dominance fix (Path C six-axis-v1 max-exposure 58.3%) →
//     `excludedRoots: ['logs']` must drop every `logs/YYYY/MM/*.md` entry
//   - Windows backslash path trap (Phase 1 iter 1 lesson) → `matchesCorpus`
//     must produce identical results regardless of separator
//   - glob support for `tmp-*` (covers `perf-benchmark-runner.mjs` temp dirs)

import { describe, it, expect } from 'vitest'
import {
  CorpusManifestSchema,
  getDefaultCorpusManifest,
  getDefaultPathCCorpusManifest,
  matchesCorpus,
  type CorpusManifest,
} from '../../extracted/memory/CorpusManifest.js'

describe('CorpusManifest — schema', () => {
  it('validates an empty manifest', () => {
    const parsed = CorpusManifestSchema.parse({})
    expect(parsed).toEqual({})
  })

  it('validates a fully populated manifest', () => {
    const parsed = CorpusManifestSchema.parse({
      includedRoots: ['topics'],
      excludedRoots: ['.backup', 'logs'],
      layer: 'topics',
      freshness: { withinDays: 30, beforeDate: '2026-05-20T00:00:00.000Z' },
    })
    expect(parsed.includedRoots).toEqual(['topics'])
    expect(parsed.layer).toBe('topics')
    expect(parsed.freshness?.withinDays).toBe(30)
  })

  it('rejects unknown layer values', () => {
    expect(() => CorpusManifestSchema.parse({ layer: 'unknown' })).toThrow()
  })

  it('rejects non-positive withinDays', () => {
    expect(() =>
      CorpusManifestSchema.parse({ freshness: { withinDays: 0 } }),
    ).toThrow()
  })
})

describe('CorpusManifest — defaults', () => {
  it('excludes .backup / .staging / tmp-* by default', () => {
    const m = getDefaultCorpusManifest()
    expect(m.excludedRoots).toContain('.backup')
    expect(m.excludedRoots).toContain('.staging')
    expect(m.excludedRoots).toContain('tmp-*')
    expect(m.layer).toBe('all')
  })

  it('accepts production-shaped paths by default', () => {
    const m = getDefaultCorpusManifest()
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
    expect(matchesCorpus('logs/2026/05/2026-05-19.md', m)).toBe(true)
    expect(matchesCorpus('MEMORY.md', m)).toBe(true)
  })

  it('drops .backup and tmp-* paths by default', () => {
    const m = getDefaultCorpusManifest()
    expect(matchesCorpus('.backup/snapshot.md', m)).toBe(false)
    expect(matchesCorpus('.staging/draft.md', m)).toBe(false)
    expect(matchesCorpus('tmp-perf-test/runs.md', m)).toBe(false)
  })
})

describe('CorpusManifest — matchesCorpus include/exclude', () => {
  it('includedRoots whitelists matching paths only', () => {
    const m: CorpusManifest = { includedRoots: ['topics'] }
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
    expect(matchesCorpus('topics/nested/deep.md', m)).toBe(true)
    expect(matchesCorpus('logs/2026/05/2026-05-19.md', m)).toBe(false)
    expect(matchesCorpus('MEMORY.md', m)).toBe(false)
  })

  it('excludedRoots: ["logs"] drops every log file (option A boundary)', () => {
    const m: CorpusManifest = { excludedRoots: ['logs'] }
    expect(matchesCorpus('logs/2026/05/2026-05-13.md', m)).toBe(false)
    expect(matchesCorpus('logs/2026/05/2026-05-15.md', m)).toBe(false)
    // `topics/log-aggregate.md` superficially contains "log" but should pass.
    expect(matchesCorpus('topics/log-aggregate.md', m)).toBe(true)
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
  })

  it('glob excludedRoots (tmp-*) matches any tmp-NNN prefix', () => {
    const m: CorpusManifest = { excludedRoots: ['tmp-*'] }
    expect(matchesCorpus('tmp-perf-test-9oRiQZ/runs.md', m)).toBe(false)
    expect(matchesCorpus('tmp-grep-baseline-Z7awc3/grep-runs.md', m)).toBe(false)
    // No `-` after `tmp` → not a tmp-* dir, must not match
    expect(matchesCorpus('tmp/keep.md', m)).toBe(true)
    expect(matchesCorpus('topics/x.md', m)).toBe(true)
  })
})

describe('CorpusManifest — matchesCorpus layer', () => {
  it('layer: "topics" restricts to topics/ subtree', () => {
    const m: CorpusManifest = { layer: 'topics' }
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
    expect(matchesCorpus('topics/nested/dir/file.md', m)).toBe(true)
    expect(matchesCorpus('logs/2026/05/2026-05-19.md', m)).toBe(false)
    expect(matchesCorpus('MEMORY.md', m)).toBe(false)
  })

  it('layer: "all" lets every path through', () => {
    const m: CorpusManifest = { layer: 'all' }
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
    expect(matchesCorpus('logs/2026/05/2026-05-19.md', m)).toBe(true)
    expect(matchesCorpus('concepts/graph.json', m)).toBe(true)
  })
})

describe('CorpusManifest — matchesCorpus freshness', () => {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000

  it('withinDays keeps files newer than the cutoff', () => {
    const m: CorpusManifest = { freshness: { withinDays: 7 } }
    expect(matchesCorpus('logs/x.md', m, now - 3 * dayMs)).toBe(true)
    expect(matchesCorpus('logs/x.md', m, now - 30 * dayMs)).toBe(false)
  })

  it('beforeDate keeps files older than the cutoff', () => {
    const m: CorpusManifest = {
      freshness: { beforeDate: new Date(now).toISOString() },
    }
    expect(matchesCorpus('logs/x.md', m, now - dayMs)).toBe(true)
    expect(matchesCorpus('logs/x.md', m, now + dayMs)).toBe(false)
  })

  it('freshness is ignored when mtime is not supplied', () => {
    const m: CorpusManifest = { freshness: { withinDays: 1 } }
    // No mtime → freshness condition cannot be evaluated, file passes by default
    expect(matchesCorpus('logs/x.md', m)).toBe(true)
  })
})

describe('CorpusManifest — Windows backslash normalization', () => {
  it('treats backslash and forward-slash paths identically (Phase 1 iter 1 trap)', () => {
    const m: CorpusManifest = { excludedRoots: ['logs'] }
    expect(matchesCorpus('logs/2026/05/2026-05-19.md', m)).toBe(false)
    expect(matchesCorpus('logs\\2026\\05\\2026-05-19.md', m)).toBe(false)
    expect(matchesCorpus('topics\\architecture.md', m)).toBe(true)
  })

  it('layer match works on backslash paths', () => {
    const m: CorpusManifest = { layer: 'topics' }
    expect(matchesCorpus('topics\\architecture.md', m)).toBe(true)
    expect(matchesCorpus('logs\\x.md', m)).toBe(false)
  })
})

describe('CorpusManifest — Path C default (option A log dominance fix)', () => {
  it('extends the bare default with a logs exclusion', () => {
    const base = getDefaultCorpusManifest()
    const pathC = getDefaultPathCCorpusManifest()
    expect(pathC.excludedRoots).toEqual([...(base.excludedRoots ?? []), 'logs'])
    expect(pathC.layer).toBe(base.layer)
  })

  it('drops every logs/YYYY/MM/*.md path that drove six-axis-v1 max-exposure 58.3%', () => {
    const m = getDefaultPathCCorpusManifest()
    // Sampled directly from baseline-v1.md topExposed list.
    expect(matchesCorpus('logs/2026/05/2026-05-13.md', m)).toBe(false)
    expect(matchesCorpus('logs/2026/05/2026-05-15.md', m)).toBe(false)
    expect(matchesCorpus('logs/2026/05/2026-05-12.md', m)).toBe(false)
    // Hierarchical topic file (one of the canonical strict-match targets)
    // must still pass.
    expect(matchesCorpus('topics/project-context/team-context-p1-saga.md', m)).toBe(true)
  })

  it('keeps the bare default exclusions intact under Path C composition', () => {
    const m = getDefaultPathCCorpusManifest()
    expect(matchesCorpus('.backup/snapshot.md', m)).toBe(false)
    expect(matchesCorpus('.staging/draft.md', m)).toBe(false)
    expect(matchesCorpus('tmp-perf-test-XYZ/runs.md', m)).toBe(false)
  })
})

describe('CorpusManifest — combined conditions (AND semantics)', () => {
  it('all conditions must hold simultaneously', () => {
    const m: CorpusManifest = {
      excludedRoots: ['logs'],
      layer: 'topics',
    }
    expect(matchesCorpus('topics/architecture.md', m)).toBe(true)
    expect(matchesCorpus('topics/log-aggregate.md', m)).toBe(true)
    expect(matchesCorpus('logs/2026/05/x.md', m)).toBe(false)
    // layer:topics drops MEMORY.md even though no exclusion matches it
    expect(matchesCorpus('MEMORY.md', m)).toBe(false)
  })
})
