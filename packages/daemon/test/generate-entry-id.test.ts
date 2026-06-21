// Phase 3 T4 — slug-safe entry ID for hierarchical topics.
//
// Pre-T4 behavior reduced any topic to a 4-char prefix, which means
// `architecture` and `architecture/daemon-silent-fail` would both prefix
// `arch` and share a counter — a collision risk once hierarchical topics
// enter production via wiki migration. Post-T4 hierarchical topics use a
// 16-char slug-safe full path so each branch has its own counter.

import { describe, expect, it } from 'vitest'
import {
  generateEntryId,
  type ResidualEntry,
  type ResidualIndex,
} from '../../extracted/memory/residualIndex.js'

function emptyIndex(): ResidualIndex {
  return { version: 1, entries: {} }
}

function entry(id: string, topic: string): ResidualEntry {
  return {
    id,
    topic,
    summary: 'fixture',
    sources: [],
    concepts: [],
    updated: '2026-05-18',
    confidence: 1,
  }
}

describe('generateEntryId', () => {
  describe('flat topic (legacy behavior preserved)', () => {
    it('returns 4-char prefix + counter for short flat topic', () => {
      expect(generateEntryId('preferences', emptyIndex())).toBe('pref_001')
    })

    it('returns 4-char prefix + counter for very short flat topic', () => {
      expect(generateEntryId('arch', emptyIndex())).toBe('arch_001')
    })

    it('strips non-alpha from the 4-char window', () => {
      expect(generateEntryId('1abc', emptyIndex())).toBe('abc_001')
    })

    it('increments counter against existing prefix matches', () => {
      const idx: ResidualIndex = {
        version: 1,
        entries: {
          pref_001: entry('pref_001', 'preferences'),
          pref_002: entry('pref_002', 'preferences'),
        },
      }
      expect(generateEntryId('preferences', idx)).toBe('pref_003')
    })
  })

  describe('hierarchical topic (Phase 3 T4 slug-safe path)', () => {
    it('uses slash-aware slug for hierarchical topic', () => {
      expect(generateEntryId('architecture/daemon-silent-fail', emptyIndex())).toBe('architecture_dae_001')
    })

    it('truncates slug to 16 chars', () => {
      const id = generateEntryId('architecture/daemon-silent-fail-long-tail', emptyIndex())
      expect(id.split('_').slice(0, -1).join('_').length).toBeLessThanOrEqual(16)
      expect(id).toMatch(/^[a-z0-9_]+_\d{3}$/)
    })

    it('does NOT collide with flat parent prefix counter', () => {
      // Flat `architecture` produces `arch_NNN`. Hierarchical
      // `architecture/daemon-silent-fail` must produce a different prefix so
      // its counter is independent.
      const idx: ResidualIndex = {
        version: 1,
        entries: {
          arch_001: entry('arch_001', 'architecture'),
          arch_002: entry('arch_002', 'architecture'),
        },
      }
      const hierId = generateEntryId('architecture/daemon-silent-fail', idx)
      expect(hierId).not.toMatch(/^arch_/)
      expect(hierId).toBe('architecture_dae_001')
    })

    it('treats different hierarchical branches as separate counters', () => {
      const idx: ResidualIndex = {
        version: 1,
        entries: {
          architecture_dae_001: entry('architecture_dae_001', 'architecture/daemon-silent-fail'),
        },
      }
      // Same branch → counter advances
      expect(generateEntryId('architecture/daemon-silent-fail', idx)).toBe('architecture_dae_002')
      // Different branch → fresh counter
      expect(generateEntryId('tooling/notes', idx)).toBe('tooling_notes_001')
    })

    it('falls back to `entry` prefix if topic slug is empty', () => {
      // Degenerate input: only slashes and punctuation.
      expect(generateEntryId('///', emptyIndex())).toMatch(/^entry_001$/)
    })
  })
})
