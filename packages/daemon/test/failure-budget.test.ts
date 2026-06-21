import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  configureFailureBudget,
  isUnderCooldown,
  recordFailure,
  recordSpawn,
  resetFailureBudget,
} from '../src/failure-budget.js'

describe('failure-budget (Axis C+F — cooldown + spawn-rate observer)', () => {
  let tmpDir: string
  let cooldownFile: string
  let nowMs: number
  let stderrSpy: ReturnType<typeof vi.spyOn>

  const advance = (ms: number) => { nowMs += ms }
  const minutes = (n: number) => n * 60 * 1000

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'relvetia-fb-'))
    cooldownFile = join(tmpDir, '.dream-cooldown.json')
    nowMs = Date.parse('2026-04-24T05:00:00.000Z')
    resetFailureBudget()
    configureFailureBudget({
      cooldownFile,
      threshold: 3,
      windowMin: 60,
      cooldownHours: 24,
      now: () => nowMs,
    })
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('cooldown engagement', () => {
    it('does not engage cooldown after 2 failures (threshold=3)', async () => {
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      expect(existsSync(cooldownFile)).toBe(false)
      expect(await isUnderCooldown('relvetia-dream')).toBe(false)
    })

    it('engages cooldown on the 3rd failure within the window', async () => {
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      expect(existsSync(cooldownFile)).toBe(true)
      expect(await isUnderCooldown('relvetia-dream')).toBe(true)

      const cooldown = JSON.parse(readFileSync(cooldownFile, 'utf-8'))
      expect(cooldown.taskId).toBe('relvetia-dream')
      expect(cooldown.reason).toMatch(/3 failures/)
    })

    it('excludes failures older than the window from the count', async () => {
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      advance(minutes(61))  // first two are now outside the 60min window
      await recordFailure('relvetia-dream', 1, 100)
      // Only the most recent failure remains in window — no cooldown.
      expect(existsSync(cooldownFile)).toBe(false)
    })

    it('ignores cooldown for a different task id', async () => {
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      expect(await isUnderCooldown('relvetia-dream')).toBe(true)
      expect(await isUnderCooldown('relvetia-verify')).toBe(false)
    })

    it('lifts cooldown once `until` has passed', async () => {
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      await recordFailure('relvetia-dream', 1, 100)
      expect(await isUnderCooldown('relvetia-dream')).toBe(true)
      advance(25 * 60 * 60 * 1000)  // +25h, past the 24h window
      expect(await isUnderCooldown('relvetia-dream')).toBe(false)
    })

    it('returns false when cooldown file does not exist', async () => {
      expect(await isUnderCooldown('relvetia-dream')).toBe(false)
    })

    it('returns false when cooldown file is malformed (treats as no cooldown rather than crashing)', async () => {
      // Direct write of garbage to simulate corruption.
      const fs = await import('fs')
      fs.writeFileSync(cooldownFile, 'not-json{')
      expect(await isUnderCooldown('relvetia-dream')).toBe(false)
    })
  })

  describe('threshold env override', () => {
    it('honours a tighter threshold (1 failure → cooldown)', async () => {
      configureFailureBudget({ threshold: 1 })
      await recordFailure('relvetia-dream', 1, 100)
      expect(await isUnderCooldown('relvetia-dream')).toBe(true)
    })
  })

  describe('spawn-rate observer (Axis F)', () => {
    it('does not warn below threshold', () => {
      recordSpawn('relvetia-dream')
      recordSpawn('relvetia-dream')
      const warnings = stderrSpy.mock.calls
        .map(c => String(c[0]))
        .filter(s => s.includes('HIGH SPAWN RATE'))
      expect(warnings).toHaveLength(0)
    })

    it('emits HIGH SPAWN RATE warning at threshold', () => {
      recordSpawn('relvetia-dream')
      recordSpawn('relvetia-dream')
      recordSpawn('relvetia-dream')
      const warnings = stderrSpy.mock.calls
        .map(c => String(c[0]))
        .filter(s => s.includes('HIGH SPAWN RATE'))
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings[0]).toMatch(/relvetia-dream fired 3 times/)
    })

    it('counts both successful spawns and failures toward the rate (a runaway looks identical either way)', async () => {
      recordSpawn('relvetia-dream')
      await recordFailure('relvetia-dream', 1, 100)
      recordSpawn('relvetia-dream')
      const warnings = stderrSpy.mock.calls
        .map(c => String(c[0]))
        .filter(s => s.includes('HIGH SPAWN RATE'))
      expect(warnings.length).toBeGreaterThan(0)
    })

    it('prunes spawns outside the window from the rate', () => {
      recordSpawn('relvetia-dream')
      recordSpawn('relvetia-dream')
      advance(minutes(61))
      recordSpawn('relvetia-dream')
      const warnings = stderrSpy.mock.calls
        .map(c => String(c[0]))
        .filter(s => s.includes('HIGH SPAWN RATE'))
      expect(warnings).toHaveLength(0)
    })
  })
})
