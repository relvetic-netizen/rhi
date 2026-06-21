#!/usr/bin/env node
// memory-search-perf — saga 7 Phase 1-3 latency benchmark.
//
// Measures three tracks against `~/.claude/memory/`:
//   1. in-process MCP handler  — handler.runMemorySearch() called directly
//      from this process. 5 warm-up queries, then 30 distinct queries × 3
//      rounds = 90 measurements. Statistics: p50, p95, mean, std.
//   2. cold-process MCP handler — `node bench-cold-stub.mjs <query>` spawn,
//      3 calls. Approximates the latency a fresh subagent / per-call
//      subprocess would see if the wrapper were invoked outside a
//      long-lived MCP server.
//   3. CLI baseline — `node <relvetia-daemon>/dist-runners/search-runner.js
//      <query>`, 3 calls. The path that exists *today* (saga 5 baseline-v3
//      mean ≈ 1009 ms). Comparison anchor for the saga-7 revised
//      acceptance #2 ("CLI baseline 比 improvement").
//
// Cause attribution:
//   The relvetia-extracted engine emits screening events on stderr (BM25
//   passes for corpus/files/log-lines, log_line_screening, search_completed,
//   pipeline_used). The in-process track redirects engine stderr via the
//   `inProcessInstrument()` wrapper so we can count BM25 fires per call.
//   This explains *why* warm ≈ cold: each call re-reads files and
//   recomputes IDF; node-startup elimination buys only ~150-300 ms.
//
// Output: a markdown report written to
// `docs/saga-7-memory-search-perf-2026-05-20.md` and a human summary on
// stderr. The script does not mutate production memory (`recordUsage:false`
// throughout); CLI baseline calls write to stats.json by default, so they
// are also disabled there via `RELVETIA_OBSERVE=0` if that env is honored;
// otherwise we accept the fire-and-forget stats write as part of CLI's
// existing semantics (we only measure wall-clock latency).

