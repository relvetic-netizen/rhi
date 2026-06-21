import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  computeTopicDrift,
  buildDriftReport,
  formatDriftReport,
  DRIFT_WARNING_THRESHOLD,
  DRIFT_CRITICAL_THRESHOLD,
} from '../../extracted/memory/driftMonitor.js'
import type { ResidualEntry } from '../../extracted/memory/residualIndex.js'

function makeEntry(overrides: Partial<ResidualEntry> = {}): ResidualEntry {
  return {
    id: overrides.id ?? 't_1',
    topic: overrides.topic ?? 'tooling',
    summary: overrides.summary ?? 'entry summary',
    sources: overrides.sources ?? [],
    concepts: overrides.concepts ?? [],
    updated: overrides.updated ?? '2026-04-21',
    confidence: overrides.confidence ?? 1,
  }
}

// ---------------------------------------------------------------------------
// computeTopicDrift — degenerate cases
// ---------------------------------------------------------------------------

describe('computeTopicDrift — degenerate cases', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-drift-'))
    await mkdir(join(dir, 'topics'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns healthy when both sides are empty', async () => {
    const d = await computeTopicDrift(dir, 'missing', [])
    expect(d.drift).toBe(0)
    expect(d.similarity).toBe(1)
    expect(d.level).toBe('healthy')
  })

  it('returns critical when entries exist but topic file does not', async () => {
    const entries = [makeEntry({ summary: 'the user prefers bun' })]
    const d = await computeTopicDrift(dir, 'tooling', entries)
    expect(d.drift).toBe(1)
    expect(d.level).toBe('critical')
    expect(d.topicFileExists).toBe(false)
  })

  it('returns critical when topic file exists but no entries', async () => {
    await writeFile(join(dir, 'topics', 'orphan.md'), '# orphan\nsome content')
    const d = await computeTopicDrift(dir, 'orphan', [])
    expect(d.drift).toBe(1)
    expect(d.level).toBe('critical')
  })
})

// ---------------------------------------------------------------------------
// computeTopicDrift — alignment quality
// ---------------------------------------------------------------------------

