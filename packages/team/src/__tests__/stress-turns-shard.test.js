// stress-turns-shard.test.js — Step 3a impact measurement
//
// Measures recordTurn latency for n different agents firing concurrently.
// Pre-shard, all writes contended on a single turn-counts.json lock; with
// per-agent shards each agent has its own lock so concurrent writes scale
// linearly (no contention). This test records the post-shard baseline.
//
// Compare against `stress-parallel.test.js` (mailbox single-target inbox)
// which is still the bottleneck (Step 3b mailbox JSONL is the next step).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createTeam } from '../team.js'
import { recordTurn, getTurnCounts } from '../turns.js'

const TEAM = '__test-stress-turns-shard__'
const TMP = join(process.cwd(), '.test-tmp-stress-turns-shard')
const origDir = process.env.CLAUDE_CONFIG_DIR

before(() => { process.env.CLAUDE_CONFIG_DIR = TMP })
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => { await rm(TMP, { recursive: true, force: true }) })

function pct(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]
}

async function timeIt(fn) {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

describe('stress: parallel recordTurn across N different agents (Step 3a shard)', { concurrency: false }, () => {
  for (const n of [8, 16]) {
    it(`n=${n} concurrent recordTurn on distinct agents`, async () => {
      const members = Array.from({ length: n }, (_, i) => ({ name: `agent-${i}`, role: 'worker' }))
      await createTeam(TEAM, members)
      const latencies = await Promise.all(
        Array.from({ length: n }, (_, i) => timeIt(() => recordTurn(TEAM, `agent-${i}`)))
      )
      const counts = await getTurnCounts(TEAM)
      const p50 = pct(latencies, 0.5)
      const p95 = pct(latencies, 0.95)
      const p99 = pct(latencies, 0.99)
      const max = Math.max(...latencies)
      console.log(`[stress-turns n=${n}] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms`)
      assert.equal(Object.keys(counts).length, n, 'all N agents have a shard')
      for (let i = 0; i < n; i++) {
        assert.equal(counts[`agent-${i}`], 1, `agent-${i} count == 1`)
      }
      assert.ok(p99 < 5000, `p99 ${p99.toFixed(1)}ms exceeds 5s ceiling`)
    })
  }
})
