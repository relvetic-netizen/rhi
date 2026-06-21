import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  normalizeIndexEntries,
  countEntriesByTopic,
  classifyTopic,
  buildTopologyReport,
  getTopicsRequiringPromotion,
  getTopicsApproachingLimit,
  formatTopologyReport,
} from '../../extracted/memory/topicChunking.js'

// ---------------------------------------------------------------------------
// normalizeIndexEntries — handles schema drift (array vs object format)
// ---------------------------------------------------------------------------

describe('normalizeIndexEntries', () => {
  it('returns array format as-is', () => {
    const arr = [
      { id: 'a_1', topic: 'tool', summary: 's', sources: [], concepts: [], updated: '2026-01-01', confidence: 1 },
    ]
    expect(normalizeIndexEntries(arr)).toEqual(arr)
  })

  it('extracts entries from object format', () => {
    const obj = {
      version: 1,
      entries: {
        a_1: { id: 'a_1', topic: 'tool', summary: 's', sources: [], concepts: [], updated: '2026-01-01', confidence: 1 },
        b_2: { id: 'b_2', topic: 'pref', summary: 's', sources: [], concepts: [], updated: '2026-01-01', confidence: 1 },
      },
    }
    const result = normalizeIndexEntries(obj)
    expect(result.length).toBe(2)
    expect(result.map(e => e.id).sort()).toEqual(['a_1', 'b_2'])
  })

  it('returns empty array for unrecognized shapes', () => {
    expect(normalizeIndexEntries(null)).toEqual([])
    expect(normalizeIndexEntries(undefined)).toEqual([])
    expect(normalizeIndexEntries({})).toEqual([])
    expect(normalizeIndexEntries('string')).toEqual([])
    expect(normalizeIndexEntries(42)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// countEntriesByTopic
// ---------------------------------------------------------------------------

describe('countEntriesByTopic', () => {
  it('groups entries by topic', () => {
    const entries = [
      { id: '1', topic: 'a', summary: '', sources: [], concepts: [], updated: '', confidence: 1 },
      { id: '2', topic: 'a', summary: '', sources: [], concepts: [], updated: '', confidence: 1 },
      { id: '3', topic: 'b', summary: '', sources: [], concepts: [], updated: '', confidence: 1 },
    ]
    const counts = countEntriesByTopic(entries)
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
    expect(counts.size).toBe(2)
  })

  it('returns empty map for empty input', () => {
    expect(countEntriesByTopic([]).size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// classifyTopic — worst-case-wins across entry and line dimensions
// ---------------------------------------------------------------------------

describe('classifyTopic', () => {
  const limits = { softEntries: 20, hardEntries: 35, softLines: 500, hardLines: 800 }

  it('returns "under" when both dimensions are below soft', () => {
    const r = classifyTopic(10, 100, limits)
    expect(r.status).toBe('under')
    expect(r.triggeredBy).toBe('none')
  })

  it('flags soft when entries exceed soft limit only', () => {
    const r = classifyTopic(25, 100, limits)
    expect(r.status).toBe('soft')
    expect(r.triggeredBy).toBe('entries')
  })

  it('flags soft when lines exceed soft limit only', () => {
    const r = classifyTopic(10, 600, limits)
    expect(r.status).toBe('soft')
    expect(r.triggeredBy).toBe('lines')
  })

  it('flags hard when entries exceed hard limit', () => {
    const r = classifyTopic(40, 100, limits)
    expect(r.status).toBe('hard')
    expect(r.triggeredBy).toBe('entries')
  })

  it('flags hard when lines exceed hard limit', () => {
    const r = classifyTopic(10, 900, limits)
    expect(r.status).toBe('hard')
    expect(r.triggeredBy).toBe('lines')
  })

  it('worst-case wins when both dimensions trigger at different levels', () => {
    // entries=40 (hard), lines=600 (soft) → hard wins, triggeredBy=entries
    const r = classifyTopic(40, 600, limits)
    expect(r.status).toBe('hard')
    expect(r.triggeredBy).toBe('entries')
  })

  it('boundary: exact soft limit is already soft', () => {
    const r = classifyTopic(20, 0, limits)
    expect(r.status).toBe('soft')
  })

  it('boundary: exact hard limit is already hard', () => {
    const r = classifyTopic(35, 0, limits)
    expect(r.status).toBe('hard')
  })
})

// ---------------------------------------------------------------------------
// buildTopologyReport — integration test with a mock memory dir
// ---------------------------------------------------------------------------

describe('buildTopologyReport', () => {
  let memoryDir: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(join(tmpdir(), 'relvetia-topology-'))
    await mkdir(join(memoryDir, 'topics'), { recursive: true })
  })

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })

  it('returns empty report when no index exists', async () => {
    const report = await buildTopologyReport(memoryDir)
    expect(report.totalEntries).toBe(0)
    expect(report.topics).toEqual([])
    expect(report.counts).toEqual({ under: 0, soft: 0, hard: 0 })
  })

  it('handles array-format index.json (production format)', async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `t_${i}`,
      topic: 'troubleshooting',
      summary: `entry ${i}`,
      sources: [],
      concepts: [],
      updated: '2026-04-21',
      confidence: 1,
    }))
    await writeFile(join(memoryDir, 'index.json'), JSON.stringify(entries))

    const report = await buildTopologyReport(memoryDir)
    expect(report.totalEntries).toBe(25)
    expect(report.topics.length).toBe(1)
    expect(report.topics[0].topic).toBe('troubleshooting')
    expect(report.topics[0].entryCount).toBe(25)
    expect(report.topics[0].status).toBe('soft')
  })

  it('handles object-format index.json (schema format)', async () => {
    const obj = {
      version: 1,
      entries: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `t_${i}`,
          {
            id: `t_${i}`,
            topic: 'tooling',
            summary: `entry ${i}`,
            sources: [],
            concepts: [],
            updated: '2026-04-21',
            confidence: 1,
          },
        ]),
      ),
    }
    await writeFile(join(memoryDir, 'index.json'), JSON.stringify(obj))

    const report = await buildTopologyReport(memoryDir)
    expect(report.totalEntries).toBe(10)
    expect(report.topics[0].status).toBe('under')
  })

  it('integrates line count from topic file', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      id: `t_${i}`,
      topic: 'tooling',
      summary: `entry ${i}`,
      sources: [],
      concepts: [],
      updated: '2026-04-21',
      confidence: 1,
    }))
    await writeFile(join(memoryDir, 'index.json'), JSON.stringify(entries))
    // Write a topic file with 600 lines (soft limit = 500)
    const bigContent = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n')
    await writeFile(join(memoryDir, 'topics', 'tooling.md'), bigContent)

    const report = await buildTopologyReport(memoryDir)
    expect(report.topics[0].lineCount).toBe(600)
    expect(report.topics[0].status).toBe('soft')
    expect(report.topics[0].triggeredBy).toBe('lines')
  })

  it('sorts topics by severity descending', async () => {
    const entries = [
      ...Array(40).fill(0).map((_, i) => ({ id: `a_${i}`, topic: 'hard_topic', summary: '', sources: [], concepts: [], updated: '', confidence: 1 })),
      ...Array(25).fill(0).map((_, i) => ({ id: `b_${i}`, topic: 'soft_topic', summary: '', sources: [], concepts: [], updated: '', confidence: 1 })),
      ...Array(5).fill(0).map((_, i) => ({ id: `c_${i}`, topic: 'ok_topic', summary: '', sources: [], concepts: [], updated: '', confidence: 1 })),
    ]
    await writeFile(join(memoryDir, 'index.json'), JSON.stringify(entries))

    const report = await buildTopologyReport(memoryDir)
    expect(report.topics.map(t => t.topic)).toEqual(['hard_topic', 'soft_topic', 'ok_topic'])
    expect(report.counts).toEqual({ hard: 1, soft: 1, under: 1 })
  })
})

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('getTopicsRequiringPromotion / getTopicsApproachingLimit', () => {
  it('separates hard from soft correctly', () => {
    const report = {
      topics: [
        { topic: 'a', entryCount: 40, lineCount: 100, status: 'hard' as const, triggeredBy: 'entries' as const, message: '' },
        { topic: 'b', entryCount: 25, lineCount: 100, status: 'soft' as const, triggeredBy: 'entries' as const, message: '' },
        { topic: 'c', entryCount: 5, lineCount: 100, status: 'under' as const, triggeredBy: 'none' as const, message: '' },
      ],
      counts: { hard: 1, soft: 1, under: 1 },
      totalEntries: 70,
      limits: { softEntries: 20, hardEntries: 35, softLines: 500, hardLines: 800 },
    }
    expect(getTopicsRequiringPromotion(report).map(t => t.topic)).toEqual(['a'])
    expect(getTopicsApproachingLimit(report).map(t => t.topic)).toEqual(['b'])
  })
})

