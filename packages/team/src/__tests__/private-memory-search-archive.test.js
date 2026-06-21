// Contract tests — private_memory_search archive/ exclusion.
//
// These tests exercise the REAL relvetia-extracted MemorySearchTool engine
// (not the mock used by private-memory-search-mcp.test.js) so the
// `excludedRoots: [...defaults, 'archive']` plumbing actually traverses
// `executeMemorySearch → engine.retrieve → scanMemoryFiles → matchesCorpus`.
//
// Why mock-bypass is mandatory: the contract under test is "archive/ files
// never reach the search results", which is a property of `matchesCorpus`
// itself. A mock that ignores `opts.corpus` would pass even if the wiring
// regressed silently. The harness MUST observe the engine actually filtering.
//
// Fixture isolation: each test creates an isolated memoryDir under tmpdir
// with only the files needed for that case. recordUsage=false (pinned in
// the handler) keeps the engine read-only — no stats.json mutation.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { _resetForTests } from '../memory-search-mcp.js'
import {
  privateMemorySearchToolHandler,
  _resetCorpusForTests,
} from '../private-memory-search-mcp.js'

const TMP_ROOT = join(tmpdir(), `private-archive-${randomBytes(4).toString('hex')}`)

const origs = {
  RELVETIA_MEMORY_DIR: process.env.RELVETIA_MEMORY_DIR,
  RELVETIA_EXTRACTED_TOOL_PATH: process.env.RELVETIA_EXTRACTED_TOOL_PATH,
  RELVETIA_CORPUS_MANIFEST_PATH: process.env.RELVETIA_CORPUS_MANIFEST_PATH,
  COMPUTERNAME: process.env.COMPUTERNAME,
  PRIVATE_MARKER: process.env.PRIVATE_MARKER,
  PRIVATE_EXPECTED_HOST: process.env.PRIVATE_EXPECTED_HOST,
  PRIVATE_MEMORY_DIR: process.env.PRIVATE_MEMORY_DIR,
}

function restoreOrig(name) {
  if (origs[name] !== undefined) process.env[name] = origs[name]
  else delete process.env[name]
}

before(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  // Force real-engine resolution by clearing any mock path leftover from
  // sibling test files that may have run earlier in the same process.
  delete process.env.RELVETIA_EXTRACTED_TOOL_PATH
  delete process.env.RELVETIA_CORPUS_MANIFEST_PATH
  _resetForTests()
  _resetCorpusForTests()
})

