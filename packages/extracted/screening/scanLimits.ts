// scanLimits — shared helpers for the Layer B file scan (`scanMemoryFiles` +
// `readMemoryFiles`).
//
// Phase 4b followup (2026-05-23, MAX_FILES truncation structural fix /
// Codex review revise pass): factored out so both scan entry points read
// the same env-driven knobs and produce the same cache key from the same
// "effective manifest" — eliminating the divergence Codex flagged as a
// silent cache-staleness bug across env toggles (PR #77 P1 #2).
//
// All three exports are evaluated per call (NOT captured at module load) so
// `MEMORY_SCAN_LEGACY_FULL` env flips take effect immediately, with or
// without a module reload. The matching cache key is produced by
// `manifestKey(resolveEffectiveManifest(opts))` in each cached wrapper so
// the cache slot changes when the env changes.

import {
  getDefaultCorpusManifest,
  type CorpusManifest,
} from '../memory/CorpusManifest.js'

export const LEGACY_MAX_FILES = 200
export const DEFAULT_MAX_FILES = 2000

/** True when the operator has opted into pre-fix behavior (no default
 *  manifest, no mtime gate, original 200-file cap). Used for emergency
 *  rollback only. */
export function isLegacyFullScan(): boolean {
  return process.env.MEMORY_SCAN_LEGACY_FULL === '1'
}

/** Per-call cap lookup. Returns the legacy 200 cap when the env opt-out is
 *  active, otherwise the defensive 2000 ceiling. The cap is applied AFTER
 *  the mtime gate + sort in both scan entry points so it functions as a
 *  pathology guard, not a load-bearing corpus shrinker. */
export function getCurrentMaxFiles(): number {
  return isLegacyFullScan() ? LEGACY_MAX_FILES : DEFAULT_MAX_FILES
}

/** Resolve the manifest both `scanMemoryFiles` and `readMemoryFiles` should
 *  apply, given the caller's opts.
 *
 *  Rules:
 *  - Caller-supplied manifest always wins (preserves existing call sites
 *    in `findRelevantMemories` and `MemoryRetrievalEngine`).
 *  - In non-legacy mode, no manifest = default manifest (excludes
 *    `.backup` / `.staging` / `tmp-*`).
 *  - In legacy mode, no manifest stays `undefined` (no path-level filter,
 *    matching pre-fix behavior).
 *
 *  The cached wrappers in `scanMemoryFiles.ts` / `memorySearch.ts` thread
 *  the return value through `manifestKey()` so flipping the env between
 *  calls lands in a different cache slot. */
export function resolveEffectiveManifest(
  opts: { manifest?: CorpusManifest },
): CorpusManifest | undefined {
  if (opts.manifest !== undefined) return opts.manifest
  return isLegacyFullScan() ? undefined : getDefaultCorpusManifest()
}
