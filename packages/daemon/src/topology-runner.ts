#!/usr/bin/env node
// topology-runner — standalone Node.js script for Phase 11-13 reports.
//
// Called by the daemon's "relvetia-verify" scheduled task via the verify
// prompt. Runs topology / drift / graph analyses and appends a one-line
// summary for each to today's daily log.
//
// All three analyses are non-destructive (read-only over index.json,
// topics/*.md, concepts/graph.json). This runner NEVER modifies memory
// state — it only measures and reports.
//
// Usage:
//   node dist/topology-runner.js                    # run all three
//   node dist/topology-runner.js --memory-dir /path # custom memory dir
//   node dist/topology-runner.js --skip-graph       # skip expensive Louvain
//
// Graph analysis (Louvain) is O(N·M) in concepts × edges; --skip-graph
// exists for ad-hoc runs on very large graphs. Nightly schedule runs
// everything.

import { appendFile, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  buildTopologyReport,
  formatTopologyReport,
  type TopologyReport,
} from '../../extracted/memory/topicChunking.js'
import {
  buildDriftReport,
  formatDriftReport,
  type DriftReport,
} from '../../extracted/memory/driftMonitor.js'
import {
  analyzeMemoryGraph,
  formatGraphAnalysis,
  type FullGraphAnalysis,
} from '../../extracted/memory/graphAnalysis.js'

type RunnerOutput = {
  topology: { hard: number; soft: number; under: number; totalEntries: number }
  drift: { critical: number; warning: number; maxDrift: number; recommendHierGen: boolean }
  graph: { communities: number; concepts: number; topicsToSplit: number } | null
}

async function appendToDailyLog(memoryDir: string, lines: string[]): Promise<void> {
  const now = new Date()
  const logDir = join(memoryDir, 'logs', String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'))
  const logFile = join(logDir, `${now.toISOString().slice(0, 10)}.md`)
  await mkdir(logDir, { recursive: true })

  const timestamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  // Flatten multi-line formatTopologyReport/formatDriftReport outputs so each
  // log line starts with `- [HH:MM] `. Sub-lines of the report (indented with
  // two spaces) are kept indented beneath the summary line.
  const flatLines: string[] = []
  for (const block of lines) {
    const blockLines = block.split('\n')
    if (blockLines.length === 0) continue
    flatLines.push(`- [${timestamp}] ${blockLines[0]}`)
    for (const sub of blockLines.slice(1)) {
      if (sub.trim()) flatLines.push(`  ${sub.trimEnd()}`)
    }
  }
  await appendFile(logFile, '\n' + flatLines.join('\n') + '\n', 'utf8')
}

async function runTopology(memoryDir: string): Promise<TopologyReport> {
  const report = await buildTopologyReport(memoryDir)
  return report
}

async function runDrift(memoryDir: string): Promise<DriftReport> {
  return buildDriftReport(memoryDir)
}

async function runGraph(memoryDir: string): Promise<FullGraphAnalysis> {
  return analyzeMemoryGraph(memoryDir)
}

async function main() {
  const args = process.argv.slice(2)

  const memDirIdx = args.indexOf('--memory-dir')
  const memoryDir = memDirIdx >= 0 && args[memDirIdx + 1]
    ? args[memDirIdx + 1]!
    : process.env.RELVETIA_MEMORY_DIR
      ?? (process.env.HOME ? `${process.env.HOME}/.claude/memory` : '')

  if (!memoryDir) {
    console.error('[topology-runner] cannot determine memory directory')
    process.exit(1)
  }

  const skipGraph = args.includes('--skip-graph')
  const dryRun = args.includes('--dry-run')

  console.log(`[topology-runner] analyzing memoryDir=${memoryDir} skipGraph=${skipGraph}`)

  const topology = await runTopology(memoryDir)
  const drift = await runDrift(memoryDir)
  const graph = skipGraph ? null : await runGraph(memoryDir)

  const logBlocks: string[] = [
    formatTopologyReport(topology),
    formatDriftReport(drift),
  ]
  if (graph) logBlocks.push(formatGraphAnalysis(graph))

  // Console summary (mirrors what we log)
  for (const b of logBlocks) console.log(b)

  if (!dryRun) {
    await appendToDailyLog(memoryDir, logBlocks)
  } else {
    console.log('[topology-runner] --dry-run: skipping daily log append')
  }

  // Cache the drift + topology summary so distill-mode selection can read it
  // at fire time without re-running the analysis (Phase 15 RecGen switch).
  const cacheSnapshot = {
    timestamp: new Date().toISOString(),
    recommendHierGen: drift.recommendHierGen,
    maxDrift: drift.maxDrift,
    criticalTopics: drift.criticalTopics,
    warningTopics: drift.warningTopics,
    topologyCounts: topology.counts,
    totalEntries: topology.totalEntries,
    topicsToSplit: graph?.topicsToSplit ?? [],
  }
  if (!dryRun) {
    await writeFile(
      join(memoryDir, '.last-topology.json'),
      JSON.stringify(cacheSnapshot, null, 2),
      'utf8',
    )
  }

  const out: RunnerOutput = {
    topology: {
      hard: topology.counts.hard,
      soft: topology.counts.soft,
      under: topology.counts.under,
      totalEntries: topology.totalEntries,
    },
    drift: {
      critical: drift.criticalTopics.length,
      warning: drift.warningTopics.length,
      maxDrift: drift.maxDrift,
      recommendHierGen: drift.recommendHierGen,
    },
    graph: graph
      ? {
          communities: graph.communities.length,
          concepts: graph.conceptToCommunity.size,
          topicsToSplit: graph.topicsToSplit.length,
        }
      : null,
  }
  process.stdout.write(JSON.stringify(out))
}

main().catch(e => {
  console.error('[topology-runner] fatal:', e)
  process.exit(1)
})
