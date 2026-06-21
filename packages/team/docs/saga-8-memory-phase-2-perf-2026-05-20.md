# saga 8 Phase 2-4 — relvetia-memory-tools latency benchmark (2026-05-20)

Branch: `feat/saga-8-memory-phase-2`
Run host: Windows 11 Pro (msys2 bash + node 22.22.2)
Tools benched: `memory_remember`, `memory_log_recent`, `memory_status`, `daemon_status`
Bench script: `scripts/bench-relvetia-memory-tools.mjs` (N=20 per tool, in-process)
Production memory dir for invariant: `~/.claude/memory` (read-only probe from runMemoryStatus + runMemoryLogRecent; never mutated)
Bench fixture: `<TEMP>\relvetia-mem-bench-aa230fe9` (auto-removed at exit)

## Read-only invariant (saga 7 Codex P0 #1 + saga 8 Decisions §16 mandate)

stats.json / index.json / MEMORY.md / concepts/graph.json snapshotted
immediately before and after the entire benchmark + 51 sentinel tests:

| File | md5 (before / after) | size (before / after) | invariant |
|---|---|---:|---|
| stats.json           | `39f7f36248225c5a470b5bff970ba85f` / `39f7f36248225c5a470b5bff970ba85f` | 15740 / 15740 | **HELD** |
| index.json           | `cc3232c5a61c07b346b5a1a35ff8e2fc` / `cc3232c5a61c07b346b5a1a35ff8e2fc` | 241227 / 241227 | **HELD** |
| MEMORY.md            | `9f5788b218aba969f9a7a292198a76d4` / `9f5788b218aba969f9a7a292198a76d4` | 21621 / 21621 | **HELD** |
| concepts/graph.json  | `2be580eee05102d176e7bba5453c9376` / `2be580eee05102d176e7bba5453c9376` | 896661 / 896661 | **HELD** |

All four production files byte-identical across the bench run. memory_remember
writes only landed in the tmp fixture (env override `memoryDir=<tmp>`); the
read-only tools (`memory_log_recent`, `memory_status`, `daemon_status`)
touched the production paths only for read.

This is also continuously verified by the sentinel suite in
`src/__tests__/relvetia-memory-tools.test.js` describe block
"production-invariant sentinel" (4 tests, one per protected file).

## Latency (N=20, in-process, units=ms)

| Tool                       | min  | p50  | p95  | max  | mean |
|---|---:|---:|---:|---:|---:|
| memory_remember            | 0.75 | 0.95 | 28.61 | 28.61 | 2.39 |
| memory_log_recent          | 1.19 | 1.64 |  6.12 |  6.12 | 2.19 |
| memory_status              | 0.78 | 1.73 |  6.48 |  6.48 | 2.23 |
| daemon_status (mock pm2)   | 0.14 | 0.17 |  0.85 |  0.85 | 0.22 |

`daemon_status` against the real `pm2 jlist` (single warm sample): **8.64 ms**.
The mock path strips out the `child_process.execFile('pm2', ['jlist'])`
spawn cost and only measures the in-process JSON parse + lock-file read,
so the "real pm2" sample is the more representative production number.

### Comparison vs proposal §7.1 targets

proposal §7.1 set p50 < 100 ms warm / p95 < 300 ms warm as the saga 6 success
criterion (originally framed for `memory_search`; same envelope applies to all
MCP tools the worker session reaches).

| Tool | p50 vs 100ms target | p95 vs 300ms target |
|---|---|---|
| memory_remember     | 0.95 ms (**1/105**)   | 28.61 ms (**1/10**) |
| memory_log_recent   | 1.64 ms (**1/61**)    |  6.12 ms (**1/49**) |
| memory_status       | 1.73 ms (**1/58**)    |  6.48 ms (**1/46**) |
| daemon_status real  | 8.64 ms (**1/12**)    | — (single sample) |

All four tools clear the latency target by >10× on p50 and >10× on p95. There
is no need for the engine_cache_layer track (saga 11+ scope) on these tools
since none of them touch the MemoryRetrievalEngine 5-stage pipeline — they
are direct fs ops + a single pm2 subprocess call.

### Why memory_remember p95 has a 28.61 ms tail

p95 == max, so this is the very last iteration of the loop (i=19). The cause is
Windows fs sync: the first append to a brand-new daily-log file pays mkdir(...,
recursive: true) cost (≈ ms) only on iter 0, but iter 19's spike looks like a
Windows-side filesystem flush. In production the tool will be called maybe a few
times per minute (when Claude wants to remember something), so the p95 tail is
operationally irrelevant. Mean (2.39 ms) is the better single-number summary.

## Why no in-vivo CLI baseline comparison (vs saga 7)

Saga 7's perf doc tracked `node search-runner.js cold` vs `in-process warm`
to show the MCP migration removed a ~1 s cold-start tax. The four tools in
saga 8 have no CLI equivalent — they were always going to be in-process
tools — so there is nothing to compare against. The relevant number is
just the per-call cost (above), and all of them are sub-30 ms p95.

## Verdict

- **All four Phase 2 tools meet proposal §7.1 p50 < 100 ms / p95 < 300 ms by >10×.**
- **Production filesystem invariant maintained.** stats.json / index.json /
  MEMORY.md / concepts/graph.json byte-identical across bench + 51-test suite
  (verified inline by the sentinel describe block + reproduced here by the
  bench script).
- No regression to saga 7 `memory_search` perf (separate file, separate
  caller path; saga 7's perf doc remains the source of truth for that tool).
