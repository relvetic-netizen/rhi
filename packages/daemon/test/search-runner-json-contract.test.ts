// Phase 3 T3 — CLI snapshot contract for search-runner JSON output.
//
// search-runner.ts (relvetia-daemon/src/) is the canonical CLI entry for
// screening-aware memory search. It re-exports executeMemorySearch from
// extracted/tools/MemorySearchTool and serialises the result via
// `JSON.stringify(result, null, 2)` (search-runner.ts:63).
//
// Phase 3 T2 extended MemorySearchOutput with the entry-centric `hits` field
// alongside legacy `results`. Because search-runner pipes the whole result
// through JSON.stringify, the dual-output reaches external CLI consumers
// automatically — but nothing tested that contract until now.
//
// This snapshot test pins the JSON shape so any future field rename or
// removal breaks loudly on CI rather than silently breaking downstream
// consumers (the eval framework, ad-hoc scripts, the perpetual-orchestrator
// inbox-runner) that parse the CLI's JSON output.

import { mkdtemp, mkdir, writeFile, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { afterEach, describe, expect, it } from 'vitest'

const RUNNER_PATH = join(__dirname, '..', 'dist-runners', 'search-runner.js')

let tempDirs: string[] = []

async function setupMemoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-search-runner-'))
  tempDirs.push(dir)

  // Minimal index.json with one entry whose summary/concepts match the query.
  const entry = {
    id: 'pref_001',
    summary: 'User prefers bun over npm for package management',
    sources: ['logs/2026/05/2026-05-18.md:L1'],
    concepts: ['bun', 'package-manager', 'preference'],
    topic: 'preferences',
    updated: '2026-05-18',
    confidence: 1,
  }
  await writeFile(
    join(dir, 'index.json'),
    JSON.stringify({ version: 1, entries: { pref_001: entry } }),
  )
  // Topic file for the file-layer to surface a matching path.
  await mkdir(join(dir, 'topics'), { recursive: true })
  await writeFile(
    join(dir, 'topics', 'preferences.md'),
    '# preferences\n\nUser prefers bun over npm for package management.\n',
  )
  return dir
}

function runSearchRunner(
  memoryDir: string,
  query: string,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [RUNNER_PATH, query, '--memory-dir', memoryDir, '--json', ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d.toString('utf8') })
    proc.stderr.on('data', d => { stderr += d.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`search-runner exited ${code}\nstderr: ${stderr}\nstdout: ${stdout}`))
        return
      }
      // Saga 10 Phase 4 revC P1 #2: surface stderr so the deprecation-WARN
      // sentinel below can guard line 1 of stderr without re-running the
      // child process. Prior shape was { stdout, code } only.
      resolve({ stdout, stderr, code })
    })
  })
}

afterEach(async () => {
  for (const dir of tempDirs) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      /* best-effort tmp cleanup */
    }
  }
  tempDirs = []
})

