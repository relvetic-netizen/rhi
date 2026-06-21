// File locking — modeled on Claude Code's tasks.ts (lines 96-108) and
// teammateMailbox.ts (line 142) separate .lock file pattern.

import lockfile from 'proper-lockfile'
import { ensureDir } from './paths.js'
import { dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isEexist, errorMessage } from './errors.js'

// Match Claude Code: 30 retries, 5-100ms backoff (~2.6s total budget)
// Sized for 10+ concurrent agents
const LOCK_OPTIONS = {
  retries: { retries: 30, minTimeout: 5, maxTimeout: 100 },
}
const SYNC_LOCK_RETRIES = 30
const SYNC_LOCK_MIN_TIMEOUT_MS = 5
const SYNC_LOCK_MAX_TIMEOUT_MS = 100

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// In-process FIFO serialization per lock target. proper-lockfile coordinates
// ACROSS processes, but it is a poor in-process scheduler: when one process
// fires dozens of concurrent acquisitions at the same lock file (e.g. an
// orchestrator Promise.all-ing 50 writeToMailbox calls to one inbox), they
// thunder-herd on the lockfile and unlucky waiters exhaust the retry budget
// with ELOCKED. We therefore queue same-target acquisitions in-process first,
// so at most one acquisition per process is ever contending for the file lock.
// Cross-process correctness is unchanged (the file lock still arbitrates
// between processes); we only remove the self-inflicted intra-process storm.
const inProcessTails = new Map()

function runInProcessSerial(key, fn) {
  const prevTail = inProcessTails.get(key) ?? Promise.resolve()
  // Run fn() once the predecessor settles (regardless of its outcome).
  const run = prevTail.then(fn, fn)
  // The next caller chains off our completion; swallow errors so one failure
  // doesn't reject the whole queue.
  const newTail = run.catch(() => {})
  inProcessTails.set(key, newTail)
  newTail.then(() => {
    if (inProcessTails.get(key) === newTail) inProcessTails.delete(key)
  })
  return run
}

/**
 * Execute fn() while holding an advisory file lock.
 * Uses a separate .lock file (not the data file itself) to avoid
 * interfering with data file reads/writes.
 *
 * Same-target calls within this process are serialized FIFO before the file
 * lock is acquired (see runInProcessSerial), which keeps high-concurrency
 * bursts from thundering-herd-ing proper-lockfile into ELOCKED.
 *
 * @param {string} filePath - The data file or directory to protect
 * @param {Function} fn - Async function to execute under lock
 * @param {object} [opts] - Options
 * @param {string} [opts.lockfilePath] - Custom lock file path (defaults to filePath + '.lock')
 */
export async function withLock(filePath, fn, opts = {}) {
  const lockTarget = opts.lockfilePath || `${filePath}.lock`
  return runInProcessSerial(lockTarget, () => acquireFileLockAndRun(lockTarget, fn))
}

async function acquireFileLockAndRun(lockTarget, fn) {
  await ensureDir(dirname(lockTarget))

  // Ensure lock target file exists (proper-lockfile requires it)
  try {
    await writeFile(lockTarget, '', { flag: 'wx' })
  } catch (e) {
    if (!isEexist(e)) throw e
  }

  let release
  try {
    release = await lockfile.lock(lockTarget, LOCK_OPTIONS)
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (e) {
        console.error(`[lockfile] Failed to release lock on ${lockTarget}: ${errorMessage(e)}`)
      }
    }
  }
}

/**
 * Synchronous variant for modules that expose sync public APIs but still need
 * the same cross-process lock contract.
 */
export function withLockSync(filePath, fn, opts = {}) {
  const lockTarget = opts.lockfilePath || `${filePath}.lock`

  mkdirSync(dirname(lockTarget), { recursive: true })
  try {
    writeFileSync(lockTarget, '', { flag: 'wx' })
  } catch (e) {
    if (!isEexist(e)) throw e
  }

  let release
  try {
    for (let attempt = 0; attempt <= SYNC_LOCK_RETRIES; attempt++) {
      try {
        release = lockfile.lockSync(lockTarget)
        break
      } catch (e) {
        if (e?.code !== 'ELOCKED' || attempt === SYNC_LOCK_RETRIES) throw e
        sleepSync(Math.min(
          SYNC_LOCK_MAX_TIMEOUT_MS,
          SYNC_LOCK_MIN_TIMEOUT_MS * (attempt + 1),
        ))
      }
    }
    return fn()
  } finally {
    if (release) {
      try {
        release()
      } catch (e) {
        console.error(`[lockfile] Failed to release lock on ${lockTarget}: ${errorMessage(e)}`)
      }
    }
  }
}
