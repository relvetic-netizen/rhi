// Filesystem utilities shared across modules.

import { writeFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Atomic file write via tmp-then-rename. Prevents partial writes on crash.
 */
export async function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}`
  try {
    await writeFile(tmp, data)
    await rename(tmp, filePath)
  } catch (err) {
    try { await unlink(tmp) } catch {}
    throw err
  }
}

/**
 * The default relvetia-daemon directory (~/.claude/relvetia), overridable
 * via $RELVETIA_DIR. Single source of truth — re-exported from
 * relvetia-admin-tools.js and relvetia-memory-tools.js so older imports
 * keep working, but those modules must NOT redefine the body (saga 10
 * Phase 4-2 P2 #1 dedup; prior duplicate definitions risked silent
 * contract drift between the two surfaces).
 */
export function defaultDaemonDir() {
  return process.env.RELVETIA_DIR || join(homedir(), '.claude', 'relvetia')
}