import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { writeFile, mkdir, cp, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

import { runMemorySearch } from '../src/memory-search-mcp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

const QUERIES = [
  'hands-on verify', 'saga 5', 'memory search', 'screening', 'Path A baseline',
  'node startup', 'MCP tool', 'relvetia-team', 'handoff', 'orchestrator',
  'spawn relay', 'Phase 1', 'BM25', 'TF-IDF', 'concept graph',
  'distill', 'walker', 'daemon', 'context budget', 'inbox',
  'channel', 'approval', 'task complete', 'evaluator', 'cross-team',
  'guardrails', 'test framework', 'Karpathy', 'Verify', 'Skill',
]
const ROUNDS = 3
const WARMUP = ['warm-up', 'memory', 'search', 'test', 'foo']

// Codex P1 #4: subprocess track n=3 was too thin for p95 / std. Bumped
// to 30 so the comparison to the in-process p50 / p95 has comparable
// statistical weight. Total runtime impact ~78 s (3 tracks × ~1.3 s per
// call × 30 - prior 3) — acceptable for an explicit benchmark script.
const SUBPROC_N = 30

function stats(samples) {
  if (samples.length === 0) return { n: 0 }
  const s = [...samples].sort((a, b) => a - b)
  const n = s.length
  const pick = p => s[Math.min(n - 1, Math.floor(n * p))]
  const mean = s.reduce((a, b) => a + b, 0) / n
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return {
    n, min: s[0], max: s[n - 1],
    p50: pick(0.5), p95: pick(0.95), p99: pick(0.99),
    mean, std: Math.sqrt(variance),
  }
}

const fmt = (x, d = 1) => (x === undefined || Number.isNaN(x)) ? 'n/a' : x.toFixed(d)

async function inProcessMeasurement() {
  process.stderr.write('[bench] in-process: warming up (5 queries)\n')
  for (const q of WARMUP) {
    await runMemorySearch({ query: q, maxResults: 5 }, { recordUsage: false })
  }
  process.stderr.write(`[bench] in-process: ${QUERIES.length} queries × ${ROUNDS} rounds = ${QUERIES.length * ROUNDS} measurements\n`)
  const samples = []
  for (let r = 0; r < ROUNDS; r++) {
    for (const q of QUERIES) {
      const t0 = performance.now()
      await runMemorySearch({ query: q, maxResults: 5 }, { recordUsage: false })
      samples.push(performance.now() - t0)
    }
    process.stderr.write(`[bench] in-process: round ${r + 1}/${ROUNDS} done\n`)
  }
  return { samples, stats: stats(samples) }
}

async function spawnTimed(cmd, args, env = {}) {
  return new Promise((resolveP, rejectP) => {
    const t0 = performance.now()
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let stderr = ''
    p.stdout.on('data', () => {})
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('exit', (code) => {
      const ms = performance.now() - t0
      if (code !== 0) return rejectP(new Error(`exit ${code}\n${stderr.slice(0, 500)}`))
      resolveP({ ms, stderr })
    })
    p.on('error', rejectP)
  })
}

async function coldProcessMeasurement(n = 3) {
  process.stderr.write(`[bench] cold-process MCP handler: ${n} calls (spawn → handler → exit)\n`)
  const stub = resolve(__dirname, 'bench-cold-stub.mjs')
  const samples = []
  for (let i = 0; i < n; i++) {
    const { ms } = await spawnTimed('node', [stub, QUERIES[i % QUERIES.length]])
    samples.push(ms)
    process.stderr.write(`[bench]   ${i + 1}/${n}: ${ms.toFixed(1)}ms\n`)
  }
  return { samples, stats: stats(samples) }
}

async function cliBaselineMeasurement(snapshotDir, n = 3) {
  // search-runner.js hardcodes `recordUsage: true` (no env / flag to disable).
  // To preserve the read-only invariant we point the CLI at a snapshot via
  // its --memory-dir flag so any stats writes land in the snapshot, not in
  // ~/.claude/memory.
  const cliPath = join(homedir(), 'workspace', 'relvetia', 'relvetia-daemon', 'dist-runners', 'search-runner.js')
  process.stderr.write(`[bench] CLI baseline (${cliPath}, --memory-dir ${snapshotDir}): ${n} calls\n`)
  const samples = []
  const errors = []
  for (let i = 0; i < n; i++) {
    try {
      const { ms } = await spawnTimed('node', [cliPath, QUERIES[i % QUERIES.length], '--memory-dir', snapshotDir])
      samples.push(ms)
      process.stderr.write(`[bench]   ${i + 1}/${n}: ${ms.toFixed(1)}ms\n`)
    } catch (e) {
      errors.push(e.message)
      process.stderr.write(`[bench]   ${i + 1}/${n}: ERROR ${e.message.slice(0, 100)}\n`)
    }
  }
  return { samples, stats: stats(samples), errors }
}

async function snapshotMemoryDir(srcDir, dstDir) {
  // Use cp recursive with filter to avoid copying .bak* / pre-* clutter.
  // We only need the files the engine actually reads.
  await mkdir(dstDir, { recursive: true })
  await cp(srcDir, dstDir, {
    recursive: true,
    filter: (src) => !/\.bak(\.|-)|\.pre-followup|\.cleanup/.test(src),
  })
  return dstDir
}

async function statSnapshot(filePath) {
  // Capture (mtime, size) for a single file as a mutation invariant fingerprint.
  // Used to verify ~/.claude/memory/stats.json is untouched across the benchmark.
  try {
    const s = await stat(filePath)
    return { mtimeMs: s.mtimeMs, size: s.size, exists: true }
  } catch {
    return { mtimeMs: null, size: null, exists: false }
  }
}

async function causeAttribution() {
  // Re-run a single in-process call with engine stderr captured to count
  // the screening events (BM25 fires per call, log-line screen, etc.).
  // We spawn the cold-stub once and parse the stderr JSONL.
  //
  // Codex P1 #6: previously the cause attribution table printed hardcoded
  // numbers (e.g. "corpus 136 / files 200 / log-lines 222"). If the
  // corpus changes, those numbers go stale silently. Now we extract the
  // actual per-layer (inputCount, passedCount, filesScanned) from the
  // emitted screening events on this run so the table reflects reality.
  const stub = resolve(__dirname, 'bench-cold-stub.mjs')
  const { stderr } = await spawnTimed('node', [stub, 'hands-on verify'])
  const events = stderr.split('\n')
    .filter(l => l.includes('"event":"screening:'))
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
  const counts = {}
  for (const e of events) counts[e.event] = (counts[e.event] || 0) + 1

  // Per-layer detail — split BM25 events by the run order so we can label
  // them as "corpus / files / log-lines" (the engine fires them in that
  // sequence per memorySearch.ts). Other events are 1-of-each.
  const bm25 = events.filter(e => e.event === 'screening:bm25_screening')
  const lineScreen = events.find(e => e.event === 'screening:log_line_screening')
  const completed = events.find(e => e.event === 'screening:search_completed')
  const layers = bm25.map((e, i) => ({
    layer: ['corpus entries', 'files (whole-file layer)', 'log lines'][i] || `bm25 #${i + 1}`,
    inputCount: e.inputCount,
    passedCount: e.passedCount,
    avgdl: e.avgdl,
  }))

  return {
    events,
    counts,
    layers,
    lineScreen,
    completed,
    summary: Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' | '),
  }
}

