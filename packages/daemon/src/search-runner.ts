#!/usr/bin/env node
// search-runner — standalone Node.js script for screening-aware memory search.
//
// Provides the full 4-stage search pipeline as a CLI tool:
//   TF-IDF + Trim-and-Square → concept augmentation → usage weighting → results
//
// Usage:
//   node dist/search-runner.js "query text"
//   node dist/search-runner.js "query text" --memory-dir /path --max-results 10
//   node dist/search-runner.js "query text" --json
//
// Output: human-readable search results (default) or JSON (--json)

import {
  executeMemorySearch,
  formatSearchResults,
} from '../../extracted/tools/MemorySearchTool.js'

async function main() {
  console.warn('[deprecated] bash CLI search-runner is deprecated. Use mcp__relvetia-team__memory_search instead.')
  const args = process.argv.slice(2)

  // Extract flags
  const jsonOutput = args.includes('--json')
  const filteredArgs = args.filter(a => a !== '--json')

  // Parse --memory-dir
  const memDirIdx = filteredArgs.indexOf('--memory-dir')
  let memoryDir: string
  if (memDirIdx >= 0 && filteredArgs[memDirIdx + 1]) {
    memoryDir = filteredArgs[memDirIdx + 1]!
    filteredArgs.splice(memDirIdx, 2)
  } else {
    memoryDir = process.env.RELVETIA_MEMORY_DIR
      ?? (process.env.HOME ? `${process.env.HOME}/.claude/memory` : '')
  }

  // Parse --max-results
  const maxIdx = filteredArgs.indexOf('--max-results')
  let maxResults: number | undefined
  if (maxIdx >= 0 && filteredArgs[maxIdx + 1]) {
    maxResults = parseInt(filteredArgs[maxIdx + 1]!, 10)
    filteredArgs.splice(maxIdx, 2)
  }

  // Saga 14: --record-usage opt-in flag (default false). Saga 7 fix pinned the
  // MCP boundary to recordUsage:false; the Path C Bash CLI path was missed,
  // leaving production stats.json mutable from CLI fire. This flag flips the
  // CLI default to false (read-only) and lets legitimate callers (background
  // indexer, dogfood scripts) opt back into legacy fire with --record-usage.
  const recordUsage = filteredArgs.includes('--record-usage')
  const recordUsageIdx = filteredArgs.indexOf('--record-usage')
  if (recordUsageIdx >= 0) {
    filteredArgs.splice(recordUsageIdx, 1)
  }

  // Remaining arg is the query
  const query = filteredArgs[0]
  if (!query?.trim()) {
    console.error('Usage: search-runner.js "query" [--memory-dir path] [--max-results N] [--json] [--record-usage]')
    process.exit(1)
  }

  if (!memoryDir) {
    console.error('[search-runner] cannot determine memory directory')
    process.exit(1)
  }

  const result = await executeMemorySearch(
    memoryDir,
    {
      query,
      ...(maxResults ? { maxResults } : {}),
    },
    { recordUsage },
  )

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(result, null, 2))
  } else {
    process.stdout.write(formatSearchResults(result))
  }
}

main().catch(e => {
  console.error('[search-runner] fatal:', e)
  process.exit(1)
})