describe('search-runner JSON contract', () => {
  it('--json output contains both legacy `results` and entry-centric `hits` fields', async () => {
    const memoryDir = await setupMemoryDir()
    const { stdout } = await runSearchRunner(memoryDir, 'bun package manager')

    const parsed = JSON.parse(stdout)

    // Dual-output contract: both keys must exist on the top-level object.
    expect(parsed).toHaveProperty('results')
    expect(parsed).toHaveProperty('hits')
    expect(Array.isArray(parsed.results)).toBe(true)
    expect(Array.isArray(parsed.hits)).toBe(true)

    // Legacy `results` entry shape (back-compat for pre-T2 consumers).
    if (parsed.results.length > 0) {
      const r = parsed.results[0]
      expect(r).toHaveProperty('path')
      expect(r).toHaveProperty('snippet')
      expect(r).toHaveProperty('score')
      expect(typeof r.path).toBe('string')
      expect(typeof r.score).toBe('number')
    }

    // Entry-centric `hits` entry shape (new in T2, consumed in T3+).
    if (parsed.hits.length > 0) {
      const h = parsed.hits[0]
      expect(h).toHaveProperty('entryId')
      expect(h).toHaveProperty('summary')
      expect(h).toHaveProperty('topic')
      expect(h).toHaveProperty('topicPath')
      expect(h).toHaveProperty('sources')
      expect(h).toHaveProperty('score')
      expect(h).toHaveProperty('updated')
      expect(h).toHaveProperty('confidence')
      expect(typeof h.entryId).toBe('string')
      expect(Array.isArray(h.sources)).toBe(true)
    }
  })

  it('--json output is valid JSON parseable in one shot (no banner/log lines on stdout)', async () => {
    const memoryDir = await setupMemoryDir()
    const { stdout } = await runSearchRunner(memoryDir, 'bun')

    // Should parse cleanly on first try — if any log line leaked to stdout the
    // CLI contract is broken for downstream consumers piping into `jq`.
    expect(() => JSON.parse(stdout)).not.toThrow()
  })

  // Saga 10 Phase 4 revC P1 #2: stderr line 1 sentinel for the deprecation
  // WARN added in commit 4ada68a. Prior to revC the existing snapshot tests
  // discarded stderr on success, so a future regression that removed the
  // WARN or moved it past line 1 would pass silently. This test pins:
  //   (a) stderr line 1 is the exact WARN string we emit at main() startup
  //   (b) stdout still parses as one-shot JSON (the WARN must go to stderr
  //       only — Lesson §14 contract atomic sync: deprecation WARN on stderr,
  //       JSON on stdout, no mixing).
  // It also serves as a build-time canary: if dist-runners/search-runner.js
  // is rebuilt from a source that lost the WARN, this test fails loud.
  it('--json startup emits the deprecation WARN on stderr line 1, leaves stdout JSON-clean (revC P1 #2)', async () => {
    const memoryDir = await setupMemoryDir()
    const { stdout, stderr } = await runSearchRunner(memoryDir, 'bun')

    const firstStderrLine = stderr.split(/\r?\n/)[0]
    expect(firstStderrLine).toBe(
      '[deprecated] bash CLI search-runner is deprecated. Use mcp__relvetia-team__memory_search instead.',
    )

    // stdout must remain machine-parseable in one shot — the WARN must not
    // have leaked across (the design intent is `--json` stays pipe-safe).
    expect(() => JSON.parse(stdout)).not.toThrow()
  })

  // Saga 14 — Path C Bash CLI recordUsage propagation fix sentinel ×3.
  //
  // Lineage: saga 7 pinned the MCP boundary to `recordUsage: false`
  // (memory-search-mcp.js:96-97) so every call through the MCP tool stays
  // read-only against production stats.json. Path C — the Bash CLI runner
  // here — was not part of that fix and remained at `executeMemorySearch`'s
  // internal default of `recordUsage ?? true`, leaving production stats.json
  // mutable from any CLI fire (observed in QA 2026-05-21 as a 1-byte md5
  // drift on stats.json with the other 3 memory files invariant).
  //
  // Saga 14 flips the CLI default to false (read-only) and exposes an
  // explicit `--record-usage` opt-in flag for callers that legitimately want
  // legacy fire-and-forget stats writes (background indexer, dogfood scripts).
  //
  // sentinel 1 (default false): no flag → no stats.json mutation
  // sentinel 2 (opt-in true):   --record-usage → stats.json gets written
  // sentinel 3 (argv variant):  --record-usage works regardless of position
  //                             relative to --memory-dir / --json / query
  describe('saga 14 — --record-usage opt-in flag (Path C recordUsage propagation fix)', () => {
    // All three sentinels use the 3-token query 'bun package manager' which
    // screens through against the seeded preferences.md topic (verified by
    // hand: single-token 'bun' falls below the screening threshold even with
    // the matching topic file, multi-token survives screening with score
    // ~0.024). A non-empty result set is required for sentinel 2/3 because
    // executeMemorySearch only fires recordHits when `projected.length > 0`
    // (MemorySearchTool.ts L179).
    const SEED_QUERY = 'bun package manager'

    it('sentinel 1: default (no --record-usage flag) → stats.json NOT created (read-only)', async () => {
      const memoryDir = await setupMemoryDir()
      const statsPath = join(memoryDir, 'stats.json')

      // Pre-condition: setupMemoryDir doesn't seed stats.json, so file absent.
      expect(existsSync(statsPath)).toBe(false)

      const { stdout } = await runSearchRunner(memoryDir, SEED_QUERY)
      const parsed = JSON.parse(stdout)
      // True-positive guard: a non-empty result set proves the recordHits
      // gate (projected.length > 0) would fire IF recordUsage were true.
      // Without this guard sentinel 1 could pass for the wrong reason
      // (empty results → recordHits skipped → stats.json absent regardless
      // of recordUsage flag value), which would silently hide a regression
      // that flipped the default back to true.
      expect(parsed.results.length).toBeGreaterThan(0)

      // Give the fire-and-forget recordHits promise a chance to schedule —
      // it would write stats.json synchronously after a microtask if
      // recordUsage were true. Since we expect default false, stats.json
      // must still be absent.
      await new Promise(r => setTimeout(r, 500))
      expect(existsSync(statsPath)).toBe(false)
    })

    it('sentinel 2: --record-usage → stats.json IS created (legacy fire-and-forget enabled)', async () => {
      const memoryDir = await setupMemoryDir()
      const statsPath = join(memoryDir, 'stats.json')

      expect(existsSync(statsPath)).toBe(false)

      const { stdout } = await runSearchRunner(memoryDir, SEED_QUERY, ['--record-usage'])
      const parsed = JSON.parse(stdout)
      expect(parsed).toHaveProperty('results')
      // recordHits only fires when projected.length > 0 (MemorySearchTool.ts L179).
      expect(parsed.results.length).toBeGreaterThan(0)

      // Wait for the fire-and-forget recordHits write to land. recordHits is
      // promise-based but unawaited; 500ms is generous on a local tmpfs.
      await new Promise(r => setTimeout(r, 500))
      expect(existsSync(statsPath)).toBe(true)
      const s = await stat(statsPath)
      expect(s.size).toBeGreaterThan(0)
    })

    it('sentinel 3: --record-usage flag works regardless of argv position (boundary)', async () => {
      // The argv parser splices flags out one at a time. Verify --record-usage
      // is detected and respected whether placed leading, middle, or trailing
      // relative to other flags. Each invocation gets a fresh tmpdir so
      // sentinel-2-style stats.json presence proves the flag took effect.
      const positions = ['leading', 'middle', 'trailing'] as const
      for (const pos of positions) {
        const memoryDir = await setupMemoryDir()
        const statsPath = join(memoryDir, 'stats.json')
        expect(existsSync(statsPath)).toBe(false)

        let args: string[]
        if (pos === 'leading') {
          args = ['--record-usage']
        } else if (pos === 'middle') {
          args = ['--record-usage', '--max-results', '5']
        } else {
          args = ['--max-results', '5', '--record-usage']
        }

        const { stdout } = await runSearchRunner(memoryDir, SEED_QUERY, args)
        const parsed = JSON.parse(stdout)
        expect(parsed.results.length).toBeGreaterThan(0)

        await new Promise(r => setTimeout(r, 500))
        expect(existsSync(statsPath), `stats.json must be written when --record-usage at ${pos} position`).toBe(true)
      }
    })
  })
})
