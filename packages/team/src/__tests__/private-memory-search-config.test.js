// persona config-driven gate tests — the generalization that lets a fresh
// checkout configure its own persona via persona.config.json instead of the
// hardcoded persona/host defaults.
//
// Precedence contract under test: PRIVATE_* env > config file >
// disabled. With neither, the tool is OFF (safe default for public release).
// Uses the same mock-engine pattern as private-memory-search-mcp.test.js so the
// real relvetia-extracted MemorySearchTool is not required for the gate logic.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { _resetForTests } from '../memory-search-mcp.js'
import {
  privateMemorySearchToolHandler,
  _resetConfigForTests,
  _resetCorpusForTests,
} from '../private-memory-search-mcp.js'

const TMP_ROOT = join(tmpdir(), `persona-config-${randomBytes(4).toString('hex')}`)
const MOCK_TOOL_PATH = join(TMP_ROOT, 'MockMemorySearchTool.js')
const FIXTURE_DIR = join(TMP_ROOT, 'persona-fixture')
const MARKER_PATH = join(FIXTURE_DIR, '.enabled')
const CONFIG_PATH = join(TMP_ROOT, 'persona.config.json')
const ABSENT_CONFIG = join(TMP_ROOT, 'does-not-exist.json')

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

const PRIVATE_ENV = [
  'PRIVATE_EXPECTED_HOST',
  'PRIVATE_MARKER',
  'PRIVATE_MEMORY_DIR',
]
const origs = {
  RELVETIA_EXTRACTED_TOOL_PATH: process.env.RELVETIA_EXTRACTED_TOOL_PATH,
  RELVETIA_CORPUS_MANIFEST_PATH: process.env.RELVETIA_CORPUS_MANIFEST_PATH,
  COMPUTERNAME: process.env.COMPUTERNAME,
  PERSONA_CONFIG_PATH: process.env.PERSONA_CONFIG_PATH,
  CLAUDE_NO_PRIVATE: process.env.CLAUDE_NO_PRIVATE,
}
for (const k of PRIVATE_ENV) origs[k] = process.env[k]

function restoreOrig(name) {
  if (origs[name] !== undefined) process.env[name] = origs[name]
  else delete process.env[name]
}

async function writeConfig(obj) {
  await writeFile(CONFIG_PATH, JSON.stringify(obj))
  process.env.PERSONA_CONFIG_PATH = CONFIG_PATH
  _resetConfigForTests()
}

before(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
  await mkdir(FIXTURE_DIR, { recursive: true })
  await writeFile(MOCK_TOOL_PATH, MOCK_SOURCE)
  await writeFile(MARKER_PATH, '')
})

after(async () => {
  for (const k of Object.keys(origs)) restoreOrig(k)
  _resetForTests()
  _resetConfigForTests()
  _resetCorpusForTests()
  await rm(TMP_ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  // Force the config path: clear all back-compat env so resolveSettings()
  // falls through to the persona config file.
  for (const k of PRIVATE_ENV) delete process.env[k]
  delete process.env.CLAUDE_NO_PRIVATE
  delete process.env.RELVETIA_CORPUS_MANIFEST_PATH
  process.env.RELVETIA_EXTRACTED_TOOL_PATH = MOCK_TOOL_PATH
  process.env.PERSONA_CONFIG_PATH = ABSENT_CONFIG
  _resetForTests()
  _resetConfigForTests()
  _resetCorpusForTests()
})

describe('persona config — gate resolution', () => {
  it('enabled when config host matches AND marker exists', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR, marker: MARKER_PATH, expectedHost: 'TEST-HOST' })
    process.env.COMPUTERNAME = 'TEST-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.notEqual(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 2)
  })

  it('disabled when config host mismatches', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR, marker: MARKER_PATH, expectedHost: 'OTHER-HOST' })
    process.env.COMPUTERNAME = 'TEST-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.equal(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 0)
  })

  it('disabled when config marker is missing', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR, marker: join(TMP_ROOT, 'no-marker'), expectedHost: 'TEST-HOST' })
    process.env.COMPUTERNAME = 'TEST-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.equal(r.structuredContent.disabled, true)
  })

  it('host-gate-less: config with no expectedHost and no marker is enabled on any host', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR })
    process.env.COMPUTERNAME = 'SOME-RANDOM-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.notEqual(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 2)
  })

  it('public-safe default: no config file AND no env → disabled', async () => {
    // beforeEach already set PERSONA_CONFIG_PATH = ABSENT_CONFIG and cleared env.
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.equal(r.structuredContent.disabled, true)
    assert.equal(r.structuredContent.results.length, 0)
  })

  it('malformed config → disabled (a broken config never opens the gate)', async () => {
    await writeFile(CONFIG_PATH, '{ this is not valid json ')
    process.env.PERSONA_CONFIG_PATH = CONFIG_PATH
    _resetConfigForTests()
    process.env.COMPUTERNAME = 'TEST-HOST'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.equal(r.structuredContent.disabled, true)
  })

  it('CLAUDE_NO_PRIVATE=1 closes the gate even with a valid config', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR })
    process.env.CLAUDE_NO_PRIVATE = '1'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.equal(r.structuredContent.disabled, true)
  })
})

describe('persona config — env precedence + namespace', () => {
  it('PRIVATE_* env takes precedence over the config file', async () => {
    // Config alone would DISABLE (host mismatch), but env should win and enable.
    await writeConfig({ name: 'p', memoryDir: join(TMP_ROOT, 'wrong-dir'), expectedHost: 'WRONG-HOST' })
    process.env.PRIVATE_EXPECTED_HOST = 'TEST-HOST'
    process.env.PRIVATE_MARKER = MARKER_PATH
    process.env.PRIVATE_MEMORY_DIR = FIXTURE_DIR
    process.env.COMPUTERNAME = 'TEST-HOST'
    const r = await privateMemorySearchToolHandler({ query: '__echo__' })
    assert.notEqual(r.structuredContent.disabled, true)
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.memoryDir, FIXTURE_DIR) // env memoryDir, not config's wrong-dir
  })

  it('config name appears in the output label', async () => {
    await writeConfig({ name: 'alice', memoryDir: FIXTURE_DIR })
    process.env.COMPUTERNAME = 'ANY'
    const r = await privateMemorySearchToolHandler({ query: 'foo' })
    assert.match(r.content[0].text, /result\(s\) from alice\/:/)
  })

  it('config memoryDir is pinned into the engine call', async () => {
    await writeConfig({ name: 'p', memoryDir: FIXTURE_DIR })
    process.env.COMPUTERNAME = 'ANY'
    const r = await privateMemorySearchToolHandler({ query: '__echo__' })
    const echoed = JSON.parse(r.structuredContent.results[0].snippet)
    assert.equal(echoed.memoryDir, FIXTURE_DIR)
    assert.equal(echoed.recordUsage, false)
  })
})
