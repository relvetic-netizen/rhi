// memory-search-mcp tests — saga 7 Phase 1 MVP.
//
// Approach: mock-first. We construct a tiny fake `MemorySearchTool.js` in a
// temp dir and point `$RELVETIA_EXTRACTED_TOOL_PATH` at it so tests are
// deterministic and do not depend on the relvetia-extracted sibling repo
// being checked out (Phase 1 ships without a file:./ dep — the import is
// purely path-based). A separate conditional `it` exercises the *real*
// engine when it is reachable on disk, so local dev still catches drift.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  runMemorySearch,
  memorySearchToolHandler,
  defaultMemoryDir,
  _resetForTests,
} from '../memory-search-mcp.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const TMP_ROOT = join(tmpdir(), `memory-search-mcp-${randomBytes(4).toString('hex')}`)
const MOCK_TOOL_PATH = join(TMP_ROOT, 'MockMemorySearchTool.js')
const FIXTURE_MEM_DIR = join(TMP_ROOT, 'fake-memory')
const EMPTY_MEM_DIR = join(TMP_ROOT, 'empty-memory')

const origMemDir = process.env.RELVETIA_MEMORY_DIR
const origToolPath = process.env.RELVETIA_EXTRACTED_TOOL_PATH

// Mock executeMemorySearch:
//   - query='__empty__'  → { results: [], hits: [] }
//   - query='__throw__'  → throws
//   - query='__echo__'   → echoes memoryDir + maxResults + recordUsage so we
//                          can assert what the wrapper passed downstream
//   - anything else      → 2 stub results / 2 stub hits
const MOCK_SOURCE = `
let _statsWrites = 0
export const _statsWrites_get = () => _statsWrites

export async function executeMemorySearch(memoryDir, input, opts = {}) {
  if (input.query === '__throw__') throw new Error('mock executeMemorySearch threw')
  if (input.query === '__empty__') return { results: [], hits: [] }
  if (input.query === '__echo__') {
    return {
      results: [{
        path: 'echo/path.md',
        snippet: JSON.stringify({ memoryDir, maxResults: input.maxResults, recordUsage: opts.recordUsage }),
        score: 0.999,
      }],
      hits: [],
    }
  }
  // Simulate the "fire-and-forget stats write" branch when recordUsage=true.
  if (opts.recordUsage !== false) _statsWrites += 1
  return {
    results: [
      { path: 'stub/a.md', snippet: 'stub snippet A', score: 0.81 },
      { path: 'stub/b.md', snippet: 'stub snippet B', score: 0.42 },
    ],
    hits: [
      { entryId: 'e_a', summary: 'stub summary A', topic: 'topic-a', topicPath: 'stub/a.md', sources: [], score: 0.81, updated: '2026-01-01', confidence: 0.9 },
      { entryId: 'e_b', summary: 'stub summary B', topic: 'topic-b', topicPath: 'stub/b.md', sources: [], score: 0.42, updated: '2026-01-02', confidence: 0.7 },
    ],
  }
}
`

before(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  await writeFile(MOCK_TOOL_PATH, MOCK_SOURCE)
  await mkdir(FIXTURE_MEM_DIR, { recursive: true })
  await mkdir(EMPTY_MEM_DIR, { recursive: true })
})

