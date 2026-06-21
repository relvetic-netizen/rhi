# saga 7 Phase 1-3 — memory_search latency benchmark (2026-05-20)

Branch: `feat/saga-7-memory-search`
Run host: Windows 11 Pro (msys2 bash + node)
Memory dir: `~/.claude/memory` (production, in-process tracks; `recordUsage:false`)
              `<TEMP>\bench-mem-snapshot-42925a3d` (snapshot for CLI baseline — see invariant section)
Queries: 30 distinct (warm-up 5 + 30 × 3 rounds = 90 in-process)

## Read-only invariant (Codex P0 + P1 #5 fix)

`~/.claude/memory/stats.json` (mtime, size) captured immediately before
and after the entire benchmark:

| | mtimeMs | size |
|---|---:|---:|
| before | `1779242575161.301` | `15740` |
| after | `1779242575161.301` | `15740` |
| invariant held | **true** | |

The in-process tracks call `runMemorySearch(args, { recordUsage: false })`
(saga-7 P0 fix on the MCP boundary). The CLI baseline runs against a
snapshot of `~/.claude/memory` placed at `<TEMP>\bench-mem-snapshot-42925a3d`
(via search-runner.js `--memory-dir` flag), because the CLI hardcodes
`recordUsage: true` and has no env / flag to disable it. The snapshot
excludes `.bak*` / `.pre-followup` / `.cleanup` files (engine never
reads those).

## Track 1 — in-process MCP handler (warm)

90 measurements after a 5-query warm-up. This is the path Claude Code's
long-lived `relvetia-team` MCP server will follow once the new
`memory_search` tool is consumed in production.

## Track 2 — cold-process MCP handler

3 measurements, each spawns a fresh node process that imports
`src/memory-search-mcp.js` and runs a single query. Represents a
per-call subprocess wrapper (no warm benefit). Not how production will
use this — included so we can decompose cost as
`node ESM startup + module resolve + warm call`.

## Track 3 — existing CLI baseline (cold)

`node ~/workspace/relvetia/relvetia-daemon/dist-runners/search-runner.js
<query>` — the path that exists in main today. Saga 5 baseline-v3 mean
≈ 1009 ms (`docs/memory-search-improvement-loop/report-final.md:L86-95`).
3 measurements, same queries as Track 2 for comparability.

## Results

| Track | n | min | p50 | p95 | p99 | mean | std | max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1. in-process (warm) | 90 | 987.7 | 1008.9 | 1032.8 | 1146.7 | 1012.2 | 19.6 | 1146.7 |
| 2. cold-process MCP | 30 | 1248.3 | 1276.6 | 1367.7 | 1394.5 | 1281.3 | 28.9 | 1394.5 |
| 3. CLI baseline (cold) | 30 | 1239.5 | 1275.1 | 1378.0 | 1437.8 | 1281.5 | 36.3 | 1437.8 |

(all values in milliseconds.)

### Revised acceptance #2 (saga 7 scope (a)+(c) decision)

CLI baseline p50 = `1275.1 ms` vs in-process p50 = `1008.9 ms`.
Improvement: **20.9%** (in-process vs CLI baseline).

The original proposal §7.1 target (`p50 < 100 ms warm`) is **not met**
by the Phase 1 MVP and cannot be met by the MCP wrapper alone (see cause
attribution below). The orchestrator (gen-2) and worker (iter-1) jointly
adopted the revised acceptance #2 = *"CLI baseline 比 improvement, cause
attribution = engine per-call BM25 + IDF 再計算 by-design"*; the engine
cache layer that would achieve `p50 < 100 ms` is deferred to a separate
saga track (saga 11+ candidate).

## Cause attribution — why warm ≈ cold

Single representative call (`query="hands-on verify"`) produced the
following `screening:` events on stderr:

```
screening:bm25_screening:3 | screening:log_line_screening:1 | screening:search_completed:1 | screening:pipeline_used:1
```

Per-call breakdown (numbers extracted live from this run's stderr; the
sample query was `"hands-on verify"`):

| BM25 layer | inputCount | passedCount | avgdl |
|---|---:|---:|---:|
| corpus entries | 136 | 57 | 177.5 |
| files (whole-file layer) | 200 | 119 | 2331.1 |
| log lines | 225 | 98 | 160.0 |

- **log_line_screening**: scanned 3
  daily files (`logs/YYYY/MM/*.md`), 20 lines passed.
- **search_completed**: entryHits=12 /
  fileHits=20 /
  logLineHits=20 /
  resultCount=52 /
  topScore=3.912.
- **pipeline_used**: emitted once per call (mode/sortBy/observe).

Each call (re)tokenises the entire corpus (sum of BM25 inputCounts =
**561** docs)
and recomputes IDF from scratch. There is no persistent in-memory corpus or IDF table between
calls — the warm benefit observed (~20%) comes from filesystem page
cache only, not from engine-side memoisation.

## Track for engine-cache-layer (saga 11+ candidate)

To meet the original `p50 < 100 ms (warm)` target the engine itself
needs:

1. **Corpus retention**: load entries / files / log-lines once into an
   in-memory representation; refresh via mtime watcher on
   `~/.claude/memory/{topics,logs,MEMORY.md,index.json}`.
2. **IDF table cache**: compute IDF once per corpus version; invalidate
   on corpus change.
3. **Result cache** (optional): LRU on `(query, maxResults, scoreStrategy)`.

These are engine-internal changes to
`relvetia-extracted/screening/memorySearch.ts` (and
`MemoryRetrievalEngine.ts`); the MCP wrapper does not require any
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
(`Karpathy §5 Verify-Don't-Assume` applied to proposal authoring, not
just implementation).

## Run metadata

- Total benchmark wall-clock: `181796 ms`
- Node version: `v22.22.2`
- Platform: `win32`
- in-process samples (round trip per query, ms): see appendix


## Appendix — raw in-process samples (90 values, milliseconds)

```
1002.6, 1028.3, 1024.3, 1045.0, 1015.8, 1027.7, 1012.5, 1030.9, 1013.0, 1033.0, 1012.7, 1024.0, 1032.8, 1000.3, 1018.7, 1005.6, 1007.2, 1016.0, 990.6, 1019.5, 1000.4, 1010.3, 996.9, 987.7, 997.4, 997.3, 1009.5, 1026.4, 999.3, 1004.4, 997.0, 1013.5, 1004.4, 1004.2, 1006.9, 1013.4, 994.4, 1009.8, 993.3, 1007.3, 1005.4, 1011.3, 1020.0, 1003.7, 1008.4, 1027.6, 1146.7, 1089.9, 1026.8, 1019.2, 997.1, 1014.3, 1002.4, 1017.3, 1001.8, 1005.0, 1005.1, 1011.8, 1014.3, 1006.6, 1000.6, 1007.6, 1021.4, 994.8, 1005.4, 1004.4, 1007.9, 1003.4, 1005.1, 1005.1, 1012.3, 996.5, 1029.5, 1014.4, 1016.5, 996.4, 1011.1, 1010.3, 1010.9, 1008.4, 1010.3, 994.9, 1010.6, 1007.1, 1010.6, 997.1, 1008.1, 1008.9, 1013.6, 1003.1
```
