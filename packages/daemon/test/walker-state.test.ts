/**
 * walker-state.test.ts — walker state load / save / cooldown / outcome.
 *
 * walker.ts 自身は Agent SDK 依存があり tsx で直接実行する設計のため、
 * unit test では walker-state.ts (SDK 非依存の core) を介して仕様を検証する。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadWalkerState,
  saveWalkerState,
  newWalkerSessionId,
  shouldWalkerCooldown,
  recordWalkerOutcome,
  type BaseWalkerState,
} from '../src/walker-state.js'

type WalkerXState = BaseWalkerState & {
  last_processed_post_id: string | null
}

const X_DEFAULTS: WalkerXState = {
  $schema: 'walker-x-state-v1',
  last_session_id: null,
  last_run_at: null,
  last_outcome: null,
  failure_count: 0,
  consecutive_failures: 0,
  last_processed_post_id: null,
}

describe('newWalkerSessionId', () => {
  it('produces 8-hex strings', () => {
    for (let i = 0; i < 50; i++) {
      const id = newWalkerSessionId()
      expect(id).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('is non-deterministic across calls (collisions are extremely rare)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(newWalkerSessionId())
    // 100 random samples should yield ~100 unique values out of 4 billion.
    expect(ids.size).toBeGreaterThan(95)
  })
})

describe('shouldWalkerCooldown', () => {
  it('returns false for fresh state', () => {
    expect(shouldWalkerCooldown(X_DEFAULTS)).toBe(false)
  })

  it('returns false for 1-2 consecutive failures', () => {
    expect(shouldWalkerCooldown({ ...X_DEFAULTS, consecutive_failures: 1 })).toBe(false)
    expect(shouldWalkerCooldown({ ...X_DEFAULTS, consecutive_failures: 2 })).toBe(false)
  })

  it('returns true at 3+ consecutive failures (本人判断 + structural cap)', () => {
    expect(shouldWalkerCooldown({ ...X_DEFAULTS, consecutive_failures: 3 })).toBe(true)
    expect(shouldWalkerCooldown({ ...X_DEFAULTS, consecutive_failures: 7 })).toBe(true)
  })
})

describe('recordWalkerOutcome', () => {
  it('records success: zeroes consecutive_failures, stamps run_at + session', () => {
    const state: WalkerXState = { ...X_DEFAULTS, consecutive_failures: 2 }
    const result = recordWalkerOutcome(state, 'a3f8b201', 'success')
    expect(result.last_session_id).toBe('a3f8b201')
    expect(result.last_outcome).toBe('success')
    expect(result.consecutive_failures).toBe(0)
    expect(result.last_run_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records failure: increments both counters', () => {
    const state: WalkerXState = { ...X_DEFAULTS, failure_count: 5, consecutive_failures: 1 }
    const result = recordWalkerOutcome(state, 'b7e1f0a3', 'failure')
    expect(result.failure_count).toBe(6)
    expect(result.consecutive_failures).toBe(2)
    expect(result.last_outcome).toBe('failure')
  })

  it('records cooldown: zeroes consecutive_failures (本人 skip も recovery 扱い)', () => {
    const state: WalkerXState = { ...X_DEFAULTS, consecutive_failures: 3 }
    const result = recordWalkerOutcome(state, 'cccccccc', 'cooldown')
    expect(result.consecutive_failures).toBe(0)
    expect(result.last_outcome).toBe('cooldown')
  })

  it('records rate_limited / passcode_gate: leaves consecutive_failures unchanged', () => {
    const s1 = recordWalkerOutcome({ ...X_DEFAULTS, consecutive_failures: 1 }, 'aa', 'rate_limited')
    expect(s1.consecutive_failures).toBe(1)
    const s2 = recordWalkerOutcome({ ...X_DEFAULTS, consecutive_failures: 2 }, 'bb', 'passcode_gate')
    expect(s2.consecutive_failures).toBe(2)
  })

  it('returns the same reference (in-place update for ergonomics)', () => {
    const state: WalkerXState = { ...X_DEFAULTS }
    const result = recordWalkerOutcome(state, 'aa', 'success')
    expect(result).toBe(state)
  })
})

describe('loadWalkerState / saveWalkerState (atomic round-trip)', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'walker-state-'))
    path = join(dir, 'walker-x.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns defaults when state file does not exist (first run)', async () => {
    const state = await loadWalkerState(path, X_DEFAULTS)
    expect(state).toEqual(X_DEFAULTS)
  })

  it('returns defaults when state file is malformed JSON (graceful degrade)', async () => {
    await writeFile(path, '{ this is not valid json')
    const state = await loadWalkerState(path, X_DEFAULTS)
    expect(state).toEqual(X_DEFAULTS)
  })

  it('round-trips state via save → load', async () => {
    const initial: WalkerXState = {
      ...X_DEFAULTS,
      last_session_id: 'a3f8b201',
      last_run_at: '2026-04-27T08:01:23+09:00',
      last_outcome: 'success',
      failure_count: 7,
      consecutive_failures: 0,
      last_processed_post_id: '1234567890',
    }
    await saveWalkerState(path, initial)
    const loaded = await loadWalkerState(path, X_DEFAULTS)
    expect(loaded).toEqual(initial)
  })

  it('merges defaults so new schema fields don\'t crash old state files', async () => {
    // Emulate an old state file missing some new field
    await writeFile(path, JSON.stringify({
      last_session_id: 'old',
      failure_count: 1,
    }))
    const loaded = await loadWalkerState(path, X_DEFAULTS)
    expect(loaded.last_session_id).toBe('old')
    expect(loaded.failure_count).toBe(1)
    // Default fields should be present
    expect(loaded.consecutive_failures).toBe(0)
    expect(loaded.last_processed_post_id).toBeNull()
    expect(loaded.$schema).toBe('walker-x-state-v1')
  })

  it('uses tmp + rename for atomicity (prevents truncation race)', async () => {
    const state: WalkerXState = { ...X_DEFAULTS, last_session_id: 'aa' }
    await saveWalkerState(path, state)
    // After save, only the target file should exist (tmp must have been renamed)
    const s = await stat(path)
    expect(s.isFile()).toBe(true)
    // Target must be parseable JSON (no truncation)
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.last_session_id).toBe('aa')
  })

  it('includes a trailing newline (cat-friendly format)', async () => {
    await saveWalkerState(path, X_DEFAULTS)
    const raw = await readFile(path, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
  })

  it('serial saves preserve final value (single-process walker is the production case)', async () => {
    // Walker は 1 process につき 1 save (main 末尾) なので並行は起きないが、
    // 念のため連続 save が壊れないことを確認する。Windows の rename race を
    // 避けるため await で順次に。既存 atomic-write.test の同種制約と同じ。
    for (let i = 0; i < 5; i++) {
      await saveWalkerState(path, { ...X_DEFAULTS, failure_count: i })
    }
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.failure_count).toBe(4)
  })
})