after(async () => {
  if (origMemDir !== undefined) process.env.RELVETIA_MEMORY_DIR = origMemDir
  else delete process.env.RELVETIA_MEMORY_DIR
  if (origToolPath !== undefined) process.env.RELVETIA_EXTRACTED_TOOL_PATH = origToolPath
  else delete process.env.RELVETIA_EXTRACTED_TOOL_PATH
  _resetForTests()
  await rm(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.RELVETIA_EXTRACTED_TOOL_PATH = MOCK_TOOL_PATH
  _resetForTests()
})

describe('defaultMemoryDir', () => {
  it('honors $RELVETIA_MEMORY_DIR when set', () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = '/explicit/path'
    try {
      assert.equal(defaultMemoryDir(), '/explicit/path')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('falls back to ~/.claude/memory when env unset', () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    delete process.env.RELVETIA_MEMORY_DIR
    try {
      assert.equal(defaultMemoryDir(), join(homedir(), '.claude', 'memory'))
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
    }
  })
})

describe('runMemorySearch (thin wrapper)', () => {
  it('returns the engine payload shape verbatim', async () => {
    const out = await runMemorySearch(
      { query: 'foo' },
      { memoryDir: FIXTURE_MEM_DIR, recordUsage: false },
    )
    assert.ok(Array.isArray(out.results))
    assert.ok(Array.isArray(out.hits))
    assert.equal(out.results.length, 2)
    assert.equal(out.results[0].path, 'stub/a.md')
    assert.equal(out.results[0].score, 0.81)
    assert.equal(out.hits[0].entryId, 'e_a')
  })

  it('passes memoryDir / maxResults / recordUsage through to the engine', async () => {
    const out = await runMemorySearch(
      { query: '__echo__', maxResults: 7 },
      { memoryDir: FIXTURE_MEM_DIR, recordUsage: false },
    )
    const echoed = JSON.parse(out.results[0].snippet)
    assert.equal(echoed.memoryDir, FIXTURE_MEM_DIR)
    assert.equal(echoed.maxResults, 7)
    assert.equal(echoed.recordUsage, false)
  })

  it('defaults recordUsage to true when not specified', async () => {
    const out = await runMemorySearch(
      { query: '__echo__' },
      { memoryDir: FIXTURE_MEM_DIR },
    )
    const echoed = JSON.parse(out.results[0].snippet)
    assert.equal(echoed.recordUsage, true)
  })

  it('defaults memoryDir to defaultMemoryDir() when not specified', async () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = FIXTURE_MEM_DIR
    try {
      const out = await runMemorySearch({ query: '__echo__' })
      const echoed = JSON.parse(out.results[0].snippet)
      assert.equal(echoed.memoryDir, FIXTURE_MEM_DIR)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('returns empty arrays without crashing on a deliberately empty corpus', async () => {
    const out = await runMemorySearch(
      { query: '__empty__' },
      { memoryDir: EMPTY_MEM_DIR, recordUsage: false },
    )
    assert.equal(out.results.length, 0)
    assert.equal(out.hits.length, 0)
  })

  it('propagates engine errors (no swallow)', async () => {
    await assert.rejects(
      runMemorySearch({ query: '__throw__' }, { memoryDir: FIXTURE_MEM_DIR, recordUsage: false }),
      /mock executeMemorySearch threw/,
    )
  })

  it('throws a self-describing error when the engine path is unresolvable', async () => {
    const bogusPath = join(TMP_ROOT, 'no-such-file.js')
    process.env.RELVETIA_EXTRACTED_TOOL_PATH = bogusPath
    _resetForTests()
    await assert.rejects(
      runMemorySearch({ query: 'anything' }, { memoryDir: FIXTURE_MEM_DIR, recordUsage: false }),
      /no-such-file\.js|Cannot find|ERR_MODULE_NOT_FOUND/i,
    )
  })

  it('throws when the engine module is missing the executeMemorySearch export', async () => {
    const badModule = join(TMP_ROOT, 'badExport.js')
    await writeFile(badModule, 'export const notTheRightExport = true\n')
    process.env.RELVETIA_EXTRACTED_TOOL_PATH = badModule
    _resetForTests()
    await assert.rejects(
      runMemorySearch({ query: 'anything' }, { memoryDir: FIXTURE_MEM_DIR, recordUsage: false }),
      /did not export executeMemorySearch/,
    )
  })
})

describe('memorySearchToolHandler (MCP envelope)', () => {
  it('returns { content: [...], structuredContent: {...} } shape', async () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = FIXTURE_MEM_DIR
    try {
      const r = await memorySearchToolHandler({ query: 'foo', maxResults: 5 })
      assert.ok(Array.isArray(r.content))
      assert.equal(r.content[0].type, 'text')
      assert.match(r.content[0].text, /^2 result\(s\):/)
      assert.match(r.content[0].text, /\[0\.810\] stub\/a\.md/)
      assert.match(r.content[0].text, /\[0\.420\] stub\/b\.md/)
      assert.ok(r.structuredContent)
      assert.equal(r.structuredContent.results.length, 2)
      assert.equal(r.structuredContent.hits.length, 2)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('emits "No results found" text when the corpus is empty for the query', async () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = EMPTY_MEM_DIR
    try {
      const r = await memorySearchToolHandler({ query: '__empty__' })
      assert.match(r.content[0].text, /^0 result\(s\):/)
      assert.match(r.content[0].text, /No results found/)
      assert.equal(r.structuredContent.results.length, 0)
      assert.equal(r.structuredContent.hits.length, 0)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('forces recordUsage=false at the MCP boundary (read-only invariant)', async () => {
    // Codex P0 #1 (saga-7 review): the MCP-exposed surface MUST NOT mutate
    // the production memory dir. Verify by spying via the __echo__ mock that
    // the handler ALWAYS pins recordUsage=false regardless of caller intent.
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = FIXTURE_MEM_DIR
    try {
      const r = await memorySearchToolHandler({ query: '__echo__', maxResults: 1 })
      const snippet = r.structuredContent.results[0].snippet
      const echoed = JSON.parse(snippet)
      assert.equal(echoed.recordUsage, false, 'MCP boundary must pin recordUsage=false')
      assert.equal(echoed.memoryDir, FIXTURE_MEM_DIR)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('flattens multi-line snippets in the text rendering', async () => {
    // Snippets in real engine output can contain embedded newlines/whitespace.
    // The handler must collapse them to a single line so the tool text stays
    // legible. Verify by patching the mock with a multi-line snippet.
    const multilineMockPath = join(TMP_ROOT, 'multiline-mock.js')
    await writeFile(multilineMockPath, `
      export async function executeMemorySearch() {
        return {
          results: [{ path: 'multi.md', snippet: 'line1\\n\\nline2   line3', score: 0.7 }],
          hits: [],
        }
      }
    `)
    process.env.RELVETIA_EXTRACTED_TOOL_PATH = multilineMockPath
    _resetForTests()
    const r = await memorySearchToolHandler({ query: 'foo' })
    assert.match(r.content[0].text, /\[0\.700\] multi\.md\n {2}line1 line2 line3/)
  })
})

describe('MCP server boundary (Codex P1 #2 — safeTool + Zod schema + registration)', () => {
  // These tests import the actual server module (side effects: registers
  // tools on the singleton). Done lazily so the mock env is set first.
  let serverMod = null
  before(async () => {
    process.env.RELVETIA_EXTRACTED_TOOL_PATH = MOCK_TOOL_PATH
    process.env.RELVETIA_MEMORY_DIR = FIXTURE_MEM_DIR
    _resetForTests()
    serverMod = await import('../index.js')
  })

  it('registers `memory_search` on the relvetia-team server', () => {
    const tools = serverMod.server._registeredTools
    assert.ok(tools, 'McpServer._registeredTools should be present')
    assert.ok(tools.memory_search, '`memory_search` should be registered')
    assert.equal(typeof tools.memory_search.handler, 'function')
  })

  it('exposes a Zod inputSchema with the expected fields', () => {
    const t = serverMod.server._registeredTools.memory_search
    assert.ok(t.inputSchema, 'inputSchema present')
    // Parse a valid args object — the schema is wrapped as a ZodObject; we
    // exercise it via parse() to confirm the keys are honored.
    const parsed = t.inputSchema.parse({ query: 'foo', maxResults: 5, scoreStrategy: 'default' })
    assert.equal(parsed.query, 'foo')
    assert.equal(parsed.maxResults, 5)
    assert.equal(parsed.scoreStrategy, 'default')
  })

  it('rejects empty query at the Zod boundary (query.min(1))', () => {
    const t = serverMod.server._registeredTools.memory_search
    assert.throws(() => t.inputSchema.parse({ query: '' }), /String must contain at least 1 character|too_small|min/i)
  })

  it('rejects maxResults out of bounds at the Zod boundary (1..50)', () => {
    const t = serverMod.server._registeredTools.memory_search
    assert.throws(() => t.inputSchema.parse({ query: 'foo', maxResults: 0 }), /too_small|must be greater than|min/i)
    assert.throws(() => t.inputSchema.parse({ query: 'foo', maxResults: 51 }), /too_big|must be less than|max/i)
  })

  it('rejects scoreStrategy outside the declared enum', () => {
    const t = serverMod.server._registeredTools.memory_search
    assert.throws(() => t.inputSchema.parse({ query: 'foo', scoreStrategy: 'bogus' }), /invalid_value|invalid_enum|scoreStrategy/i)
  })

  it('safeTool wraps engine throws into isError envelope (not propagated)', async () => {
    // The safeTool wrapper catches exceptions and returns
    // `{ content: [...], isError: true }` so the MCP server never crashes
    // on tool-level errors. Drive the engine to throw via __throw__ and
    // verify the wrapper's envelope shape.
    const t = serverMod.server._registeredTools.memory_search
    const r = await t.handler({ query: '__throw__' }, {})
    assert.equal(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.match(r.content[0].text, /Error in memory_search:/)
  })

  it('safeTool wrapper returns the normal envelope on success', async () => {
    const t = serverMod.server._registeredTools.memory_search
    const r = await t.handler({ query: 'foo', maxResults: 2 }, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent)
  })
})

describe('bridge co-exist (no regression to team_search_memory backend)', () => {
  it('memory.js exports are still callable and distinct from memory-search-mcp', async () => {
    // Soft assertion that the existing bridge backend is untouched. If
    // anyone refactors memory.js to remove searchRelvetiaLogs or rename
    // appendRelvetiaLog this will catch it before the larger memory.test.js
    // suite reports a regression.
    const memMod = await import('../memory.js')
    assert.equal(typeof memMod.searchMemory, 'function')
    assert.equal(typeof memMod.searchRelvetiaLogs, 'function')
    assert.equal(typeof memMod.appendRelvetiaLog, 'function')
    const mcpMod = await import('../memory-search-mcp.js')
    assert.notEqual(memMod.searchMemory, mcpMod.runMemorySearch)
    assert.notEqual(memMod.searchMemory, mcpMod.memorySearchToolHandler)
  })
})

// Conditional real-engine smoke: only runs when the sibling
// relvetia-extracted/dist build is reachable on disk. Skipped in CI / clean
// checkouts where the sibling repo isn't present.
const REAL_TOOL_PATH = resolve(
  __dirname, '..', '..', '..',
  'relvetia', 'relvetia-extracted', 'dist', 'tools', 'MemorySearchTool.js',
)
const REAL_MEM_DIR = join(homedir(), '.claude', 'memory')

async function realEngineReachable() {
  try {
    await stat(REAL_TOOL_PATH)
    await stat(REAL_MEM_DIR)
    return true
  } catch {
    return false
  }
}

describe('real-engine smoke (skipped when sibling dist or production memory dir is missing)', () => {
  it('produces results from the real engine against the production memory dir (recordUsage=false, read-only)', async (t) => {
    if (process.env.SKIP_REAL_ENGINE === '1') {
      t.skip('SKIP_REAL_ENGINE=1')
      return
    }
    if (!(await realEngineReachable())) {
      t.skip(`sibling dist (${REAL_TOOL_PATH}) or production memory dir (${REAL_MEM_DIR}) not reachable`)
      return
    }
    delete process.env.RELVETIA_EXTRACTED_TOOL_PATH
    _resetForTests()
    const out = await runMemorySearch(
      { query: 'hands-on verify', maxResults: 5 },
      { memoryDir: REAL_MEM_DIR, recordUsage: false },
    )
    // Permissive assertion (Codex P1 #3): the real engine reads the
    // user's live memory dir, whose contents change over time. We assert
    // only that the call completes with a well-shaped payload and that
    // *something* topic-shaped came back (any path under topics/ or any
    // .md file). Strict "logs/2026/X.md must be present" was too tight —
    // if logs rotate or get distilled the test would flap.
    assert.ok(Array.isArray(out.results), 'results array')
    assert.ok(Array.isArray(out.hits), 'hits array')
    if (out.results.length > 0) {
      const paths = out.results.map(r => r.path).join(' | ')
      assert.match(paths, /\.md(\b|$)|topics|logs|MEMORY/, `expected some memory-shaped path: ${paths}`)
    }
    // Empty result for a query that should hit *something* in any normal
    // user's memory dir is a hint that the engine is broken or the dir
    // is empty — log it for diagnosis without flapping the test.
    if (out.results.length === 0) {
      t.diagnostic('real-engine smoke produced 0 results for "hands-on verify"; engine may be degraded or memory dir empty')
    }
  })
})
