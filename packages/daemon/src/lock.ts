/**
 * PID-based scheduler lock — prevents double-execution across
 * multiple sessions sharing a working directory.
 *
 * Ported from the behavior described in cronScheduler.ts and
 * cronTasksLock.ts (not extracted). The lock file stores the
 * owning PID and identity; non-owners probe periodically and
 * take over if the owner has crashed.
 */

import { readFile, writeFile, unlink, mkdir } from 'fs/promises'
import { join } from 'path'

type LockData = {
  pid: number
  identity: string
  timestamp: number
}

const LOCK_FILE_REL = join('.claude', '.scheduler.lock')

export type LockOptions = {
  dir: string
  lockIdentity: string
}

function lockPath(opts: LockOptions): string {
  return join(opts.dir, LOCK_FILE_REL)
}

/**
 * Attempt to acquire the scheduler lock. Returns true if this
 * process now owns it.
 *
 * Takeover logic: if the lock file exists but the PID is dead
 * (kill -0 fails), we overwrite with our own PID.
 */
export async function tryAcquireSchedulerLock(
  opts: LockOptions,
): Promise<boolean> {
  const path = lockPath(opts)

  try {
    const raw = await readFile(path, 'utf-8')
    const data: LockData = JSON.parse(raw)

    // Check if the owning process is still alive
    if (isProcessAlive(data.pid)) {
      // Owner is alive — we can't acquire
      return false
    }

    // Owner is dead — take over
    console.log(
      `[relvetia-lock] Taking over from dead owner (PID: ${data.pid}, identity: ${data.identity})`,
    )
  } catch (e: unknown) {
    // Lock file doesn't exist or is malformed — safe to create
    if (!isFileNotFound(e)) {
      console.warn('[relvetia-lock] Error reading lock file, overwriting:', e)
    }
  }

  // Write our lock
  await mkdir(join(opts.dir, '.claude'), { recursive: true })
  const lockData: LockData = {
    pid: process.pid,
    identity: opts.lockIdentity,
    timestamp: Date.now(),
  }
  await writeFile(path, JSON.stringify(lockData, null, 2) + '\n', 'utf-8')
  return true
}

/**
 * Release the scheduler lock (only if we own it).
 */
export async function releaseSchedulerLock(
  opts: LockOptions,
): Promise<void> {
  const path = lockPath(opts)
  try {
    const raw = await readFile(path, 'utf-8')
    const data: LockData = JSON.parse(raw)
    if (data.pid === process.pid) {
      await unlink(path)
    }
  } catch {
    // Lock file already gone or unreadable — nothing to do
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isFileNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
}
