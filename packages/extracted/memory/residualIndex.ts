// Residual Index — bidirectional lookup between distilled entries and source logs.
//
// When the nightly distillation compresses daily logs into topic files, information
// is lost (irreversible compression). The residual index tracks:
//   - Which source log lines contributed to each distilled entry
//   - What concepts (normalized keywords) each entry covers
//   - Confidence and hit statistics for usage-based weighting (Phase 3)
//
// Inspired by PHOTON's RecGen: instead of re-encoding from scratch, maintain
// a lightweight index that allows tracing back to source material on demand.
//
// File format: YAML front matter in topic files + a separate index manifest.
//
// Index manifest: ~/.claude/memory/index.json
// {
//   "entries": {
//     "pref_001": {
//       "summary": "...",
//       "sources": ["logs/2026/04/2026-04-03.md:L15"],
//       "concepts": ["bun", "package-manager"],
//       "topic": "preferences",
//       "updated": "2026-04-07",
//       "confidence": 1.0
//     }
//   }
// }

import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJSON } from '../util/atomicWrite.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResidualEntry = {
  /** Unique entry ID (e.g., "pref_001"). */
  id: string
  /** One-line summary of the distilled knowledge. */
  summary: string
  /** Source log references (e.g., "logs/2026/04/2026-04-03.md:L15"). */
  sources: string[]
  /** Normalized concept tags for multi-resolution search. */
  concepts: string[]
  /** Topic category (e.g., "preferences", "architecture"). */
  topic: string
  /** Last updated date (ISO date string). */
  updated: string
  /** Confidence score 0-1. Decremented by user corrections. */
  confidence: number
}

export type ResidualIndex = {
  /** Version for future schema migrations. */
  version: number
  /** Map of entry ID to entry data. */
  entries: Record<string, ResidualEntry>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INDEX_FILENAME = 'index.json'
const CURRENT_VERSION = 1

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function indexPath(memoryDir: string): string {
  return join(memoryDir, INDEX_FILENAME)
}

type LegacyResidualEntry = ResidualEntry & { score?: unknown }

function normalizeEntry(entry: unknown): ResidualEntry | null {
  if (!entry || typeof entry !== 'object') return null

  const normalized = entry as LegacyResidualEntry
  // dual fallback during score→confidence migration window; remove after PR-3 migration applied
  if (normalized.confidence === undefined && typeof normalized.score === 'number') {
    normalized.confidence = normalized.score
  }

  return normalized
}

function normalizeEntriesRecord(rawEntries: Record<string, unknown>): Record<string, ResidualEntry> {
  const entries: Record<string, ResidualEntry> = {}
  for (const [id, entry] of Object.entries(rawEntries)) {
    const normalized = normalizeEntry(entry)
    if (normalized) entries[id] = normalized
  }
  return entries
}

function normalizeEntriesArray(rawEntries: unknown[]): Record<string, ResidualEntry> {
  const entries: Record<string, ResidualEntry> = {}
  for (const entry of rawEntries) {
    const normalized = normalizeEntry(entry)
    if (normalized && typeof normalized.id === 'string') {
      entries[normalized.id] = normalized
    }
  }
  return entries
}

/**
 * Read the residual index from disk. Returns an empty index if the file
 * doesn't exist or is malformed.
 *
 * Handles two on-disk formats for robustness:
 *   1. Schema format: `{ version, entries: { [id]: entry } }` (canonical)
 *   2. Legacy array format: `[entry, entry, ...]` (observed in production,
 *      likely a migration artifact). Array entries are keyed by their `id`.
 *
 * The next writeResidualIndex() call will normalize the file to the schema
 * format. Until then, every read silently handles both — no consumer needs
 * to know which format is on disk.
 *
 * Background: during v3 hierarchy work (2026-04-21) we discovered that
 * production index.json was an array while the schema and all consumers
 * expected the object format. readResidualIndex() silently returned empty,
 * which caused multiResolutionScreening, distillVerifier, and
 * buildConceptGraph to operate on an empty corpus — degrading retrieval
 * without any error surface. Fixed here.
 */
export async function readResidualIndex(memoryDir: string): Promise<ResidualIndex> {
  try {
    const raw = await readFile(indexPath(memoryDir), 'utf8')
    const parsed = JSON.parse(raw)

    // Canonical schema format.
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      const entries = Array.isArray(parsed.entries)
        ? normalizeEntriesArray(parsed.entries)
        : normalizeEntriesRecord(parsed.entries)
      return { version: parsed.version ?? CURRENT_VERSION, entries }
    }

    // Legacy/drift format: flat array of entries. Key by `id`.
    if (Array.isArray(parsed)) {
      return { version: CURRENT_VERSION, entries: normalizeEntriesArray(parsed) }
    }

    return emptyIndex()
  } catch {
    return emptyIndex()
  }
}