// ---------------------------------------------------------------------------
// formatTopologyReport
// ---------------------------------------------------------------------------

describe('formatTopologyReport', () => {
  it('includes summary header and problem topics only', () => {
    const report = {
      topics: [
        { topic: 'hard_one', entryCount: 40, lineCount: 100, status: 'hard' as const, triggeredBy: 'entries' as const, message: '[HARD LIMIT] hard_one: 40 entries' },
        { topic: 'soft_one', entryCount: 25, lineCount: 100, status: 'soft' as const, triggeredBy: 'entries' as const, message: '[soft limit] soft_one: 25 entries' },
        { topic: 'ok_one', entryCount: 5, lineCount: 100, status: 'under' as const, triggeredBy: 'none' as const, message: '[ok] ok_one: 5e/100L' },
      ],
      counts: { hard: 1, soft: 1, under: 1 },
      totalEntries: 70,
      limits: { softEntries: 20, hardEntries: 35, softLines: 500, hardLines: 800 },
    }
    const out = formatTopologyReport(report)
    expect(out).toContain('hard=1, soft=1, under=1')
    expect(out).toContain('HARD LIMIT')
    expect(out).toContain('soft limit')
    // "under" topics are hidden in formatted output
    expect(out).not.toContain('ok_one')
  })
})
