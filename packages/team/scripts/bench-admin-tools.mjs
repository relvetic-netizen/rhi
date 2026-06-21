#!/usr/bin/env node
// Saga 9 Phase 3-4 benchmark — measures p50/p95 latency of the six admin
// tools and asserts the production memory 4-file invariant is maintained
// across the whole run (saga 8 §16 lived practice — hands-on capture).
//
// Usage:  node scripts/bench-admin-tools.mjs [N]
//         Default N=30 warm iterations per tool.
// Output: stdout JSON + a human-readable summary table.

import { mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import {
  runDistillMarkFired,
  runDistillStatus,
  runWalkerStatus,
  runScheduledTaskList,
  runScheduledTaskCreate,
  runScheduledTaskCancel,
} from '../src/relvetia-admin-tools.js'

const N = parseInt(process.argv[2] || '30', 10)
const WARMUP = 5  // discard the first 5 iterations to amortise JIT / fs cache

// ---------------------------------------------------------------------------
// Production-invariant baseline
// ---------------------------------------------------------------------------
const PROD = join(homedir(), '.claude', 'memory')
const PROTECTED_FILES = ['stats.json', 'index.json', 'MEMORY.md', 'concepts/graph.json']

async function captureInvariant(path) {
  try {
    const buf = await readFile(path)
    const s = await stat(path)
    return {
      md5: createHash('md5').update(buf).digest('hex'),
      size: s.size,
      mtime: s.mtimeMs,
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

async function captureProdBaseline() {
  const out = {}
  for (const rel of PROTECTED_FILES) {
    out[rel] = await captureInvariant(join(PROD, rel))
  }
  return out
}

// ---------------------------------------------------------------------------
// Fixture daemon dir
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(tmpdir(), `bench-admin-${randomBytes(4).toString('hex')}`)

async function buildFixture() {
  const daemonDir = join(FIXTURE_ROOT, 'daemon')
  await mkdir(join(daemonDir, '.claude'), { recursive: true })
  // 3 STATIC_PERMANENT_TASKS + 1 walker + 2 user tasks
  const baseTime = Date.now() - 24 * 3600 * 1000  // 1 day ago
  const tasks = [
    { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'distill body', createdAt: baseTime, lastFiredAt: baseTime + 1000, recurring: true, permanent: true },
    { id: 'relvetia-verify', cron: '30 3 * * *', prompt: 'verify body', createdAt: baseTime, lastFiredAt: baseTime + 2000, recurring: true, permanent: true },
    { id: 'relvetia-optimize', cron: '0 4 * * 0', prompt: 'optimize body', createdAt: baseTime, recurring: true, permanent: true },
    { id: 'persona-walker-x', cron: '0 9 * * *', prompt: '<native:runWalker:persona-walker-x>', createdAt: baseTime, lastFiredAt: baseTime + 3000, recurring: true, permanent: true, nativeHandler: 'runWalker' },
    { id: 'user-task-1', cron: '*/15 * * * *', prompt: 'periodic check', createdAt: baseTime, recurring: true },
    { id: 'user-task-2', cron: '0 12 * * *', prompt: 'noon report', createdAt: baseTime, recurring: true },
  ]
  await writeFile(
    join(daemonDir, '.claude', 'scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2) + '\n',
  )
  // walker schedule
  const schedulePath = join(daemonDir, 'persona', 'walkers', 'schedule.json')
  await mkdir(join(daemonDir, 'persona', 'walkers'), { recursive: true })
  await writeFile(schedulePath, JSON.stringify({
    walkers: { 'persona-walker-x': { enabled: true, schedule: ['09:00'], note: 'curiosity loop' } },
  }))
  return { daemonDir, schedulePath }
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p / 100) - 1)
  return sorted[Math.max(0, idx)]
}

function summary(name, samples) {
  const s = samples.slice(WARMUP)  // discard warmup
  return {
    name,
    n: s.length,
    p50_ms: Number(percentile(s, 50).toFixed(3)),
    p95_ms: Number(percentile(s, 95).toFixed(3)),
    mean_ms: Number((s.reduce((a, b) => a + b, 0) / s.length).toFixed(3)),
    min_ms: Number(Math.min(...s).toFixed(3)),
    max_ms: Number(Math.max(...s).toFixed(3)),
  }
}

async function bench(name, fn) {
  const samples = []
  for (let i = 0; i < N + WARMUP; i++) {
    const t0 = process.hrtime.bigint()
    await fn(i)
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)  // ns → ms
  }
  return summary(name, samples)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const baselineProd = await captureProdBaseline()
const { daemonDir, schedulePath } = await buildFixture()

const results = []

// Read-only tools — no fixture mutation between iterations
results.push(await bench('distill_status', async () =>
  await runDistillStatus({}, { daemonDir })))

results.push(await bench('walker_status', async () =>
  await runWalkerStatus({}, { daemonDir, schedulePath })))

results.push(await bench('scheduled_task_list', async () =>
  await runScheduledTaskList({}, { daemonDir })))

// distill_mark_fired with force=true (always proceeds, mutates lastFiredAt).
// Fixture restored each iteration to keep work bounded.
const tasksPath = join(daemonDir, '.claude', 'scheduled_tasks.json')
const baseFile = await readFile(tasksPath, 'utf-8')
results.push(await bench('distill_mark_fired', async (i) => {
  await writeFile(tasksPath, baseFile)
  await runDistillMarkFired({ force: true }, { daemonDir, now: Date.now() })
}))

// scheduled_task_create + cancel round-trip per iteration (each call
// touches the file). N create + N cancel measured separately.
results.push(await bench('scheduled_task_create', async (i) => {
  await runScheduledTaskCreate(
    { cron: '0 9 * * *', prompt: `bench-${i}` },
    { daemonDir, idGen: () => `bench${String(i).padStart(4, '0')}` },
  )
}))

// Now cancel each created task — reuse the create from above
results.push(await bench('scheduled_task_cancel', async (i) => {
  await runScheduledTaskCancel({ id: `bench${String(i).padStart(4, '0')}` }, { daemonDir })
}))

// Restore baseline file so production has no chance of contamination
await writeFile(tasksPath, baseFile)

const finalProd = await captureProdBaseline()
let prodIntact = true
const prodDelta = {}
for (const rel of PROTECTED_FILES) {
  const before = baselineProd[rel]
  const after = finalProd[rel]
  if (before === null && after === null) {
    prodDelta[rel] = 'absent (unchanged)'
  } else if (before === null || after === null) {
    prodIntact = false
    prodDelta[rel] = `EXISTENCE DRIFT: before=${before ? 'present' : 'absent'} after=${after ? 'present' : 'absent'}`
  } else {
    const md5Match = before.md5 === after.md5
    const sizeMatch = before.size === after.size
    const mtimeMatch = Math.abs(before.mtime - after.mtime) < 1
    const matched = md5Match && sizeMatch && mtimeMatch
    if (!matched) prodIntact = false
    prodDelta[rel] = matched
      ? `md5=${before.md5.slice(0, 8)}.. size=${before.size} mtime invariant ✓`
      : `DRIFT: md5=${md5Match ? '✓' : '✗'} size=${sizeMatch ? '✓' : '✗'} mtime=${mtimeMatch ? '✓' : '✗'}`
  }
}

await rm(FIXTURE_ROOT, { recursive: true, force: true })

console.log(JSON.stringify({
  n: N,
  warmup: WARMUP,
  results,
  production_invariant: { intact: prodIntact, details: prodDelta },
}, null, 2))

console.log('\n# Latency table (ms; warmup of', WARMUP, 'iterations discarded)')
console.log('| Tool                    |   p50 |   p95 |  mean |   min |   max |  N |')
console.log('|-------------------------|------:|------:|------:|------:|------:|---:|')
for (const r of results) {
  const pad = (s, n) => String(s).padStart(n)
  console.log(`| ${r.name.padEnd(23)} | ${pad(r.p50_ms, 5)} | ${pad(r.p95_ms, 5)} | ${pad(r.mean_ms, 5)} | ${pad(r.min_ms, 5)} | ${pad(r.max_ms, 5)} | ${pad(r.n, 2)} |`)
}
console.log('\n# Production filesystem invariant — INTACT:', prodIntact)
for (const rel of PROTECTED_FILES) {
  console.log(`  ${rel.padEnd(22)} ${prodDelta[rel]}`)
}

process.exit(prodIntact ? 0 : 1)
