import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))

// Tests exercise the topology-runner entry point via `tsx`. The runner is a
// thin wrapper around buildTopologyReport / buildDriftReport / analyzeMemoryGraph
// (each individually unit-tested elsewhere) — these tests validate the
// wiring: arg parsing, daily log append, JSON stdout, and --dry-run / --skip-graph
// flags. All I/O is within a temp memoryDir, no network.

const runnerPath = join(__dirname, '..', 'src', 'topology-runner.ts')

async function runRunner(args: string[]): Promise<{ stdout: string; stderr: string }> {
  // Call node directly with tsx/cli.mjs to avoid Windows .cmd shim issues
  // (see HANDOFF.md "Windows 固有の罠" — .cmd grandchild stdio is flaky).
  const tsxCli = join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const { stdout, stderr } = await execFileP(process.execPath, [tsxCli, runnerPath, ...args], {
    env: { ...process.env, RELVETIA_MEMORY_DIR: '' }, // force --memory-dir
    windowsHide: true,
  })
  return { stdout, stderr }
}

async function seedMemory(dir: string, indexEntries: unknown, topicFiles: Record<string, string> = {}) {
  await mkdir(join(dir, 'topics'), { recursive: true })
  await mkdir(join(dir, 'concepts'), { recursive: true })
  await writeFile(join(dir, 'index.json'), JSON.stringify(indexEntries), 'utf8')
  for (const [topic, content] of Object.entries(topicFiles)) {
    await writeFile(join(dir, 'topics', `${topic}.md`), content, 'utf8')
  }
}

describe('topology-runner', () => {
  let memDir: string

  beforeEach(async () => {
    memDir = await mkdtemp(join(tmpdir(), 'topology-runner-'))
  })

  afterEach(async () => {
    await rm(memDir, { recursive: true, force: true })
  })

  it('emits JSON with topology / drift / graph fields for empty memory', async () => {
    await seedMemory(memDir, [])
    const { stdout } = await runRunner(['--memory-dir', memDir, '--dry-run'])
    // Last stdout chunk is the JSON payload; console.log output precedes it
    // The runner prints multi-line [topology]/[drift]/[graph] text on stdout
    // via console.log, then writes a JSON payload (no trailing newline) via
    // process.stdout.write. Extract the JSON from after the last newline.
    const lastNl = stdout.lastIndexOf('\n')
    const parsed = JSON.parse(stdout.slice(lastNl + 1))
    expect(parsed).toHaveProperty('topology')
    expect(parsed).toHaveProperty('drift')
    expect(parsed).toHaveProperty('graph')
    expect(parsed.topology.totalEntries).toBe(0)
    expect(parsed.drift.critical).toBe(0)
  })

  it('reports soft-limit topic when entries exceed softLimit', async () => {
    // Seed 25 entries on one topic (soft=20, hard=35)
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: `e_${i}`,
      topic: 'troubleshooting',
      summary: `entry ${i} about windows bug`,
      sources: [],
      concepts: ['windows', 'bug'],
      updated: '2026-04-22',
      confidence: 0.9,
    }))
    await seedMemory(memDir, entries, {
      troubleshooting: '# Troubleshooting\n\n- Windows bug notes\n',
    })
    const { stdout } = await runRunner(['--memory-dir', memDir, '--dry-run', '--skip-graph'])
    // The runner prints multi-line [topology]/[drift]/[graph] text on stdout
    // via console.log, then writes a JSON payload (no trailing newline) via
    // process.stdout.write. Extract the JSON from after the last newline.
    const lastNl = stdout.lastIndexOf('\n')
    const parsed = JSON.parse(stdout.slice(lastNl + 1))
    expect(parsed.topology.soft).toBeGreaterThanOrEqual(1)
    expect(parsed.graph).toBeNull() // --skip-graph
  })

  it('--dry-run does not append to daily log', async () => {
    await seedMemory(memDir, [])
    const before = existsSync(join(memDir, 'logs'))
    await runRunner(['--memory-dir', memDir, '--dry-run'])
    const after = existsSync(join(memDir, 'logs'))
    expect(after).toBe(before) // no new logs dir created
  })

  it('appends [topology] / [drift] lines to daily log (non-dry-run)', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      id: `e_${i}`,
      topic: 'pref',
      summary: `prefer ${i}`,
      sources: [],
      concepts: ['pref'],
      updated: '2026-04-22',
      confidence: 1,
    }))
    await seedMemory(memDir, entries, { pref: '# Preferences\n- prefer foo\n' })
    await runRunner(['--memory-dir', memDir, '--skip-graph'])

    const now = new Date()
    const y = String(now.getFullYear())
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = now.toISOString().slice(0, 10)
    const logPath = join(memDir, 'logs', y, m, `${d}.md`)
    const content = await readFile(logPath, 'utf8')

    expect(content).toContain('[topology]')
    expect(content).toContain('[drift]')
  })
})
