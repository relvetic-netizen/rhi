#!/usr/bin/env node
// Saga 8 Phase 2-4 benchmark — measure in-process latency of the four new
// relvetia-memory-tools (memory_remember, memory_log_recent, memory_status,
// daemon_status) against a tmp fixture so the user's real ~/.claude/memory
// is never mutated. Reports p50 / p95 / mean / min / max for N=20 per tool.
//
// Usage:  node scripts/bench-relvetia-memory-tools.mjs
//
// Output: markdown-friendly table to stdout. Stat snapshot + invariants
// against $HOME/.claude/memory/{stats,index,MEMORY,concepts/graph}.json
// captured before and after the run so the report can include the
// production-invariant evidence.

import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { hrtime } from 'node:process'

import {
  runMemoryRemember,
  runMemoryLogRecent,
  runMemoryStatus,
  runDaemonStatus,
} from '../src/relvetia-memory-tools.js'

const TMP = join(tmpdir(), 'relvetia-mem-bench-' + randomBytes(4).toString('hex'))

async function md5OfFile(path) {
  try { return createHash('md5').update(await readFile(path)).digest('hex') }
  catch (e) { return e?.code === 'ENOENT' ? null : `<error:${e.code}>` }
}
async function sizeOfFile(path) {
  try { return (await stat(path)).size }
  catch (e) { return e?.code === 'ENOENT' ? null : `<error:${e.code}>` }
}

async function snapshotProduction() {
  const PROD = join(homedir(), '.claude', 'memory')
  const files = ['stats.json', 'index.json', 'MEMORY.md', 'concepts/graph.json']
  const snap = {}
  for (const rel of files) {
    const p = join(PROD, rel)
    snap[rel] = { md5: await md5OfFile(p), size: await sizeOfFile(p) }
  }
  return snap
}

function nowNs() { return hrtime.bigint() }
function nsToMs(ns) { return Number(ns) / 1_000_000 }

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const p = pct => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * pct))]
  const sum = samples.reduce((a, b) => a + b, 0)
  return {
    n: samples.length,
    min: sorted[0].toFixed(2),
    p50: p(0.50).toFixed(2),
    p95: p(0.95).toFixed(2),
    max: sorted[sorted.length - 1].toFixed(2),
    mean: (sum / samples.length).toFixed(2),
  }
}

async function timeIt(fn, n) {
  const samples = []
  for (let i = 0; i < n; i++) {
    const t0 = nowNs()
    await fn(i)
    samples.push(nsToMs(nowNs() - t0))
  }
  return summarize(samples)
}

