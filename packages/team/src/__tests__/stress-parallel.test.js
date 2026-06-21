// stress-parallel.test.js — parallel writeToMailbox latency + regression guard
//
// Measures p50/p95/p99 latency for n concurrent writeToMailbox calls targeting
// a single agent (the team-lead bottleneck pattern where many reviewers all
// report to team-lead in parallel).
//
// History:
//   - Step 2 baseline (JSON-array under proper-lockfile):
//       n=8  p99 = 334ms
//       n=16 p99 = 1259ms (lock contention dominant)
//   - Step 3b (JSONL append-only, lock-free fast path):
//       n=8  p99 ≈ 18ms (~18× faster)
//       n=16 p99 ≈ 28ms (~45× faster, well under ≤500ms target)
//
// Asserts integrity (no message loss) AND a 500ms p99 ceiling — if a future
// change re-introduces lock contention on the hot path, this test fails.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeToMailbox, readMailbox } from '../mailbox.js'

const TEAM = '__test-stress-parallel__'
const TARGET = 'team-lead'
const TMP = join(process.cwd(), '.test-tmp-stress-parallel')
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
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return sorted[idx]
}

async function timeIt(fn) {
  const t0 = performance.now()
  await fn()
  return performance.now() - t0
}

async function runConcurrent(n) {
  const latencies = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      timeIt(() => writeToMailbox(TEAM, TARGET, {
        from: `agent-${i}`,
        text: `stress msg from agent-${i}`,
        summary: 'stress',
      }))
    )
  )
  const msgs = await readMailbox(TEAM, TARGET)
  return { latencies, delivered: msgs.length }
}

describe('stress: parallel mailbox writes (single-agent bottleneck)', { concurrency: false }, () => {
  for (const n of [8, 16]) {
    it(`n=${n} concurrent writeToMailbox to ${TARGET}`, async () => {
      const { latencies, delivered } = await runConcurrent(n)
      const p50 = pct(latencies, 0.5)
      const p95 = pct(latencies, 0.95)
      const p99 = pct(latencies, 0.99)
      const max = Math.max(...latencies)
      console.log(`[stress n=${n}] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms max=${max.toFixed(1)}ms delivered=${delivered}/${n}`)
      assert.equal(delivered, n, 'all messages delivered (integrity)')
      // 500ms ceiling: post Step 3b JSONL append, n=16 typically lands ~30ms.
      // 500ms gives generous headroom for slow CI runners while still
      // catching a regression to the old read-modify-rewrite pattern (which
      // produced ~1259ms at n=16).
      assert.ok(p99 < 500, `p99 ${p99.toFixed(1)}ms exceeds 500ms regression ceiling (Step 3b expectation)`)
    })
  }

  it('integrity holds with pre-populated inbox (300 prior msgs + 16 concurrent)', async () => {
    // Validates the head-check fast path: an inbox with hundreds of prior
    // lines must still detect "ends with newline" cheaply (1 byte stat +
    // tail read), not by reading the whole file.
    for (let i = 0; i < 300; i++) {
      await writeToMailbox(TEAM, TARGET, {
        from: `seed-${i}`,
        text: `seed message ${i}`,
        summary: 'seed',
      })
    }
    const { latencies, delivered } = await runConcurrent(16)
    const p99 = pct(latencies, 0.99)
    console.log(`[stress prepop n=16] p99=${p99.toFixed(1)}ms delivered=${delivered}/316`)
    assert.equal(delivered, 316, 'all seeded + new messages survived')
    assert.ok(p99 < 500, `p99 ${p99.toFixed(1)}ms exceeds 500ms with pre-populated inbox`)
  })
})