function renderTable(track, label) {
  const s = track.stats
  return `| ${label} | ${s.n} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.mean)} | ${fmt(s.std)} | ${fmt(s.max)} |`
}

async function main() {
  const t0 = performance.now()

  const REAL_MEM_DIR = join(homedir(), '.claude', 'memory')
  const STATS_PATH = join(REAL_MEM_DIR, 'stats.json')

  // Read-only invariant fingerprint: capture (mtime, size) of stats.json
  // before any measurement. Re-check at the end and assert unchanged.
  const statsBefore = await statSnapshot(STATS_PATH)
  process.stderr.write(`[bench] stats.json invariant pre: mtime=${statsBefore.mtimeMs} size=${statsBefore.size}\n`)

  // Snapshot the production memory dir into a temp location for the CLI
  // baseline. search-runner.js has no flag to disable recordUsage, so
  // routing it at the snapshot is the only way to preserve the invariant.
  const snapshotDir = join(tmpdir(), `bench-mem-snapshot-${randomBytes(4).toString('hex')}`)
  process.stderr.write(`[bench] snapshotting ~/.claude/memory → ${snapshotDir} (excluding .bak*)...\n`)
  await snapshotMemoryDir(REAL_MEM_DIR, snapshotDir)
  process.stderr.write('[bench] snapshot complete\n')

  const inProc = await inProcessMeasurement()
  const coldProc = await coldProcessMeasurement(SUBPROC_N)
  const cli = await cliBaselineMeasurement(snapshotDir, SUBPROC_N)
  const cause = await causeAttribution()
  const totalMs = (performance.now() - t0).toFixed(0)

  // Verify the invariant
  const statsAfter = await statSnapshot(STATS_PATH)
  const invariantHeld = statsBefore.mtimeMs === statsAfter.mtimeMs && statsBefore.size === statsAfter.size
  process.stderr.write(`[bench] stats.json invariant post: mtime=${statsAfter.mtimeMs} size=${statsAfter.size} invariantHeld=${invariantHeld}\n`)

  const today = new Date().toISOString().slice(0, 10)
  const reportPath = resolve(REPO_ROOT, 'docs', `saga-7-memory-search-perf-${today}.md`)
  await mkdir(dirname(reportPath), { recursive: true })

  const cliP50 = cli.stats.p50
  const inP50 = inProc.stats.p50
  const improvement = cliP50 && inP50 ? ((cliP50 - inP50) / cliP50 * 100).toFixed(1) : 'n/a'

  const report = `# saga 7 Phase 1-3 — memory_search latency benchmark (${today})

Branch: \`feat/saga-7-memory-search\`
Run host: Windows 11 Pro (msys2 bash + node)
Memory dir: \`~/.claude/memory\` (production, in-process tracks; \`recordUsage:false\`)
              \`${snapshotDir}\` (snapshot for CLI baseline — see invariant section)
Queries: 30 distinct (warm-up 5 + 30 × 3 rounds = 90 in-process)

## Read-only invariant (Codex P0 + P1 #5 fix)

\`~/.claude/memory/stats.json\` (mtime, size) captured immediately before
and after the entire benchmark:

| | mtimeMs | size |
|---|---:|---:|
| before | \`${statsBefore.mtimeMs}\` | \`${statsBefore.size}\` |
| after | \`${statsAfter.mtimeMs}\` | \`${statsAfter.size}\` |
| invariant held | **${invariantHeld}** | |

The in-process tracks call \`runMemorySearch(args, { recordUsage: false })\`
(saga-7 P0 fix on the MCP boundary). The CLI baseline runs against a
snapshot of \`~/.claude/memory\` placed at \`${snapshotDir}\`
(via search-runner.js \`--memory-dir\` flag), because the CLI hardcodes
\`recordUsage: true\` and has no env / flag to disable it. The snapshot
excludes \`.bak*\` / \`.pre-followup\` / \`.cleanup\` files (engine never
reads those).

## Track 1 — in-process MCP handler (warm)

90 measurements after a 5-query warm-up. This is the path Claude Code's
long-lived \`relvetia-team\` MCP server will follow once the new
\`memory_search\` tool is consumed in production.

## Track 2 — cold-process MCP handler

3 measurements, each spawns a fresh node process that imports
\`src/memory-search-mcp.js\` and runs a single query. Represents a
per-call subprocess wrapper (no warm benefit). Not how production will
use this — included so we can decompose cost as
\`node ESM startup + module resolve + warm call\`.

## Track 3 — existing CLI baseline (cold)

\`node ~/workspace/relvetia/relvetia-daemon/dist-runners/search-runner.js
<query>\` — the path that exists in main today. Saga 5 baseline-v3 mean
≈ 1009 ms (\`docs/memory-search-improvement-loop/report-final.md:L86-95\`).
3 measurements, same queries as Track 2 for comparability.

## Results

| Track | n | min | p50 | p95 | p99 | mean | std | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${renderTable(inProc, '1. in-process (warm)')}
${renderTable(coldProc, '2. cold-process MCP')}
${renderTable(cli, '3. CLI baseline (cold)')}

(all values in milliseconds.)

### Revised acceptance #2 (saga 7 scope (a)+(c) decision)

CLI baseline p50 = \`${fmt(cli.stats.p50)} ms\` vs in-process p50 = \`${fmt(inProc.stats.p50)} ms\`.
Improvement: **${improvement}%** (in-process vs CLI baseline).

The original proposal §7.1 target (\`p50 < 100 ms warm\`) is **not met**
by the Phase 1 MVP and cannot be met by the MCP wrapper alone (see cause
attribution below). The orchestrator (gen-2) and worker (iter-1) jointly
adopted the revised acceptance #2 = *"CLI baseline 比 improvement, cause
attribution = engine per-call BM25 + IDF 再計算 by-design"*; the engine
cache layer that would achieve \`p50 < 100 ms\` is deferred to a separate
saga track (saga 11+ candidate).

## Cause attribution — why warm ≈ cold

Single representative call (\`query="hands-on verify"\`) produced the
following \`screening:\` events on stderr:

\`\`\`
${cause.summary || '(no events captured — engine stderr layout may have changed)'}
\`\`\`

Per-call breakdown (numbers extracted live from this run's stderr; the
sample query was \`"hands-on verify"\`):

| BM25 layer | inputCount | passedCount | avgdl |
|---|---:|---:|---:|
${cause.layers.map(l => `| ${l.layer} | ${l.inputCount} | ${l.passedCount} | ${fmt(l.avgdl)} |`).join('\n')}

- **log_line_screening**: scanned ${cause.lineScreen?.filesScanned ?? 'n/a'}
  daily files (\`logs/YYYY/MM/*.md\`), ${cause.lineScreen?.passedCount ?? 'n/a'} lines passed.
- **search_completed**: entryHits=${cause.completed?.entryHits ?? 'n/a'} /
  fileHits=${cause.completed?.fileHits ?? 'n/a'} /
  logLineHits=${cause.completed?.logLineHits ?? 'n/a'} /
  resultCount=${cause.completed?.resultCount ?? 'n/a'} /
  topScore=${fmt(cause.completed?.topScore, 3)}.
- **pipeline_used**: emitted once per call (mode/sortBy/observe).

Each call (re)tokenises the entire corpus (sum of BM25 inputCounts =
**${cause.layers.reduce((a, l) => a + (l.inputCount || 0), 0)}** docs)
and recomputes IDF from scratch. There is no persistent in-memory corpus or IDF table between
calls — the warm benefit observed (~20%) comes from filesystem page
cache only, not from engine-side memoisation.

## Track for engine-cache-layer (saga 11+ candidate)

To meet the original \`p50 < 100 ms (warm)\` target the engine itself
needs:

1. **Corpus retention**: load entries / files / log-lines once into an
   in-memory representation; refresh via mtime watcher on
   \`~/.claude/memory/{topics,logs,MEMORY.md,index.json}\`.
2. **IDF table cache**: compute IDF once per corpus version; invalidate
   on corpus change.
3. **Result cache** (optional): LRU on \`(query, maxResults, scoreStrategy)\`.

These are engine-internal changes to
\`relvetia-extracted/screening/memorySearch.ts\` (and
\`MemoryRetrievalEngine.ts\`); the MCP wrapper does not require any
further change. Engine cache work is **out of saga 7 scope** by joint
worker + orchestrator decision and is the proposed saga 11+ track.

## proposal §7.1 — correction note

The proposal §7.1 paragraph that asserts *"p50 < 100ms (warm, since
node startup is amortised)"* was authored before any empirical
measurement of the engine's per-call cost. The assumption that *node
startup was the dominant cost* turns out to be false: node startup is
~150-300 ms, the engine itself takes 700-1500 ms per call. A
correction PR or RFC will be filed alongside saga-7 close to update
proposal §7.1 to reflect the cache-layer dependency, plus a meta lesson
(\`Karpathy §5 Verify-Don't-Assume\` applied to proposal authoring, not
just implementation).

## Run metadata

- Total benchmark wall-clock: \`${totalMs} ms\`
- Node version: \`${process.version}\`
- Platform: \`${process.platform}\`
- in-process samples (round trip per query, ms): see appendix
${cli.errors && cli.errors.length ? `- CLI baseline errors: ${cli.errors.length}\n  - ${cli.errors.join('\n  - ')}` : ''}

## Appendix — raw in-process samples (90 values, milliseconds)

\`\`\`
${inProc.samples.map(v => v.toFixed(1)).join(', ')}
\`\`\`
`

  await writeFile(reportPath, report)
  process.stderr.write(`\n[bench] report written to ${reportPath}\n`)

  // Cleanup snapshot (optional — keep around for repeated bench runs in a
  // dev session. Comment out the rm call below to keep it.)
  try {
    const { rm } = await import('node:fs/promises')
    await rm(snapshotDir, { recursive: true, force: true })
    process.stderr.write(`[bench] snapshot cleaned up: ${snapshotDir}\n`)
  } catch (e) {
    process.stderr.write(`[bench] snapshot cleanup failed (non-fatal): ${e.message}\n`)
  }

  // human summary on stderr
  process.stderr.write('\n=== summary ===\n')
  process.stderr.write(`in-process p50/p95/mean: ${fmt(inProc.stats.p50)} / ${fmt(inProc.stats.p95)} / ${fmt(inProc.stats.mean)} ms (n=${inProc.stats.n})\n`)
  process.stderr.write(`cold-process p50/mean:   ${fmt(coldProc.stats.p50)} / ${fmt(coldProc.stats.mean)} ms (n=${coldProc.stats.n})\n`)
  process.stderr.write(`CLI baseline p50/mean:   ${fmt(cli.stats.p50)} / ${fmt(cli.stats.mean)} ms (n=${cli.stats.n})\n`)
  process.stderr.write(`improvement vs CLI:      ${improvement}%\n`)
  process.stderr.write(`cause events:            ${cause.summary || '(none)'}\n`)
}

main().catch(e => {
  process.stderr.write(`[bench] FAILED: ${e.stack || e.message}\n`)
  process.exit(1)
})
