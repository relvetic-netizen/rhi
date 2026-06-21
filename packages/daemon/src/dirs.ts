/**
 * Daemon path resolution — single source of truth.
 *
 * Both `index.ts` and `failure-budget.ts` previously resolved daemon directories
 * inconsistently: `index.ts` used `process.env.RELVETIA_DIR ?? homedir() join`
 * while `failure-budget.ts` used `homedir() join` directly. When the env was
 * corrupted with literal tildes (issue #5), the cooldown file went to the
 * correct path while everything else went somewhere broken — a "saved by
 * inconsistency" failure mode that's harder to diagnose than a uniform break.
 *
 * Centralising here makes both modules fail (or succeed) the same way and
 * gives one place to add invariant checks (e.g. "literal tilde" detection)
 * if needed in the future.
 */

import { homedir } from 'os'
import { join } from 'path'

/** Resolve daemon base dir. Prefers `RELVETIA_DIR` env, falls back to `~/.claude/relvetia`. */
export function getRelvetiaDir(): string {
  return process.env.RELVETIA_DIR ?? join(homedir(), '.claude', 'relvetia')
}

/** Resolve memory dir. Prefers `RELVETIA_MEMORY_DIR` env, falls back to `~/.claude/memory`. */
export function getMemoryDir(): string {
  return process.env.RELVETIA_MEMORY_DIR ?? join(homedir(), '.claude', 'memory')
}
