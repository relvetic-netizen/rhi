// Numeric → Hierarchical Entry ID Normalizer
//
// memory-hardening-followup Phase A (2026-05-19).
//
// Production drift observed: the 2026-05-19 03:04 distill pass wrote 8 new
// entries (110-117) with bare numeric ids — bypassing the canonical
// `generateEntryId()` slug-safe / counter format. `readResidualIndex` and
// search keep working with any string id, so the drift was invisible until
// T4b-11 verify surfaced it. Two contributing causes:
//
//   1. `distill.md` documented the id format but the prompt-driven distill
//      session is free to ignore the rule (no enforcement path).
//   2. `generateEntryId()` had zero production callers outside tests, so even
//      following the prompt didn't materially constrain shape.
//
// This module closes both gaps:
//
//   - Pure function `normalizeNumericIds(index)` rewrites every entry whose
//     id matches /^\d+$/ to a slug-safe hierarchical id derived from its
//     topic via `generateEntryId`. Returns `{ index, mapping }` so the
//     caller can persist the old→new mapping for external citation lookups.
//
//   - The caller in `bootstrap.ts` (ensureHierarchicalEntryIds) fires on
//     every daemon startup. Idempotent: when no numeric ids exist it is a
//     no-op (zero writes, zero log noise).

import { generateEntryId, type ResidualIndex, type ResidualEntry } from './residualIndex.js'

export type IdMapping = {
  oldId: string
  newId: string
  topic: string
  updated: string
}

export type NormalizeResult = {
  index: ResidualIndex
  mapping: IdMapping[]
}

const NUMERIC_ID_RE = /^\d+$/

/**
 * Detect entries whose id is a bare numeric string and rewrite them to a
 * hierarchical id derived from the entry's `topic` via `generateEntryId`.
 *
 * Pure / immutable: a new `ResidualIndex` is returned; the input is not
 * mutated. The `mapping` array preserves insertion order (sorted by numeric
 * value of the old id ascending), so persisted mapping files remain stable
 * across reruns on the same input.
 */
export function normalizeNumericIds(input: ResidualIndex): NormalizeResult {
  const numericIds = Object.keys(input.entries)
    .filter((id) => NUMERIC_ID_RE.test(id))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))

  if (numericIds.length === 0) {
    return { index: input, mapping: [] }
  }

  // Start from a copy with the numeric-id entries removed, so each
  // generateEntryId call sees an index that already lacks the entry being
  // re-keyed (preventing accidental prefix collisions with the same record's
  // old slot).
  const carriedEntries: Record<string, ResidualEntry> = {}
  for (const [id, entry] of Object.entries(input.entries)) {
    if (NUMERIC_ID_RE.test(id)) continue
    carriedEntries[id] = entry
  }

  const mapping: IdMapping[] = []
  let workingIndex: ResidualIndex = { ...input, entries: carriedEntries }

  for (const oldId of numericIds) {
    const original = input.entries[oldId]
    const topic = original?.topic ?? 'entry'
    const newId = generateEntryId(topic, workingIndex)
    const rewritten: ResidualEntry = { ...original, id: newId }
    workingIndex = {
      ...workingIndex,
      entries: { ...workingIndex.entries, [newId]: rewritten },
    }
    mapping.push({
      oldId,
      newId,
      topic,
      updated: original?.updated ?? '',
    })
  }

  return { index: workingIndex, mapping }
}

/**
 * Merge a new batch of mappings into an existing mapping file (deduping by
 * `oldId`). Returns the merged array sorted by numeric oldId where possible
 * for stable on-disk diffs.
 *
 * Used by the bootstrap caller to append today's normalization to the
 * persisted history file without losing prior runs' mappings.
 */
export function mergeMappings(existing: IdMapping[], incoming: IdMapping[]): IdMapping[] {
  const byOld = new Map<string, IdMapping>()
  for (const m of existing) byOld.set(m.oldId, m)
  for (const m of incoming) byOld.set(m.oldId, m) // latest wins on rerun

  return [...byOld.values()].sort((a, b) => {
    const an = parseInt(a.oldId, 10)
    const bn = parseInt(b.oldId, 10)
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a.oldId.localeCompare(b.oldId)
  })
}
