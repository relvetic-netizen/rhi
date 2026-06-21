// Memory-search MCP handler — thin wrapper around relvetia-extracted's
// executeMemorySearch (TF-IDF + Trim-and-Square screening, 5-stage retrieval
// engine). Exposed as `memory_search` via src/index.js.
//
// Design constraints (saga 7 Phase 1):
//   - No new npm dep: relvetia-extracted is imported by relative path from
//     the sibling workspace dir. Override via $RELVETIA_EXTRACTED_TOOL_PATH.
//   - No duplicate engine: single source of truth = executeMemorySearch.
//   - Backward compat: existing `team_search_memory` (boolean matcher
//     bridge) is untouched; this tool is a sibling, not a replacement.
//   - Test isolation: memoryDir defaults to ~/.claude/memory and is
//     overridable via $RELVETIA_MEMORY_DIR for tests; production memory
//     dir is never mutated (engine call is read-only modulo fire-and-forget
//     stats writes, which tests disable via recordUsage=false).

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))

function resolveExtractedToolPath() {
  if (process.env.RELVETIA_EXTRACTED_TOOL_PATH) {
    return process.env.RELVETIA_EXTRACTED_TOOL_PATH
  }
  // Monorepo layout: packages/team/src/ -> packages/extracted/dist/...
  const monorepo = resolve(
    __dirname, '..', '..', 'extracted', 'dist', 'tools', 'MemorySearchTool.js',
  )
  if (existsSync(monorepo)) return monorepo
  // Legacy multi-repo layout: <workspace>/relvetia/relvetia-extracted/dist/...
  return resolve(
    __dirname, '..', '..',
    'relvetia', 'relvetia-extracted', 'dist', 'tools', 'MemorySearchTool.js',
  )
}

let _execCache = null
async function getExecuteMemorySearch() {
  if (_execCache) return _execCache
  const toolPath = resolveExtractedToolPath()
  const mod = await import(pathToFileURL(toolPath).href)
  const fn = mod.executeMemorySearch
  if (typeof fn !== 'function') {
    throw new Error(
      `relvetia-extracted MemorySearchTool did not export executeMemorySearch. ` +
      `Resolved path: ${toolPath}. Set RELVETIA_EXTRACTED_TOOL_PATH to override.`,
    )
  }
  _execCache = fn
  return fn
}

// Test-only: clear the cached import so each test run re-resolves
// $RELVETIA_EXTRACTED_TOOL_PATH (otherwise the first call would freeze it).
export function _resetForTests() {
  _execCache = null
}

export function defaultMemoryDir() {
  return process.env.RELVETIA_MEMORY_DIR || join(homedir(), '.claude', 'memory')
}

/**
 * Direct, internal-caller entry: runs the engine and returns the raw
 * `{ results, hits }` payload. Used by tests and the MCP handler below.
 *
 * @param {object} input
 * @param {string} input.query
 * @param {number} [input.maxResults]
 * @param {string} [input.scoreStrategy]   // Phase 3 enum slot; currently no-op
 * @param {object} [opts]
 * @param {string} [opts.memoryDir]        // Override memory dir (tests)
 * @param {boolean} [opts.recordUsage]     // Default true (production); tests pass false
 * @param {object} [opts.corpus]           // CorpusManifest passthrough — when set,
 *                                          forwarded to executeMemorySearch as
 *                                          `options.corpus` so the engine's
 *                                          `matchesCorpus` filter excludes the
 *                                          designated roots (the private
 *                                          handler adds `'archive'` to defaults).
 */
export async function runMemorySearch(input, opts = {}) {
  const exec = await getExecuteMemorySearch()
  const memoryDir = opts.memoryDir || defaultMemoryDir()
  // Phase 1 ignores scoreStrategy: the engine's NoopScoreStrategy singleton
  // is used. Phase 3 will wire the enum to LlmRerankerScoreStrategy etc.
  const execOpts = {
    recordUsage: opts.recordUsage !== false,
  }
  if (opts.corpus !== undefined) {
    execOpts.corpus = opts.corpus
  }
  return exec(memoryDir, { query: input.query, maxResults: input.maxResults }, execOpts)
}

/**
 * MCP tool handler — shapes the engine response into an MCP `content[]` +
 * `structuredContent` envelope. Errors propagate to the safeTool wrapper.
 *
 * Read-only invariant: the MCP-exposed surface MUST NOT mutate the
 * production memory dir. The engine's fire-and-forget stats writer
 * (`recordHits` in MemorySearchTool.ts) writes to `<memoryDir>/stats.json`
 * when `recordUsage: true`. We pin `recordUsage: false` here so every
 * call through the MCP boundary stays read-only. Internal callers that
 * legitimately want usage stats (e.g. a background indexer) can use
 * `runMemorySearch` directly with `recordUsage: true`.
 */
export async function memorySearchToolHandler(args) {
  const out = await runMemorySearch(args, { recordUsage: false })
  const lines = out.results.length === 0
    ? 'No results found (all items fell below the screening threshold).'
    : out.results
        .map(r => {
          const snippet = (r.snippet || '').slice(0, 200).replace(/\s+/g, ' ').trim()
          return `[${r.score.toFixed(3)}] ${r.path}\n  ${snippet}`
        })
        .join('\n\n')
  const header = `${out.results.length} result(s):`
  return {
    content: [{ type: 'text', text: `${header}\n${lines}` }],
    structuredContent: {
      results: out.results,
      hits: out.hits,
    },
  }
}