/**
 * Write the residual index to disk. Creates parent directories if needed.
 */
export async function writeResidualIndex(
  memoryDir: string,
  index: ResidualIndex,
): Promise<void> {
  await atomicWriteJSON(indexPath(memoryDir), index)
}

function emptyIndex(): ResidualIndex {
  return { version: CURRENT_VERSION, entries: {} }
}

// ---------------------------------------------------------------------------
// Entry CRUD
// ---------------------------------------------------------------------------

/**
 * Generate a short entry ID from topic + counter.
 *
 * Flat topic: 4-char prefix + counter (e.g. "pref_001", "arch_012") — legacy
 * behavior preserved so existing flat-topic prefix counters stay monotonic
 * across upgrades.
 *
 * Hierarchical topic (contains "/"): slug-safe full path with non-alnum → "_",
 * truncated at 16 chars (e.g. `architecture/daemon-silent-fail` →
 * `architecture_dae_001`). This avoids collision between flat `architecture`
 * and any `architecture/<sub>` entries that would both reduce to `arch` under
 * the legacy 4-char rule (Phase 3 T4 hierarchical topic introduction).
 */
export function generateEntryId(topic: string, index: ResidualIndex): string {
  const prefix = topic.includes('/')
    ? (topic.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'entry')
    : topic.slice(0, 4).toLowerCase().replace(/[^a-z]/g, '')
  const existing = Object.keys(index.entries).filter(k => k.startsWith(prefix + '_'))
  const next = existing.length + 1
  return `${prefix}_${String(next).padStart(3, '0')}`
}

/**
 * Upsert an entry into the index. If an entry with the same ID exists,
 * it is overwritten (latest wins).
 */
export function upsertEntry(
  index: ResidualIndex,
  entry: ResidualEntry,
): ResidualIndex {
  return {
    ...index,
    entries: { ...index.entries, [entry.id]: entry },
  }
}

/**
 * Remove entries by ID.
 */
export function removeEntries(
  index: ResidualIndex,
  ids: string[],
): ResidualIndex {
  const entries = { ...index.entries }
  for (const id of ids) {
    delete entries[id]
  }
  return { ...index, entries }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Find entries by concept tag. Returns all entries whose concepts array
 * contains ANY of the given tags (OR semantics).
 */
export function findByConcepts(
  index: ResidualIndex,
  concepts: string[],
): ResidualEntry[] {
  const lowerConcepts = new Set(concepts.map(c => c.toLowerCase()))
  return Object.values(index.entries).filter(entry =>
    entry.concepts.some(c => lowerConcepts.has(c.toLowerCase())),
  )
}

/**
 * Find entries by topic.
 */
export function findByTopic(
  index: ResidualIndex,
  topic: string,
): ResidualEntry[] {
  return Object.values(index.entries).filter(entry => entry.topic === topic)
}

/**
 * Find entries whose sources reference a given log file.
 * Useful for "what was distilled from this log?" queries.
 */
export function findBySource(
  index: ResidualIndex,
  sourcePattern: string,
): ResidualEntry[] {
  return Object.values(index.entries).filter(entry =>
    entry.sources.some(s => s.includes(sourcePattern)),
  )
}

/**
 * Get all unique concepts across the entire index.
 * Useful for building a concept vocabulary for multi-resolution search.
 */
export function allConcepts(index: ResidualIndex): string[] {
  const set = new Set<string>()
  for (const entry of Object.values(index.entries)) {
    for (const c of entry.concepts) {
      set.add(c.toLowerCase())
    }
  }
  return [...set].sort()
}

/**
 * Build a text representation of an entry for screening.
 * Combines summary + concepts to create a searchable string.
 */
export function entryToSearchText(entry: ResidualEntry): string {
  return `${entry.summary} ${entry.concepts.join(' ')}`
}
