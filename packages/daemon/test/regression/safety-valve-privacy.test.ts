// Phase 0 regression fixture 3 (Plan v3 § Phase 0 T0-5)
//
// Asserts post-fix behavior: when findRelevantMemories returns zero hits and
// the safety valve fires, the fallback must NOT leak private/ private files.
//
// Pre-fix expectation: this fails because findRelevantMemories.ts:221-223
// returns `allMemories.slice(0, 5)` and scanMemoryFiles (same file, L73-121)
// has no private filter. Any recent private/*.md slips into the result.
//
// Phase 2 (privacy unify) flips this green by routing every entry point
// through memoryPrivacy.ts which honors RELVETIA_INCLUDE_PRIVATE gating.

import { mkdtemp, mkdir, writeFile, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRelevantMemories } from '../../../extracted/screening/findRelevantMemories.js'

let tempDirs: string[] = []
let savedIncludePrivate: string | undefined

async function setupTempMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-safetyvalve-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

beforeEach(() => {
  // Make sure no opt-in is active when the test starts; memorySearch.ts treats
  // RELVETIA_INCLUDE_PRIVATE=1 as "include private/" and we want the default
  // (private) path to be the one under test.
  savedIncludePrivate = process.env.RELVETIA_INCLUDE_PRIVATE
  delete process.env.RELVETIA_INCLUDE_PRIVATE
})

afterEach(async () => {
  if (savedIncludePrivate !== undefined) {
    process.env.RELVETIA_INCLUDE_PRIVATE = savedIncludePrivate
  }
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
  tempDirs = []
})

describe('regression: safety valve must not leak private/ private files', () => {
  it('does not return any private/* path when the query has zero hits', async () => {
    const memoryDir = await setupTempMemoryDir({
      'private/private.md': '# Private diary\n\nsensitive personal content; never surface.',
      'topics/public.md': '# Public Topic\n\nordinary content about a public matter.',
    })

    // Make private/private.md the freshest file so the safety valve's
    // newest-first slice picks it up first if no privacy filter is applied.
    const now = new Date()
    const past = new Date(Date.now() - 60_000)
    await utimes(join(memoryDir, 'private', 'private.md'), now, now)
    await utimes(join(memoryDir, 'topics', 'public.md'), past, past)

    // Query that won't tokenize to anything in either file — forces 0 hits at
    // every resolution and triggers the safety valve (findRelevantMemories.ts:221).
    const result = await findRelevantMemories('xyzimpossiblequery123', memoryDir, {
      enableSonnet: false,
      enableMultiResolution: true,
    })

    const privateHit = result.find(r =>
      r.path.replace(/\\/g, '/').includes('/private/'),
    )
    // POST-FIX expectation: private/ entries are filtered before the safety
    // valve returns. PRE-FIX: private/private.md slips into the slice(0, 5).
    expect(privateHit).toBeUndefined()
  })
})
