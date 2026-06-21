// Phase 0 regression fixture 4 (Plan v3 § Phase 0 T0-6)
//
// Asserts post-fix behavior: executeMemorySearch output exposes a `hits` array
// where each entry carries entryId / sources / confidence / updated. This is
// the entry-centric schema introduced by Phase 3 T2 (dual-output).
//
// Pre-fix expectation: this fails because MemorySearchTool.ts:71-73 declares
// MemorySearchOutput = { results: { path, snippet, score }[] } only — there
// is no `hits` field, so result.hits?.[0] is undefined and the schema match
// fails.

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeMemorySearch } from '../../../extracted/tools/MemorySearchTool.js'

let tempDirs: string[] = []

async function setupTempMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-hitschema-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
  tempDirs = []
})

describe('regression: MemorySearchOutput.hits schema', () => {
  it('returns entry-centric hits with entryId / sources / confidence / updated', async () => {
    // Provide a residual index entry so the entry-layer scoring path has a hit
    // candidate. Without the index, the entry layer is empty and there is no
    // entryId to surface — making the schema assertion ambiguous (pre-fix vs
    // post-fix would both legitimately have nothing to put in hits).
    const indexJson = JSON.stringify({
      version: 1,
      entries: {
        pref_001: {
          id: 'pref_001',
          summary: 'unique target hits schema test entry for fixture4',
          sources: ['logs/2026/05/2026-05-18.md:L1'],
          concepts: ['fixture4', 'schemasentinel'],
          topic: 'preferences',
          updated: '2026-05-18',
          confidence: 1.0,
        },
      },
    })

    const memoryDir = await setupTempMemoryDir({
      'index.json': indexJson,
      'topics/preferences.md':
        '# Preferences\n\n- fixture4 schemasentinel unique target hits schema test entry\n',
      'logs/2026/05/2026-05-18.md':
        '# Daily log\n\n- [00:00] fixture4 schemasentinel context\n',
    })

    const result = await executeMemorySearch(memoryDir, {
      query: 'fixture4 schemasentinel',
    })

    // POST-FIX expectation: dual-output schema surfaces entry-centric hits.
    //
    // PRE-FIX: this fails — output is { results: [...] } only, so
    // (result as any).hits is undefined and the schema match has no candidate.
    const hits = (result as any).hits as
      | Array<Record<string, unknown>>
      | undefined
    expect(hits).toBeDefined()
    expect(hits!.length).toBeGreaterThan(0)
    expect(hits![0]).toMatchObject({
      entryId: expect.any(String),
      sources: expect.any(Array),
      confidence: expect.any(Number),
      updated: expect.any(String),
    })
  })
})
