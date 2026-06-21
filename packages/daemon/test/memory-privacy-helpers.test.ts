import { describe, it, expect, afterEach } from 'vitest'
import {
  isPrivatePath,
  isPrivateEntry,
  shouldIncludePrivate,
} from '../../extracted/memory/memoryPrivacy.js'
import type { ResidualEntry } from '../../extracted/memory/residualIndex.js'

function entry(partial: Partial<ResidualEntry>): ResidualEntry {
  return {
    id: 'e1',
    summary: '',
    sources: [],
    concepts: [],
    topic: 'misc',
    updated: '2026-05-18',
    confidence: 1,
    ...partial,
  }
}

const ORIGINAL_ENV = process.env.RELVETIA_INCLUDE_PRIVATE

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
  } else {
    process.env.RELVETIA_INCLUDE_PRIVATE = ORIGINAL_ENV
  }
})

describe('isPrivatePath', () => {
  it('detects the private/ POSIX prefix', () => {
    expect(isPrivatePath('private/notes.md')).toBe(true)
    expect(isPrivatePath('private/logs/2026/05/diary.md')).toBe(true)
  })

  it('detects the private\\ Windows prefix', () => {
    expect(isPrivatePath('private\\notes.md')).toBe(true)
  })

  it('returns false for non-private paths', () => {
    expect(isPrivatePath('topics/architecture.md')).toBe(false)
    expect(isPrivatePath('logs/2026/05/2026-05-18.md')).toBe(false)
    expect(isPrivatePath('private-friendly/notes.md')).toBe(false)
  })
})

describe('isPrivateEntry', () => {
  it('treats a private topic as private', () => {
    expect(isPrivateEntry(entry({ topic: 'private/diary' }))).toBe(true)
  })

  it('treats a private source as private even when topic is public', () => {
    expect(
      isPrivateEntry(
        entry({
          topic: 'shared',
          sources: ['private/logs/2026/05/2026-05-18.md:L42'],
        }),
      ),
    ).toBe(true)
  })

  it('strips :L<n> line suffixes before path matching', () => {
    expect(
      isPrivateEntry(
        entry({ topic: 'shared', sources: ['private/diary.md:L1'] }),
      ),
    ).toBe(true)
  })

  it('returns false when no source or topic is private', () => {
    expect(
      isPrivateEntry(
        entry({
          topic: 'architecture',
          sources: ['logs/2026/05/2026-05-18.md:L10'],
        }),
      ),
    ).toBe(false)
  })
})

describe('shouldIncludePrivate', () => {
  it('returns false by default', () => {
    delete process.env.RELVETIA_INCLUDE_PRIVATE
    expect(shouldIncludePrivate()).toBe(false)
  })

  it('returns true only for the exact "1" opt-in', () => {
    expect(shouldIncludePrivate({ RELVETIA_INCLUDE_PRIVATE: '1' })).toBe(true)
    expect(shouldIncludePrivate({ RELVETIA_INCLUDE_PRIVATE: 'true' })).toBe(false)
    expect(shouldIncludePrivate({ RELVETIA_INCLUDE_PRIVATE: '' })).toBe(false)
    expect(shouldIncludePrivate({})).toBe(false)
  })

  it('falls back to process.env when no override is given', () => {
    process.env.RELVETIA_INCLUDE_PRIVATE = '1'
    expect(shouldIncludePrivate()).toBe(true)
    delete process.env.RELVETIA_INCLUDE_PRIVATE
    expect(shouldIncludePrivate()).toBe(false)
  })
})
