/**
 * walker-state.ts — shared state load / save helpers for private walkers.
 *
 * Both x-walker.ts and discord-walker.ts (under ~/.claude/relvetia/private/walkers/)
 * use the same atomic write pattern and the same cooldown gate. Centralising
 * the logic here lets daemon-side unit tests verify the contract once and
 * keeps the walker entry scripts thin.
 *
 * The walker scripts deliberately re-export these helpers so the public API
 * surface stays in private/walkers/, but the implementation is shared via
 * relative import (../../../workspace/relvetia/...) — this keeps the daemon
 * as the single source of truth for atomic write semantics.
 */

import { readFile, writeFile, rename } from 'fs/promises'
import { randomBytes } from 'crypto'

/** Common shape for walker-x.json and walker-discord.json. Walker-specific
 *  fields are added via intersection types in each walker.ts. */
export type BaseWalkerState = {
  $schema?: string
  last_session_id: string | null
  last_run_at: string | null
  last_outcome:
    | 'success'
    | 'failure'
    | 'rate_limited'
    | 'passcode_gate'
    | 'cooldown'
    | null
  failure_count: number
  consecutive_failures: number
  _notes?: string
}

/** Load a walker state JSON. Returns the supplied defaults when the file is
 *  missing or unparseable (graceful degrade — walker must not crash on first
 *  run before state file exists). */
export async function loadWalkerState<T extends BaseWalkerState>(
  path: string,
  defaults: T,
): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch {
    return { ...defaults }
  }
}

/** Atomic write: tmp に書いて rename。
 *
 *  Prevents a truncation race that can empty the state file: the tmp suffix
 *  includes pid + timestamp so concurrent writes never collide. */
export async function saveWalkerState<T extends BaseWalkerState>(
  path: string,
  state: T,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${randomBytes(2).toString('hex')}`
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await rename(tmp, path)
}

/** Walker session_id (8 桁 hex) を発行。trace 用、UUID よりも log に乗せやすい。
 *  4 byte = 約 43 億通りで衝突は walker 用途では実質ゼロ (SPEC §11.4)。 */
export function newWalkerSessionId(): string {
  return randomBytes(4).toString('hex')
}

/** 連続失敗 3 回超で walker は休む (本人判断 + structural cap)。
 *  walker prompt 内の private が同じ判断をするが、起動コストすら惜しい
 *  ケース向けに executor 側でも shortcut する。 */
export function shouldWalkerCooldown(state: BaseWalkerState): boolean {
  return state.consecutive_failures >= 3
}

/** Update outcome counters on a walker state in place. Returns the same
 *  reference for ergonomics. */
export function recordWalkerOutcome<T extends BaseWalkerState>(
  state: T,
  sessionId: string,
  outcome: BaseWalkerState['last_outcome'],
): T {
  state.last_session_id = sessionId
  state.last_run_at = new Date().toISOString()
  state.last_outcome = outcome
  if (outcome === 'failure') {
    state.failure_count += 1
    state.consecutive_failures += 1
  } else if (outcome === 'success' || outcome === 'cooldown') {
    state.consecutive_failures = 0
  }
  return state
}
