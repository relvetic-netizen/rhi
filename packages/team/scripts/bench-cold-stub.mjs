#!/usr/bin/env node
// Cold-process benchmark stub for memory-search-perf.mjs.
//
// Spawned as `node bench-cold-stub.mjs <query>`. Runs a single read-only
// memory search and exits. Wall-clock from spawn to exit captures
// (node ESM startup + module resolve + warm call) — the cost a per-call
// subprocess wrapper would impose if the MCP server were not long-lived.

import { runMemorySearch } from '../src/memory-search-mcp.js'

const query = process.argv[2] || 'test'
await runMemorySearch({ query, maxResults: 5 }, { recordUsage: false })
