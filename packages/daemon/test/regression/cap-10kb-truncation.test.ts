// Phase 0 regression fixture 1 (Plan v3 § Phase 0 T0-3)
//
// Asserts post-fix behavior: a unique keyword that lives at byte 25_000 of a
// 30 KB topic file is discoverable via searchMemoryWithScreening.
//
// Pre-fix expectation: this fails because readMemoryFiles truncates each file
// to MAX_FILE_BYTES=10_000 (memorySearch.ts:82), so the keyword is never tokenized.
// The Phase 3 T4 entry-centric default flips this green once index.json entries
// carry the keyword in summary/concepts instead of relying on file slice scan.
//
// Note: file path layout follows existing relvetia-daemon convention
// (test/foo.test.ts importing from ../../extracted/...). The Phase 0
// handoff suggested extracted/__tests__/regression/ but that package
// lacks vitest; we use the existing vitest harness for surgical minimal change
// per Karpathy 2 (Simplicity) + 3 (Surgical Changes).

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { searchMemoryWithScreening } from '../../../extracted/screening/memorySearch.js'
import type { ScreeningConfig } from '../../../extracted/screening/screening.js'

const SCREENING_CONFIG: ScreeningConfig = {
  threshold: 0.01,
  maxResults: 20,
}

let tempDirs: string[] = []

async function setupTempMemoryDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-cap10k-'))
  tempDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, ...rel.split('/'))
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return dir
}

function generateBigTopicFile(
  totalBytes: number,
  opts: { targetEntryAt: number; targetKeyword: string },
): string {
  // Filler bytes that are clearly distinct from the target keyword so the
  // tokenizer cannot collapse a near-match by coincidence. ASCII only to keep
  // the literal-substring CJK fallback (memorySearch.ts hasCJK gate) inactive
  // — pre-fix failure must be due to the 10 KB truncation, not the fallback.
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '
  const headerLines = '# Big Test Topic\n\n## Section A\n\nbackground prose follows.\n\n'

  let body = headerLines
  while (body.length < opts.targetEntryAt) {
    body += filler
  }
  // Slice precisely so the keyword sits at the target byte offset, well past
  // MAX_FILE_BYTES=10_000 (memorySearch.ts:82). 25_000 > 10_000 guarantees the
  // keyword is dropped before screening.
  body = body.slice(0, opts.targetEntryAt) + `\n\n- ${opts.targetKeyword} unique line ${Date.now()}\n\n`
  while (body.length < totalBytes) {
    body += filler
  }
  return body.slice(0, totalBytes)
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

describe('regression: 10KB cap retrieval truncation', () => {
  it('finds the unique keyword that sits at byte 25_000 of a 30KB topic file', async () => {
    const keyword = 'targetuniquekeyword12345'
    const memoryDir = await setupTempMemoryDir({
      'topics/big-test.md': generateBigTopicFile(30_000, {
        targetEntryAt: 25_000,
        targetKeyword: keyword,
      }),
    })

    const result = await searchMemoryWithScreening(memoryDir, keyword, SCREENING_CONFIG)

    // POST-FIX expectation: entry-centric retrieval (Phase 3 T4) surfaces
    // the keyword via index.json or chunked reads instead of the 10 KB slice.
    //
    // PRE-FIX: this fails — the keyword lives at byte 25_000 and is dropped
    // by the MAX_FILE_BYTES=10_000 read in readMemoryFiles().
    expect(result.length).toBeGreaterThan(0)
  })
})
