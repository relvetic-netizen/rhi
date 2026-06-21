import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  decideMode,
  selectDistillMode,
  daysBetween,
} from '../src/distill-mode.js'

describe('daysBetween', () => {
  it('returns 0 for same date', () => {
    const d = new Date('2026-04-22')
    expect(daysBetween(d, d)).toBe(0)
  })

  it('returns 7 for 1 week apart', () => {
    const a = new Date('2026-04-22')
    const b = new Date('2026-04-29')
    expect(daysBetween(a, b)).toBe(7)
  })

  it('is order-independent (absolute value)', () => {
    const a = new Date('2026-04-22')
    const b = new Date('2026-04-29')
    expect(daysBetween(a, b)).toBe(daysBetween(b, a))
  })
})

describe('decideMode', () => {
  const healthyCache = {
    timestamp: '2026-04-22T03:30:00Z',
    recommendHierGen: false,
    maxDrift: 0.2,
    criticalTopics: [],
  }

  it('returns hier on cold start (no cache)', () => {
    const d = decideMode({ cache: null, lastHier: null, now: new Date('2026-04-22T03:00:00Z') })
    expect(d.mode).toBe('hier')
    expect(d.reason).toContain('cold start')
    expect(d.cacheFound).toBe(false)
  })

  it('returns hier when drift recommends HierGen', () => {
    const d = decideMode({
      cache: { ...healthyCache, recommendHierGen: true, criticalTopics: ['troubleshooting'] },
      lastHier: new Date('2026-04-21T03:00:00Z'),
      now: new Date('2026-04-22T03:00:00Z'),
    })
    expect(d.mode).toBe('hier')
    expect(d.reason).toContain('HierGen')
    expect(d.recommendHierGen).toBe(true)
  })

  it('returns hier when ≥7 days since last hier', () => {
    const d = decideMode({
      cache: healthyCache,
      lastHier: new Date('2026-04-15T03:00:00Z'),
      now: new Date('2026-04-22T04:00:00Z'), // > 7 days
    })
    expect(d.mode).toBe('hier')
    expect(d.reason).toContain('days since last hier')
  })

  it('returns hier on Sunday even if drift healthy and recent hier', () => {
    // 2026-04-26 is a Sunday
    const d = decideMode({
      cache: healthyCache,
      lastHier: new Date('2026-04-20T03:00:00Z'), // Monday
      now: new Date('2026-04-26T03:00:00Z'), // Sunday
    })
    expect(d.mode).toBe('hier')
    expect(d.reason).toContain('Sunday')
  })

  it('returns rec when drift healthy, recent hier, non-Sunday', () => {
    // 2026-04-22 is a Wednesday
    const d = decideMode({
      cache: healthyCache,
      lastHier: new Date('2026-04-21T03:00:00Z'),
      now: new Date('2026-04-22T03:00:00Z'),
    })
    expect(d.mode).toBe('rec')
    expect(d.reason).toContain('RecGen')
    expect(d.cacheFound).toBe(true)
  })

  it('does not double-run hier on Sunday if already run today', () => {
    // Both same Sunday
    const d = decideMode({
      cache: healthyCache,
      lastHier: new Date('2026-04-26T03:00:00Z'),
      now: new Date('2026-04-26T10:00:00Z'),
    })
    expect(d.mode).toBe('rec') // already ran today, fall through
  })
})

describe('selectDistillMode', () => {
  let memDir: string

  beforeEach(async () => {
    memDir = await mkdtemp(join(tmpdir(), 'distill-mode-'))
  })

  afterEach(async () => {
    await rm(memDir, { recursive: true, force: true })
  })

  it('returns cold-start hier when cache missing', async () => {
    const d = await selectDistillMode(memDir)
    expect(d.mode).toBe('hier')
    expect(d.cacheFound).toBe(false)
  })

  it('reads topology cache and selects rec when healthy', async () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    // Skip Sunday to avoid the weekly-refresh rule
    if (now.getDay() === 0) return

    await writeFile(join(memDir, '.last-topology.json'), JSON.stringify({
      timestamp: now.toISOString(),
      recommendHierGen: false,
      maxDrift: 0.2,
      criticalTopics: [],
      warningTopics: [],
      topologyCounts: { hard: 0, soft: 0, under: 10 },
      totalEntries: 100,
      topicsToSplit: [],
    }))
    await writeFile(join(memDir, '.last-hiergen.json'), JSON.stringify({
      timestamp: yesterday.toISOString(),
    }))

    const d = await selectDistillMode(memDir)
    expect(d.mode).toBe('rec')
    expect(d.cacheFound).toBe(true)
  })

  it('selects hier when cached drift is critical', async () => {
    await writeFile(join(memDir, '.last-topology.json'), JSON.stringify({
      timestamp: new Date().toISOString(),
      recommendHierGen: true,
      maxDrift: 0.6,
      criticalTopics: ['troubleshooting'],
    }))
    const d = await selectDistillMode(memDir)
    expect(d.mode).toBe('hier')
    expect(d.recommendHierGen).toBe(true)
  })

  it('tolerates malformed cache gracefully (cold start)', async () => {
    await writeFile(join(memDir, '.last-topology.json'), 'not json')
    const d = await selectDistillMode(memDir)
    expect(d.mode).toBe('hier')
    expect(d.cacheFound).toBe(false)
  })
})
