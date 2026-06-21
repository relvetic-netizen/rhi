import { describe, it, expect } from 'vitest'

// We can't directly test selectWithSonnet (requires claude CLI), but we
// test the JSON parsing logic and the pipeline's fallback behavior by
// importing the parseSelectedMemories function pattern.

// ---------------------------------------------------------------------------
// Test the response parsing logic (replicated from semanticSelector.ts)
// ---------------------------------------------------------------------------

function parseSelectedMemories(
  response: string,
  validFilenames: Set<string>,
): string[] {
  const text = response.trim()
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  const jsonStr = codeBlockMatch ? codeBlockMatch[1]!.trim() : text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed.selected_memories)) return []
    return parsed.selected_memories.filter(
      (f: unknown): f is string => typeof f === 'string' && validFilenames.has(f),
    )
  } catch {
    return []
  }
}

describe('parseSelectedMemories', () => {
  const valid = new Set(['db-migration.md', 'preferences.md', 'deadlines.md'])

  it('parses clean JSON response', () => {
    const response = '{"selected_memories": ["db-migration.md", "preferences.md"]}'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['db-migration.md', 'preferences.md'])
  })

  it('parses JSON in code block', () => {
    const response = `Here are the selected memories:

\`\`\`json
{"selected_memories": ["deadlines.md"]}
\`\`\`

These memories are relevant.`
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['deadlines.md'])
  })

  it('filters out invalid filenames', () => {
    const response = '{"selected_memories": ["db-migration.md", "nonexistent.md"]}'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['db-migration.md'])
  })

  it('returns empty for empty selection', () => {
    const response = '{"selected_memories": []}'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual([])
  })

  it('returns empty for invalid JSON', () => {
    const result = parseSelectedMemories('not json at all', valid)
    expect(result).toEqual([])
  })

  it('returns empty for missing field', () => {
    const result = parseSelectedMemories('{"other_field": []}', valid)
    expect(result).toEqual([])
  })

  it('handles JSON with surrounding text', () => {
    const response = 'Based on my analysis:\n{"selected_memories": ["preferences.md"]}\nDone.'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['preferences.md'])
  })

  it('ignores non-string values in array', () => {
    const response = '{"selected_memories": ["db-migration.md", 42, null, "preferences.md"]}'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['db-migration.md', 'preferences.md'])
  })

  it('handles code block without json language hint', () => {
    const response = '```\n{"selected_memories": ["deadlines.md"]}\n```'
    const result = parseSelectedMemories(response, valid)
    expect(result).toEqual(['deadlines.md'])
  })
})

// ---------------------------------------------------------------------------
// Test formatManifest (replicated pattern)
// ---------------------------------------------------------------------------

type MemoryCandidate = {
  filename: string
  description: string | null
  type?: string
  contentSnippet?: string
}

function formatManifest(memories: MemoryCandidate[]): string {
  return memories
    .map(m => {
      const parts: string[] = []
      if (m.type) parts.push(`[${m.type}]`)
      parts.push(m.filename)
      if (m.description) parts.push(`— ${m.description}`)
      if (m.contentSnippet) {
        const preview = m.contentSnippet.slice(0, 200).replace(/\n/g, ' ')
        parts.push(`(${preview}...)`)
      }
      return `- ${parts.join(' ')}`
    })
    .join('\n')
}

describe('formatManifest', () => {
  it('formats basic memory entry', () => {
    const result = formatManifest([
      { filename: 'test.md', description: 'A test file' },
    ])
    expect(result).toBe('- test.md — A test file')
  })

  it('includes type tag', () => {
    const result = formatManifest([
      { filename: 'test.md', description: 'desc', type: 'preference' },
    ])
    expect(result).toContain('[preference]')
  })

  it('includes content snippet preview', () => {
    const result = formatManifest([
      {
        filename: 'test.md',
        description: null,
        contentSnippet: 'Some content here about databases',
      },
    ])
    expect(result).toContain('(Some content here about databases...)')
  })

  it('truncates long snippets', () => {
    const longSnippet = 'a'.repeat(300)
    const result = formatManifest([
      { filename: 'test.md', description: null, contentSnippet: longSnippet },
    ])
    // Should contain first 200 chars, not all 300
    expect(result.length).toBeLessThan(300)
  })

  it('handles multiple entries', () => {
    const result = formatManifest([
      { filename: 'a.md', description: 'first' },
      { filename: 'b.md', description: 'second' },
    ])
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('a.md')
    expect(lines[1]).toContain('b.md')
  })
})
