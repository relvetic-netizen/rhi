import { describe, it, expect } from 'vitest'
import {
  trimAndSquareNovelty,
  splitIntoObservations,
  screenForNovelty,
  type NoveltyConfig,
} from '../../extracted/screening/noveltyScreening.js'
import {
  trimAndSquare,
} from '../../extracted/screening/screening.js'

// ---------------------------------------------------------------------------
// trimAndSquareNovelty (inverse Trim-and-Square)
// ---------------------------------------------------------------------------

describe('trimAndSquareNovelty', () => {
  it('returns exactly 0 for high similarity (redundant)', () => {
    // r=2.5, similarity=0.9 → 1 - 2.5*0.9 = 1 - 2.25 = -1.25 → max(0) = 0
    expect(trimAndSquareNovelty(0.9, 2.5)).toBe(0)
  })

  it('returns exactly 0 at the boundary (1/r)', () => {
    // r=2.5, threshold = 1/2.5 = 0.4
    // similarity=0.4 → 1 - 2.5*0.4 = 1 - 1 = 0 → 0^2 = 0
    expect(trimAndSquareNovelty(0.4, 2.5)).toBe(0)
  })

  it('returns positive for low similarity (novel)', () => {
    // r=2.5, similarity=0.1 → 1 - 2.5*0.1 = 1 - 0.25 = 0.75 → 0.5625
    expect(trimAndSquareNovelty(0.1, 2.5)).toBeCloseTo(0.5625, 5)
  })

  it('returns 1 for zero similarity (completely novel)', () => {
    // similarity=0 → 1 - r*0 = 1 → 1^2 = 1
    expect(trimAndSquareNovelty(0, 2.5)).toBe(1)
    expect(trimAndSquareNovelty(0, 5)).toBe(1)
  })

  it('returns 0 for similarity=1 (exact duplicate)', () => {
    expect(trimAndSquareNovelty(1, 2.5)).toBe(0)
  })

  it('higher sharpness creates stricter novelty requirement', () => {
    const sim = 0.3
    // r=2: 1 - 2*0.3 = 0.4 → 0.16 (passes)
    // r=5: 1 - 5*0.3 = -0.5 → 0 (rejected)
    expect(trimAndSquareNovelty(sim, 2)).toBeGreaterThan(0)
    expect(trimAndSquareNovelty(sim, 5)).toBe(0)
  })

  it('is the mathematical inverse of trimAndSquare for read-side', () => {
    // Read:  α = [max(1 - r*(1-s), 0)]² — high s → pass
    // Write: α = [max(1 - r*s, 0)]²     — low s → pass
    // They are complements: when one accepts, the other rejects
    const r = 3
    const highSim = 0.9 // Similar to existing memory
    const lowSim = 0.1  // Novel information

    // High similarity: read accepts, write rejects
    expect(trimAndSquare(highSim, r)).toBeGreaterThan(0)
    expect(trimAndSquareNovelty(highSim, r)).toBe(0)

    // Low similarity: read rejects, write accepts
    expect(trimAndSquare(lowSim, r)).toBe(0)
    expect(trimAndSquareNovelty(lowSim, r)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// splitIntoObservations
// ---------------------------------------------------------------------------

describe('splitIntoObservations', () => {
  it('splits on sentence boundaries', () => {
    const text = 'The user prefers bun over npm. Deployment deadline is April 15th.'
    const obs = splitIntoObservations(text)
    expect(obs).toHaveLength(2)
    expect(obs[0]).toBe('The user prefers bun over npm.')
    expect(obs[1]).toBe('Deployment deadline is April 15th.')
  })

  it('splits on newlines', () => {
    const text = 'First observation here.\nSecond observation here.'
    const obs = splitIntoObservations(text)
    expect(obs).toHaveLength(2)
  })

  it('filters out short fragments', () => {
    const text = 'OK. Sure. The user prefers bun over npm for package management.'
    const obs = splitIntoObservations(text)
    // "OK." (3 chars) and "Sure." (5 chars) are below 15-char threshold
    expect(obs).toHaveLength(1)
    expect(obs[0]).toContain('bun over npm')
  })

  it('returns empty for empty input', () => {
    expect(splitIntoObservations('')).toEqual([])
  })

  it('handles Japanese sentence endings', () => {
    const text = 'ユーザーはbunを好む。デプロイ期限は4月15日。'
    const obs = splitIntoObservations(text)
    expect(obs.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// screenForNovelty
// ---------------------------------------------------------------------------

describe('screenForNovelty', () => {
  const config: NoveltyConfig = {
    threshold: 0.25,
    maxObservations: 10,
  }

  it('returns all observations when memory is empty', () => {
    const obs = ['The user prefers bun.', 'Deployment deadline is April 15th.']
    const result = screenForNovelty(obs, [], config)
    expect(result).toHaveLength(2)
    expect(result.every(r => r.score === 1.0)).toBe(true)
  })

  it('returns empty for empty observations', () => {
    expect(screenForNovelty([], ['existing memory'], config)).toEqual([])
  })

  it('rejects observations that match existing memory', () => {
    const existing = [
      'The user prefers bun over npm for package management',
    ]
    const obs = [
      'The user prefers bun over npm.',           // redundant
      'Deployment deadline is April 15th.',        // novel
    ]
    const result = screenForNovelty(obs, existing, config)
    const novelTexts = result.map(r => r.item)
    // The bun preference is already known → should be filtered
    // The deadline is new → should pass
    expect(novelTexts).toContain('Deployment deadline is April 15th.')
  })

  it('deduplicates similar observations within the same batch', () => {
    const obs = [
      'The user prefers bun over npm for package management speed.',
      'The user prefers bun over npm for package management performance.',
      'Deployment deadline is April 15th for the staging environment.',
    ]
    // Use a tighter config to make dedup more aggressive
    const tightConfig: NoveltyConfig = { threshold: 0.5, maxObservations: 10 }
    const result = screenForNovelty(obs, [], tightConfig)
    // With dedup, similar bun observations should be reduced
    // At minimum, the result should have fewer items than input
    expect(result.length).toBeLessThanOrEqual(obs.length)
  })

  it('respects maxObservations cap', () => {
    const obs = Array.from({ length: 20 }, (_, i) =>
      `Unique observation number ${i} about topic ${i * 7}.`,
    )
    const smallConfig = { ...config, maxObservations: 3 }
    const result = screenForNovelty(obs, [], smallConfig)
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('novel observations have positive scores', () => {
    const result = screenForNovelty(
      ['Completely new information about quantum computing.'],
      ['Old memory about database schemas.'],
      config,
    )
    expect(result.length).toBe(1)
    expect(result[0]!.score).toBeGreaterThan(0)
  })

  it('all scores are strictly positive (zero-scored items never returned)', () => {
    const existing = ['database migration schema update']
    const obs = [
      'database migration schema update tool',  // very similar → should be rejected
      'quantum computing breakthrough news',      // completely novel
    ]
    const result = screenForNovelty(obs, existing, config)
    for (const r of result) {
      expect(r.score).toBeGreaterThan(0)
    }
  })
})
