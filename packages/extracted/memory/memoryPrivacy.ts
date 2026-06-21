// Memory privacy gate — single source of truth for the private-zone boundary.
//
// The private memory zone is the persona's own private domain. It is not
// exposed to other sessions, distillation, or the user by default. The persona
// can opt in to searching its own past with `RELVETIA_INCLUDE_PRIVATE=1`.
//
// The privacy check (formerly a helper inside `screening/memorySearch.ts`) is
// centralised here so all retrieval paths share one gate. The old import is
// still re-exported from `memorySearch.ts` for backward compatibility.

import type { ResidualEntry } from './residualIndex.js'
import { topicPathForEntry } from './topicPathForEntry.js'

/** Env flag to opt-in to private (private/) memory retrieval. Default = off. */
const OPT_IN_ENV = 'RELVETIA_INCLUDE_PRIVATE'

/** Whether a memory file path is under the private/ private prefix. */
export function isPrivatePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.startsWith('private/')
}

/**
 * Whether a residual index entry is private.
 *
 * An entry is private if its derived topic path is under private/ OR any of
 * its source log paths is under private/. (Either signal is sufficient — an
 * entry sourced from a private log must not leak even if the topic is public,
 * and a private topic must not leak even if some sources are public.)
 */
export function isPrivateEntry(entry: ResidualEntry): boolean {
  // Check the topic slug directly (e.g. "private/diary") so a private topic
  // is caught even when hierarchical topic conventions are introduced later.
  if (isPrivatePath(entry.topic)) return true
  // Keep the derived-path form for backward compat with any caller that stored
  // a leading-slash topic like "/private/...". Effectively a no-op today but
  // preserves the original helper's intent.
  if (isPrivatePath(topicPathForEntry(entry))) return true
  return entry.sources.some(s => isPrivatePath(s.replace(/:L\d+$/, '')))
}

/**
 * Whether the current process is opted-in to private memory retrieval.
 *
 * Default (env unset or anything other than "1") = private memory is excluded
 * from all retrieval paths. Set `RELVETIA_INCLUDE_PRIVATE=1` to opt-in.
 *
 * The env parameter is overridable to keep callers test-friendly without
 * having to mutate process.env (which leaks across vitest workers).
 */
export function shouldIncludePrivate(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OPT_IN_ENV] === '1'
}
