// private-memory-search-mcp tests — Phase 1 host-gate + namespace.
//
// Uses the same mock-engine pattern as memory-search-mcp.test.js so the
// real relvetia-extracted MemorySearchTool is not required. Tests cover:
//   - host gate (COMPUTERNAME + marker)
//   - memoryDir pinning to the private/ namespace
//   - envelope shape (content[] + structuredContent)

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { _resetForTests } from '../memory-search-mcp.js'
import { privateMemorySearchToolHandler } from '../private-memory-search-mcp.js'

const TMP_ROOT = join(tmpdir(), `private-memory-search-${randomBytes(4).toString('hex')}`)
const MOCK_TOOL_PATH = join(TMP_ROOT, 'MockMemorySearchTool.js')
const PRIVATE_FIXTURE = join(TMP_ROOT, 'private-fixture')
const MARKER_PATH = join(PRIVATE_FIXTURE, '.marker')

const MOCK_SOURCE = `
export async function executeMemorySearch(memoryDir, input, opts = {}) {
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
  if (input.query === '__empty__') return { results: [], hits: [] }
  return {
    results: [
      { path: 'diary/2026-05.md', snippet: 'diary entry text', score: 0.71 },
      { path: 'MANIFESTO.md',     snippet: 'manifesto excerpt', score: 0.55 },
    ],
    hits: [],
  }
}
`

const origs = {
  RELVETIA_MEMORY_DIR: process.env.RELVETIA_MEMORY_DIR,
  RELVETIA_EXTRACTED_TOOL_PATH: process.env.RELVETIA_EXTRACTED_TOOL_PATH,
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
  await mkdir(PRIVATE_FIXTURE, { recursive: true })
  await writeFile(MOCK_TOOL_PATH, MOCK_SOURCE)
  await writeFile(MARKER_PATH, '')
})

after(async () => {
  for (const k of Object.keys(origs)) restoreOrig(k)
  _resetForTests()
  await rm(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.RELVETIA_EXTRACTED_TOOL_PATH = MOCK_TOOL_PATH
  process.env.PRIVATE_EXPECTED_HOST = 'TEST-HOST'
  process.env.PRIVATE_MARKER = MARKER_PATH
  process.env.PRIVATE_MEMORY_DIR = PRIVATE_FIXTURE
  process.env.COMPUTERNAME = 'TEST-HOST'
  _resetForTests()
})

describe('privateMemorySearchToolHandler — host gate', () => {
  it('returns disabled envelope when COMPUTERNAME mismatches', async () => {
    process.env.COMPUTERNAME = 'OTHER-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'anything' })
    assert.equal(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 0)
    assert.equal(r.structuredContent.hits, 0)
    assert.match(r.content[0].text, /disabled on this host/)
  })

  it('returns disabled envelope when marker file is missing', async () => {
    process.env.PRIVATE_MARKER = join(TMP_ROOT, 'nonexistent-marker')
    const r = await privateMemorySearchToolHandler({ query: 'anything' })
    assert.equal(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 0)
  })

  it('allows search when COMPUTERNAME matches AND marker exists', async () => {
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.notEqual(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 2)
  })

  it('honours PRIVATE_EXPECTED_HOST override', async () => {
    process.env.PRIVATE_EXPECTED_HOST = 'OTHER-HOST'
    process.env.COMPUTERNAME = 'OTHER-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.notEqual(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 2)
  })

  // Phase 2 (2026-05-25): CLAUDE_NO_PRIVATE=1 opt-out escape — host gate が
  // 通常なら通る環境でも、escape env が立っていたら gate close する。
  it('Phase 2: closes gate when CLAUDE_NO_PRIVATE=1 (escape) even with valid host', async () => {
    process.env.CLAUDE_NO_PRIVATE = '1'
    try {
      const r = await privateMemorySearchToolHandler({ query: 'anything' })
      assert.equal(r.structuredContent.disabled, true)
      assert.equal(r.structuredContent.results.length, 0)
      assert.match(r.content[0].text, /disabled on this host/)
    } finally {
      delete process.env.CLAUDE_NO_PRIVATE
    }
  })

  it('Phase 2: opens gate when CLAUDE_NO_PRIVATE is unset (default private-mode)', async () => {
    delete process.env.CLAUDE_NO_PRIVATE
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.notEqual(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 2)
  })

  it('Phase 2: CLAUDE_NO_PRIVATE=0 (literal "0") is NOT treated as escape', async () => {
    // gate logic は厳密に "1" のみ escape。"0" / "true" / "yes" 等は無視 (default private-mode 維持)。
    // この pin で「unset / 空文字 / その他値」と「escape "1"」が混同されないことを保証する。
    process.env.CLAUDE_NO_PRIVATE = '0'
    try {
      const r = await privateMemorySearchToolHandler({ query: 'foo' })
      assert.notEqual(r.structuredContent.disabled, true)
      assert.equal(r.structuredContent.results.length, 2)
    } finally {
      delete process.env.CLAUDE_NO_PRIVATE
    }
  })
})

describe('privateMemorySearchToolHandler — namespace pinning', () => {
  it('pins memoryDir to PRIVATE_MEMORY_DIR (override)', async () => {
    const r = await privateMemorySearchToolHandler({ query: '__echo__' })
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.memoryDir, PRIVATE_FIXTURE)
  })

  it('passes recordUsage=false (read-only invariant)', async () => {
    const r = await privateMemorySearchToolHandler({ query: '__echo__' })
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.recordUsage, false)
  })

  it('defaults k to 8 when not specified', async () => {
    const r = await privateMemorySearchToolHandler({ query: '__echo__' })
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.maxResults, 8)
  })

  it('passes k through to the engine maxResults', async () => {
    const r = await privateMemorySearchToolHandler({ query: '__echo__', k: 15 })
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.maxResults, 15)
  })
})