describe('computeTopicDrift — alignment', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-drift-'))
    await mkdir(join(dir, 'topics'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('aligns well when topic file matches entry content', async () => {
    const entries = [
      makeEntry({ id: 'a', summary: 'user prefers bun over npm for package management', concepts: ['bun', 'package-manager'] }),
      makeEntry({ id: 'b', summary: 'vitest not jest for testing', concepts: ['vitest', 'testing'] }),
      makeEntry({ id: 'c', summary: 'tRPC for type-safe API', concepts: ['trpc', 'api'] }),
    ]
    await writeFile(
      join(dir, 'topics', 'tooling.md'),
      '# tooling\n\nuser prefers bun over npm for package management. ' +
      'vitest is preferred for testing not jest. ' +
      'tRPC provides type-safe API communication.',
    )
    const d = await computeTopicDrift(dir, 'tooling', entries)
    // With strong term overlap, similarity should be high, drift low
    expect(d.similarity).toBeGreaterThan(0.5)
    expect(d.drift).toBeLessThan(DRIFT_WARNING_THRESHOLD)
    expect(d.level).toBe('healthy')
  })

  it('flags critical when topic file diverges completely', async () => {
    const entries = [
      makeEntry({ summary: 'user prefers bun over npm', concepts: ['bun', 'npm'] }),
      makeEntry({ summary: 'vitest preferred testing', concepts: ['vitest'] }),
    ]
    // Topic file has completely unrelated content
    await writeFile(
      join(dir, 'topics', 'tooling.md'),
      '# weather report\n\nToday is sunny with chance of rain. Temperature 25 degrees.',
    )
    const d = await computeTopicDrift(dir, 'tooling', entries)
    expect(d.drift).toBeGreaterThan(DRIFT_CRITICAL_THRESHOLD)
    expect(d.level).toBe('critical')
  })

  it('returns finite drift for partial overlap', async () => {
    const entries = [
      makeEntry({ summary: 'bun npm vitest jest', concepts: ['bun'] }),
    ]
    await writeFile(
      join(dir, 'topics', 'tooling.md'),
      'bun npm typescript react',
    )
    const d = await computeTopicDrift(dir, 'tooling', entries)
    expect(d.drift).toBeGreaterThan(0)
    expect(d.drift).toBeLessThan(1)
  })
})

// ---------------------------------------------------------------------------
// buildDriftReport — end-to-end
// ---------------------------------------------------------------------------

describe('buildDriftReport', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relvetia-drift-report-'))
    await mkdir(join(dir, 'topics'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty-ish report when memory is empty', async () => {
    const r = await buildDriftReport(dir)
    expect(r.topics).toEqual([])
    expect(r.criticalTopics).toEqual([])
    expect(r.warningTopics).toEqual([])
    expect(r.maxDrift).toBe(0)
    expect(r.recommendHierGen).toBe(false)
  })

  it('handles array-format index.json', async () => {
    const entries = [
      makeEntry({ id: '1', topic: 'a', summary: 'bun package manager', concepts: ['bun'] }),
      makeEntry({ id: '2', topic: 'a', summary: 'npm alternatives', concepts: ['npm'] }),
      makeEntry({ id: '3', topic: 'b', summary: 'vitest testing', concepts: ['vitest'] }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries))
    await writeFile(join(dir, 'topics', 'a.md'), 'bun npm package management')
    await writeFile(join(dir, 'topics', 'b.md'), 'vitest is the testing framework')

    const r = await buildDriftReport(dir)
    expect(r.topics.length).toBe(2)
    expect(r.topics.map(t => t.topic).sort()).toEqual(['a', 'b'])
  })

  it('recommends HierGen when critical drift detected', async () => {
    const entries = [
      makeEntry({ id: '1', topic: 'drifted', summary: 'database schema migration', concepts: ['database'] }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries))
    await writeFile(join(dir, 'topics', 'drifted.md'), 'completely unrelated weather data')

    const r = await buildDriftReport(dir)
    expect(r.recommendHierGen).toBe(true)
    expect(r.criticalTopics).toContain('drifted')
  })

  it('sorts by severity descending', async () => {
    const entries = [
      makeEntry({ id: '1', topic: 'healthy', summary: 'matching content here', concepts: ['matching'] }),
      makeEntry({ id: '2', topic: 'broken', summary: 'completely different text', concepts: ['different'] }),
    ]
    await writeFile(join(dir, 'index.json'), JSON.stringify(entries))
    await writeFile(join(dir, 'topics', 'healthy.md'), 'matching content here')
    await writeFile(join(dir, 'topics', 'broken.md'), 'weather report sunny')

    const r = await buildDriftReport(dir)
    expect(r.topics[0].level).toBe('critical')
    expect(r.topics[0].topic).toBe('broken')
  })
})

// ---------------------------------------------------------------------------
// formatDriftReport
// ---------------------------------------------------------------------------

describe('formatDriftReport', () => {
  it('includes summary line and non-healthy topics only', () => {
    const report = {
      topics: [
        { topic: 'broken', entryCount: 5, topicFileExists: true, similarity: 0.2, drift: 0.8, level: 'critical' as const },
        { topic: 'wobbly', entryCount: 3, topicFileExists: true, similarity: 0.55, drift: 0.45, level: 'warning' as const },
        { topic: 'fine', entryCount: 10, topicFileExists: true, similarity: 0.9, drift: 0.1, level: 'healthy' as const },
      ],
      criticalTopics: ['broken'],
      warningTopics: ['wobbly'],
      maxDrift: 0.8,
      thresholds: { warning: 0.3, critical: 0.5 },
      recommendHierGen: true,
    }
    const out = formatDriftReport(report)
    expect(out).toContain('critical=1, warning=1, healthy=1')
    expect(out).toContain('max=0.800')
    expect(out).toContain('hiergen=true')
    expect(out).toContain('CRITICAL')
    expect(out).toContain('broken')
    expect(out).toContain('wobbly')
    expect(out).not.toContain('fine') // healthy topics suppressed
  })
})