after(async () => {
  for (const k of Object.keys(origs)) restoreOrig(k)
  _resetForTests()
  _resetCorpusForTests()
  await rm(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  // host gate: ON by default; individual tests override COMPUTERNAME to
  // disable.
  process.env.PRIVATE_EXPECTED_HOST = 'TEST-HOST'
  process.env.COMPUTERNAME = 'TEST-HOST'
  // ensure caches use the real engine + real CorpusManifest defaults
  delete process.env.RELVETIA_EXTRACTED_TOOL_PATH
  delete process.env.RELVETIA_CORPUS_MANIFEST_PATH
  _resetForTests()
  _resetCorpusForTests()
})

async function createFixture(name, layout) {
  // layout = { 'topics/foo.md': '<content>', 'archive/bar.md': '<content>', ... }
  const dir = join(TMP_ROOT, `${name}-${randomBytes(3).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  const marker = join(dir, '.marker')
  await writeFile(marker, '')
  for (const [rel, content] of Object.entries(layout)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, '..'), { recursive: true })
    await writeFile(abs, content)
  }
  process.env.PRIVATE_MARKER = marker
  process.env.PRIVATE_MEMORY_DIR = dir
  return dir
}

// Strong, low-ambiguity query body so the engine's TF-IDF + screening
// definitely fires regardless of fixture noise.
const ARCHIVE_BODY = 'mio passive watch drop persona quest decision archive sprintA contract test fixture content unique 9f2c'

// Engine surfaces path with the host OS separator (backslash on Windows).
// All assertions about path shape work on the forward-slash-normalized view
// so the contract under test stays platform-independent.
function fwdPaths(results) {
  return results.map(x => x.path.replace(/\\/g, '/'))
}

describe('private_memory_search archive/ exclusion — contract', () => {
  it('1. archive_file_present_but_excluded — topics/ hits, archive/ does not', async () => {
    await createFixture('case1', {
      'topics/foo.md': ARCHIVE_BODY,
      'archive/2026-05-foo.md': ARCHIVE_BODY,
    })
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY })
    const paths = fwdPaths(r.structuredContent.results)
    assert.ok(
      paths.some(p => p.includes('topics/foo.md')),
      `expected topics/foo.md in results, got: ${JSON.stringify(paths)}`,
    )
    assert.ok(
      !paths.some(p => p.includes('archive/')),
      `archive/ leaked into results: ${JSON.stringify(paths)}`,
    )
  })

  it('2. archive_only_corpus_returns_zero — archive/ alone yields 0 results', async () => {
    await createFixture('case2', {
      'archive/2026-05-only.md': ARCHIVE_BODY,
    })
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY })
    assert.equal(
      r.structuredContent.results.length, 0,
      `expected 0 results, got: ${JSON.stringify(r.structuredContent.results)}`,
    )
  })

  it('3. archive_score_zero_not_just_demoted — archive/ never appears at any rank', async () => {
    await createFixture('case3', {
      'topics/y.md': ARCHIVE_BODY,
      'archive/2026-05-y.md': ARCHIVE_BODY,
    })
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY, k: 20 })
    const archivePaths = fwdPaths(r.structuredContent.results).filter(p => p.includes('archive/'))
    assert.equal(
      archivePaths.length, 0,
      `archive/ entries leaked at any rank (excluded means score 0, not demoted): ${JSON.stringify(archivePaths)}`,
    )
  })

  it('4. archive_nested_dir_excluded — archive/2026/04/quest.md also filtered', async () => {
    await createFixture('case4', {
      'topics/baseline.md': ARCHIVE_BODY,
      'archive/2026/04/quest.md': ARCHIVE_BODY,
    })
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY, k: 10 })
    const paths = fwdPaths(r.structuredContent.results)
    // After forward-slash normalization the nested archive entry would surface
    // as `archive/2026/04/quest.md` if it leaked. Confirm baseline hits and
    // no archive/ path appears at any depth.
    assert.ok(
      paths.some(p => p.includes('topics/baseline.md')),
      `expected topics/baseline.md in results, got: ${JSON.stringify(paths)}`,
    )
    assert.ok(
      !paths.some(p => p.includes('archive/')),
      `nested archive/ entry leaked: ${JSON.stringify(paths)}`,
    )
  })

  it('5. lookalike_topic_not_excluded — topics/archive-design.md still surfaces', async () => {
    await createFixture('case5', {
      'topics/archive-design.md': ARCHIVE_BODY,
    })
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY, k: 10 })
    const paths = fwdPaths(r.structuredContent.results)
    // matchesPattern is top-level prefix anchored, so `topics/archive-design.md`
    // must NOT be filtered by the `archive` excludedRoot (which only matches
    // paths whose top-level segment IS `archive`).
    assert.ok(
      paths.some(p => p.includes('topics/archive-design.md')),
      `expected topics/archive-design.md in results (top-level != archive), got: ${JSON.stringify(paths)}`,
    )
  })

  it('6. k_param_ignores_archive_in_count — k=8 with 10 archive + 3 diary returns 3', async () => {
    const layout = {}
    for (let i = 0; i < 10; i++) {
      layout[`archive/2026-05-${String(i).padStart(2, '0')}.md`] = ARCHIVE_BODY
    }
    for (let i = 0; i < 3; i++) {
      layout[`diary/2026-05-${String(i).padStart(2, '0')}.md`] = ARCHIVE_BODY
    }
    await createFixture('case6', layout)
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY, k: 8 })
    const paths = fwdPaths(r.structuredContent.results)
    assert.equal(
      paths.length, 3,
      `k=8 should yield only the 3 diary/ entries when 10 archive/ entries are excluded; got: ${JSON.stringify(paths)}`,
    )
    // sanity: every returned path must be a diary/ entry, not archive/
    for (const p of paths) {
      assert.ok(
        p.includes('diary/') && !p.includes('archive/'),
        `unexpected non-diary or archive entry: ${p}`,
      )
    }
  })

  it('7. disabled_host_still_excludes — host gate off yields 0 (negative control)', async () => {
    await createFixture('case7', {
      'topics/whatever.md': ARCHIVE_BODY,
      'archive/2026-05-whatever.md': ARCHIVE_BODY,
    })
    // flip COMPUTERNAME to a non-matching host so the gate denies upfront
    process.env.COMPUTERNAME = 'OTHER-HOST'
    const r = await privateMemorySearchToolHandler({ query: ARCHIVE_BODY })
    assert.equal(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 0)
  })
})