describe('privateMemorySearchToolHandler — envelope shape', () => {
  it('returns formatted text with score + path + snippet', async () => {
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.ok(Array.isArray(r.content))
    assert.equal(r.content[0].type, 'text')
    assert.match(r.content[0].text, /^2 result\(s\) from private\/:/)
    assert.match(r.content[0].text, /\[0\.710\] diary\/2026-05\.md/)
    assert.match(r.content[0].text, /\[0\.550\] MANIFESTO\.md/)
  })

  it('returns "No results found" message for empty corpus', async () => {
    const r = await privateMemorySearchToolHandler({ query: '__empty__' })
    assert.match(r.content[0].text, /No results found/)
    assert.equal(r.structuredContent.results.length, 0)
  })
})

describe('privateMemorySearchToolHandler — MCP server registration', () => {
  let serverMod = null

  before(async () => {
    // Ensure env is set so the handler doesn't try real production paths
    // during the import-time side effect of registering tools.
    process.env.RELVETIA_EXTRACTED_TOOL_PATH = MOCK_TOOL_PATH
    process.env.PRIVATE_EXPECTED_HOST = 'TEST-HOST'
    process.env.PRIVATE_MARKER = MARKER_PATH
    process.env.PRIVATE_MEMORY_DIR = PRIVATE_FIXTURE
    process.env.COMPUTERNAME = 'TEST-HOST'
    serverMod = await import('../index.js')
  })

  it('registers private_memory_search on the relvetia-team server', () => {
    const tools = serverMod.server._registeredTools
    assert.ok(tools.private_memory_search, 'private_memory_search registered')
    assert.equal(typeof tools.private_memory_search.handler, 'function')
  })

  it('private_memory_search Zod schema requires query', () => {
    const t = serverMod.server._registeredTools.private_memory_search
    assert.doesNotThrow(() => t.inputSchema.parse({ query: 'hi' }))
    assert.doesNotThrow(() => t.inputSchema.parse({ query: 'hi', k: 5 }))
    assert.throws(() => t.inputSchema.parse({}), /required|invalid_type/i)
    assert.throws(() => t.inputSchema.parse({ query: '' }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({ query: 'hi', k: 0 }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({ query: 'hi', k: 21 }), /too_big|max/i)
  })

  it('private_memory_search rejects unknown keys at the safeTool strict boundary', async () => {
    const t = serverMod.server._registeredTools.private_memory_search
    const r = await t.handler({ query: 'hi', bogus_extra: 1 }, {})
    assert.equal(r.isError, true)
    assert.match(r.content[0].text, /unrecognized|extra|unknown|bogus_extra|strict/i)
  })

  it('private_memory_search safeTool normal envelope on success', async () => {
    const t = serverMod.server._registeredTools.private_memory_search
    const r = await t.handler({ query: 'foo' }, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent)
  })
})
