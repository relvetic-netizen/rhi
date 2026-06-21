// Tests for distillVerifier.ts — focused on the regression nets added by
// commit d9edcbc (Layer 1 fail-closed for empty target, MAX_VERIFY_ENTRIES env
// override, PASSED/FAILED log suffix) and the jstTime helper used by
// logVerificationResults.

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { setTimeout as sleep } from 'timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  verifyDistillation,
  logVerificationResults,
} from '../../extracted/memory/distillVerifier.js'
import { todayJST, timeJST } from '../../extracted/util/jstTime.js'

type FixtureEntry = {
  id: string
  topic: string
  summary: string
  sources: string[]
  concepts: string[]
  updated?: string
  addedAt?: string
  confidence?: number
}

let tempDirs: string[] = []

async function makeMemoryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'relvetia-distill-verify-'))
  tempDirs.push(dir)
  return dir
}

async function writeMemoryFile(memoryDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(memoryDir, relativePath)
  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content)
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' || attempt === 4) {
        throw error
      }
      await sleep(25)
    }
  }
}

function makeEntry(overrides: Partial<FixtureEntry> = {}): FixtureEntry {
  return {
    id: overrides.id ?? 'pref_001',
    topic: overrides.topic ?? 'preferences',
    summary: overrides.summary ?? 'User prefers bun over npm for package management',
    sources: overrides.sources ?? ['logs/2026/05/2026-05-17.md:L1'],
    concepts: overrides.concepts ?? ['bun', 'package-manager', 'preference'],
    updated: overrides.updated,
    addedAt: overrides.addedAt,
    confidence: overrides.confidence ?? 1,
  }
}

async function seedMemory(memoryDir: string, entries: FixtureEntry[]): Promise<void> {
  const indexEntries: Record<string, FixtureEntry> = {}
  for (const e of entries) indexEntries[e.id] = e
  await writeMemoryFile(memoryDir, 'index.json', JSON.stringify({ version: 1, entries: indexEntries }))
  // Topic file so searchMemoryWithScreening has something to find for happy-path tests.
  for (const e of entries) {
    const topicPath = `topics/${e.topic}.md`
    await writeMemoryFile(memoryDir, topicPath, `# ${e.topic}\n\n${e.summary}\n`)
    const sourcePath = e.sources[0]?.split(':')[0]
    if (sourcePath) {
      await writeMemoryFile(memoryDir, sourcePath, `- [10:00] [test] ${e.summary}\n`)
    }
  }
}

