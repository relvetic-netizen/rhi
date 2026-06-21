// lastDistillMtime — read `<memoryDir>/.last-distill` and return the parsed
// timestamp in milliseconds since epoch.
//
// Phase 4b followup (2026-05-23, MAX_FILES truncation structural fix) helper.
// Shared between `scanMemoryFiles` and `memorySearch.readMemoryFiles` so the
// Layer B mtime gate has exactly one source of truth.
//
// Contract:
//   - File contains a UTC ISO timestamp (e.g. `2026-05-22T18:00:44.248Z`) as
//     written by `relvetia-daemon/src/handle-fire.ts` after a successful
//     distillation. Trailing whitespace is tolerated.
//   - Missing / unreadable / unparseable file → returns 0. Callers treat 0
//     as "gate disabled" (bootstrap, first-run, or lost-stamp scenarios), so
//     the helper never throws.
//   - Cache invalidation: not cached here. The search-cache layer wrapping
//     `scanMemoryFiles` / `readMemoryFiles` already invalidates on memoryDir
//     changes; `.last-distill` lives inside memoryDir so its update is
//     captured by the same watcher.

import { readFile } from 'fs/promises'
import { join } from 'path'

export async function readLastDistillMtimeMs(memoryDir: string): Promise<number> {
  try {
    const raw = await readFile(join(memoryDir, '.last-distill'), 'utf8')
    const ms = Date.parse(raw.trim())
    return Number.isFinite(ms) ? ms : 0
  } catch {
    return 0
  }
}
