import { describe, expect, it } from 'vitest'
import {
  assertNoScoreFields,
  parseIndexJson,
  transformEntries,
} from './migrate-score-to-confidence.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

describe('migrate-score-to-confidence transformEntries', () => {
  it('migrates object form with numeric keys', () => {
    const fixture = {
      0: { id: 'a', score: 0.5, summary: 'a' },
      1: { id: 'b', score: 0.9, summary: 'b' },
    }

    const result = transformEntries(clone(fixture))

    expect(result.migrated).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.data).toEqual({
      0: { id: 'a', confidence: 0.5, summary: 'a' },
      1: { id: 'b', confidence: 0.9, summary: 'b' },
    })
    assertNoScoreFields(result.data)
  })

  it('handles array form with migrated, skipped, and conflict entries', () => {
    const warnings = []
    const fixture = [
      { id: 'legacy', score: 0.5 },
      { id: 'current', confidence: 0.7 },
      { id: 'both', score: 0.3, confidence: 0.4 },
    ]

    const result = transformEntries(clone(fixture), message => warnings.push(message))

    expect(result.migrated).toBe(1)
    expect(result.skipped).toBe(2)
    expect(result.data).toEqual([
      { id: 'legacy', confidence: 0.5 },
      { id: 'current', confidence: 0.7 },
      { id: 'both', confidence: 0.4 },
    ])
    expect(warnings).toEqual(['Entry 2: both score and confidence found; keeping confidence'])
    assertNoScoreFields(result.data)
  })

  it('treats an empty file as a safe no-op', () => {
    const data = parseIndexJson('')
    const result = transformEntries(data)

    expect(result.total).toBe(0)
    expect(result.migrated).toBe(0)
    expect(result.skipped).toBe(0)
    expect(result.data).toEqual({})
    assertNoScoreFields(result.data)
  })

  it('handles canonical wrapper with entries array', () => {
    const fixture = {
      version: 1,
      entries: [
        { id: 'legacy', score: 0.6 },
        { id: 'current', confidence: 0.8 },
      ],
    }

    const result = transformEntries(clone(fixture))

    expect(result.migrated).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.data).toEqual({
      version: 1,
      entries: [
        { id: 'legacy', confidence: 0.6 },
        { id: 'current', confidence: 0.8 },
      ],
    })
    assertNoScoreFields(result.data)
  })
})