describe('distillVerifier', () => {
  afterEach(async () => {
    delete process.env.RELVETIA_MAX_VERIFY_ENTRIES
    await Promise.all(tempDirs.map(removeTempDir))
    tempDirs = []
  })

  describe('verifyDistillation', () => {
    it('fails closed when index has entries but no today-updated targets (Layer 1 regression net)', async () => {
      const memoryDir = await makeMemoryDir()
      // Entries exist but `updated` is yesterday (or absent) — Codex root cause:
      // schema drift to addedAt left 91/105 entries invisible to today filter.
      const yesterday = '2000-01-01'
      await seedMemory(memoryDir, [
        makeEntry({ id: 'pref_001', updated: yesterday }),
        makeEntry({ id: 'pref_002', addedAt: yesterday }), // no `updated`
      ])

      const result = await verifyDistillation(memoryDir, 'today')

      // Pre-d9edcbc: { passed: true, hitRate: 1.0, totalEntries: 0 } (silent pass).
      // Post-d9edcbc: passed=false with reason no_target_entries.
      expect(result.passed).toBe(false)
      expect(result.totalEntries).toBe(0)
      expect(result.foundEntries).toBe(0)
      expect(result.hitRate).toBe(0)
    })

    it('verifies entries dated today and reports hit rate', async () => {
      const memoryDir = await makeMemoryDir()
      const today = todayJST()
      await seedMemory(memoryDir, [
        makeEntry({
          id: 'pref_001',
          updated: today,
          summary: 'distinctive-fixture-keyword-alpha used as discovery target',
          concepts: ['distinctive-fixture-keyword-alpha', 'discovery', 'target'],
        }),
      ])

      const result = await verifyDistillation(memoryDir, 'today')

      // Either passed (search found it via topic file) or hitRate > 0 — we
      // are not asserting search correctness, only that the filter included
      // the today-dated entry and the function did not short-circuit.
      expect(result.totalEntries).toBe(1)
      expect(result.hitRate).toBeGreaterThanOrEqual(0)
    })

    it('honors RELVETIA_MAX_VERIFY_ENTRIES env override via module reload', async () => {
      const memoryDir = await makeMemoryDir()
      const today = todayJST()
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeEntry({
          id: `pref_${String(i).padStart(3, '0')}`,
          updated: today,
        }),
      )
      await seedMemory(memoryDir, entries)

      process.env.RELVETIA_MAX_VERIFY_ENTRIES = '3'
      // Top-level const captures env at module-load; we must reset modules
      // and dynamically re-import to pick up the override.
      const vitest = await import('vitest')
      vitest.vi.resetModules()
      const fresh = await import('../../extracted/memory/distillVerifier.js')

      const result = await fresh.verifyDistillation(memoryDir, 'today')

      expect(result.totalEntries).toBe(3)

      vitest.vi.resetModules()
    })
  })

  describe('logVerificationResults', () => {
    it('appends PASSED suffix when result.passed is true', async () => {
      const memoryDir = await makeMemoryDir()

      await logVerificationResults(memoryDir, {
        totalEntries: 5,
        foundEntries: 5,
        hitRate: 1,
        missingEntries: [],
        passed: true,
      })

      const today = todayJST()
      const [yearStr, monthStr] = today.split('-')
      const logPath = join(memoryDir, 'logs', yearStr, monthStr, `${today}.md`)
      const content = await readFile(logPath, 'utf-8')
      expect(content).toMatch(/\[distill-verify\] Hit rate: 100% \(5\/5\) PASSED/)
    })

    it('appends FAILED suffix when result.passed is false', async () => {
      const memoryDir = await makeMemoryDir()

      await logVerificationResults(memoryDir, {
        totalEntries: 10,
        foundEntries: 3,
        hitRate: 0.3,
        missingEntries: [],
        passed: false,
      })

      const today = todayJST()
      const [yearStr, monthStr] = today.split('-')
      const logPath = join(memoryDir, 'logs', yearStr, monthStr, `${today}.md`)
      const content = await readFile(logPath, 'utf-8')
      expect(content).toMatch(/\[distill-verify\] Hit rate: 30% \(3\/10\) FAILED/)
    })
  })
})

describe('jstTime helper', () => {
  it('todayJST returns YYYY-MM-DD anchored on JST regardless of host TZ', () => {
    // 2026-05-16T18:00Z is 2026-05-17 03:00 JST.
    const date = new Date('2026-05-16T18:00:00Z')
    expect(todayJST(date)).toBe('2026-05-17')
  })

  it('timeJST returns HH:MM anchored on JST', () => {
    // 2026-05-16T18:30Z is 03:30 JST.
    const date = new Date('2026-05-16T18:30:00Z')
    expect(timeJST(date)).toBe('03:30')
  })

  it('todayJST handles UTC midnight that is JST morning', () => {
    // 2026-01-01T00:00Z is 2026-01-01 09:00 JST.
    const date = new Date('2026-01-01T00:00:00Z')
    expect(todayJST(date)).toBe('2026-01-01')
  })

  it('todayJST handles UTC noon that is JST late evening', () => {
    // 2026-05-17T12:00Z is 2026-05-17 21:00 JST.
    const date = new Date('2026-05-17T12:00:00Z')
    expect(todayJST(date)).toBe('2026-05-17')
  })

  it('todayJST advances when UTC crosses 15:00Z (JST midnight)', () => {
    // 2026-05-17T14:59Z is 2026-05-17 23:59 JST.
    expect(todayJST(new Date('2026-05-17T14:59:00Z'))).toBe('2026-05-17')
    // 2026-05-17T15:00Z is 2026-05-18 00:00 JST.
    expect(todayJST(new Date('2026-05-17T15:00:00Z'))).toBe('2026-05-18')
  })
})
