// Helper unit test — topicPathForEntry / topicPath / topicFilePath.
//
// Phase 3 T1 (memory-hardening sprint). Asserts the single-source-of-truth
// behavior of the `topics/<topic>.md` path convention after extraction from
// 8 inline callsites.

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import {
  topicPath,
  topicPathForEntry,
  topicFilePath,
} from '../../extracted/memory/topicPathForEntry.js'

describe('topicPath', () => {
  it('flat topic → topics/<topic>.md', () => {
    expect(topicPath('architecture')).toBe('topics/architecture.md')
  })

  it('hierarchical topic round-trips unchanged (slash preserved)', () => {
    expect(topicPath('architecture/daemon-silent-fail')).toBe(
      'topics/architecture/daemon-silent-fail.md',
    )
  })

  it('private prefix preserved (privacy gate input)', () => {
    expect(topicPath('private/diary')).toBe('topics/private/diary.md')
  })

  it('empty topic still gets `.md` suffix (degenerate but explicit)', () => {
    expect(topicPath('')).toBe('topics/.md')
  })
})

describe('topicPathForEntry', () => {
  it('sugars over topicPath on a ResidualEntry-shaped input', () => {
    expect(topicPathForEntry({ topic: 'tooling' })).toBe('topics/tooling.md')
  })

  it('accepts hierarchical entry topic', () => {
    expect(topicPathForEntry({ topic: 'project-context/cost-reduction' })).toBe(
      'topics/project-context/cost-reduction.md',
    )
  })

  it('agrees with topicPath on the same topic string', () => {
    const entry = { topic: 'self' }
    expect(topicPathForEntry(entry)).toBe(topicPath(entry.topic))
  })
})

describe('topicFilePath', () => {
  it('joins memoryDir + topics/<topic>.md', () => {
    const dir = join('/tmp', 'memdir')
    expect(topicFilePath(dir, 'tooling')).toBe(join(dir, 'topics', 'tooling.md'))
  })

  it('handles hierarchical topic under memoryDir', () => {
    const dir = join('/tmp', 'memdir')
    expect(topicFilePath(dir, 'architecture/hooks')).toBe(
      join(dir, 'topics', 'architecture', 'hooks.md'),
    )
  })

  it('parallels the inlined join expression it replaced', () => {
    // Equivalent to the pre-T1 expression in topicChunking.ts:102 / driftMonitor.ts:104:
    //   const path = join(memoryDir, 'topics', `${topic}.md`)
    const dir = '/var/memorydir'
    const topic = 'private'
    expect(topicFilePath(dir, topic)).toBe(join(dir, 'topics', `${topic}.md`))
  })
})