async function main() {
  console.log('# Saga 8 Phase 2-4 — relvetia-memory-tools benchmark')
  console.log(`Date: ${new Date().toISOString()}`)
  console.log(`Tmp fixture: ${TMP}`)
  console.log('')

  const baseline = await snapshotProduction()
  console.log('## Production invariant baseline (before)')
  for (const [k, v] of Object.entries(baseline)) {
    console.log(`- ${k.padEnd(22)} md5=${v.md5} size=${v.size}`)
  }
  console.log('')

  await mkdir(TMP, { recursive: true })

  // Pre-populate a fixture log file so memory_log_recent has 5 entries today.
  const dayDir = join(TMP, 'logs', '2026', '05')
  await mkdir(dayDir, { recursive: true })
  await writeFile(
    join(dayDir, '2026-05-20.md'),
    [
      '- [09:00] [bench][fixture] entry one',
      '- [10:00] [bench][fixture] entry two',
      '- [11:00] [bench][fixture] entry three',
      '- [12:00] [bench][fixture] entry four',
      '- [13:00] [bench][fixture] entry five',
    ].join('\n') + '\n',
  )
  await writeFile(join(TMP, 'MEMORY.md'), '# bench MEMORY\nLast distilled: 2026-05-20 03:00\nline three\nline four\n')
  await writeFile(join(TMP, 'index.json'), JSON.stringify({ entries: Object.fromEntries(Array.from({ length: 137 }, (_, i) => [`e${i}`, {}])) }))
  await mkdir(join(TMP, 'topics'), { recursive: true })
  await writeFile(join(TMP, 'topics', 't1.md'), '# t1')
  await writeFile(join(TMP, 'topics', 't2.md'), '# t2')

  const N = 20
  const benchNow = new Date('2026-05-20T05:00:00Z')

  const rememberStats = await timeIt(async (i) => {
    await runMemoryRemember(
      { content: `bench iter ${i}`, tags: ['bench'] },
      { memoryDir: TMP, now: benchNow },
    )
  }, N)

  const logRecentStats = await timeIt(async () => {
    await runMemoryLogRecent({ days: 1, limit: 100 }, { memoryDir: TMP, now: benchNow })
  }, N)

  const statusStats = await timeIt(async () => {
    await runMemoryStatus({}, { memoryDir: TMP })
  }, N)

  // daemon_status hits real `pm2 jlist` if installed (~80-400ms cold). Use a
  // mock execFile so the benchmark measures only in-process overhead.
  const mockExecFile = async () => ({
    stdout: JSON.stringify([{
      name: 'relvetia-daemon',
      pm2_env: { status: 'online', pm_uptime: Date.now() - 60_000, restart_time: 1 },
    }]),
    stderr: '',
  })
  const daemonStats = await timeIt(async () => {
    await runDaemonStatus({}, { daemonDir: TMP, execFile: mockExecFile })
  }, N)

  // Also run daemon_status against the REAL pm2 once (warm), to surface the
  // cold-start hit users will actually see. Single sample.
  let realDaemonMs = null
  try {
    const t0 = nowNs()
    await runDaemonStatus({}, { daemonDir: join(homedir(), '.claude', 'relvetia') })
    realDaemonMs = nsToMs(nowNs() - t0).toFixed(2)
  } catch (e) {
    realDaemonMs = `<error:${e.code || e.message}>`
  }

  console.log(`## Latency (N=${N}, in-process, units=ms)`)
  console.log('')
  console.log('| Tool | min | p50 | p95 | max | mean |')
  console.log('|---|---|---|---|---|---|')
  console.log(`| memory_remember   | ${rememberStats.min} | ${rememberStats.p50} | ${rememberStats.p95} | ${rememberStats.max} | ${rememberStats.mean} |`)
  console.log(`| memory_log_recent | ${logRecentStats.min} | ${logRecentStats.p50} | ${logRecentStats.p95} | ${logRecentStats.max} | ${logRecentStats.mean} |`)
  console.log(`| memory_status     | ${statusStats.min} | ${statusStats.p50} | ${statusStats.p95} | ${statusStats.max} | ${statusStats.mean} |`)
  console.log(`| daemon_status (mock pm2) | ${daemonStats.min} | ${daemonStats.p50} | ${daemonStats.p95} | ${daemonStats.max} | ${daemonStats.mean} |`)
  console.log('')
  console.log(`daemon_status against real pm2 (single sample): ${realDaemonMs}ms`)
  console.log('')

  const post = await snapshotProduction()
  console.log('## Production invariant verification (after)')
  let invariantPass = true
  for (const [k, v] of Object.entries(post)) {
    const b = baseline[k]
    const md5Match = b.md5 === v.md5 ? 'INVARIANT' : 'DRIFT'
    const sizeMatch = b.size === v.size ? 'INVARIANT' : 'DRIFT'
    if (b.md5 !== v.md5 || b.size !== v.size) invariantPass = false
    console.log(`- ${k.padEnd(22)} md5=${v.md5} size=${v.size} [${md5Match}/${sizeMatch}]`)
  }
  console.log('')
  console.log(`## Verdict: ${invariantPass ? 'PRODUCTION INVARIANT MAINTAINED' : 'INVARIANT VIOLATED — INVESTIGATE'}`)

  await rm(TMP, { recursive: true, force: true })
  process.exit(invariantPass ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(2) })
