// Atomic file write — write to a temporary file, then rename to final path.
//
// Goal: defend against **corruption** (torn writes leaving half-written JSON),
// not durability (power-loss recovery). Relvetia's memory files are worthless
// if corrupted (daemon fails to start) but tolerant of losing the most recent
// update (nightly distillation rebuilds from logs).
//
// Mechanism:
//   1. writeFile(tmp)  — full content lands in tmp file
//   2. rename(tmp, final) — atomic on POSIX (inode swap) and on NTFS
//      (metadata journaled via MoveFileEx + MOVEFILE_REPLACE_EXISTING)
//
// fsync is deliberately NOT called: the tradeoff (ms latency per write
// for stats.json on every search) exceeds the benefit given that all
// critical state can be reconstructed from append-only logs.
//
// Windows considerations:
//   - fs.rename with an existing target works via MoveFileEx replace semantics
//   - But can transiently fail with EPERM/EBUSY if the target is held open
//     by a concurrent reader. We retry once after a short delay.
//   - Directory fsync is unavailable on Windows; we do not attempt it on
//     any platform (consistency + no real benefit for our use case).
//
// Concurrency safety:
//   - The tmp filename includes pid + random suffix so two processes writing
//     concurrently don't clobber each other's tmp files.
//   - RMW races (two readers modifying the same file) are NOT solved here;
//     that's the caller's responsibility if needed.

import { rename, unlink, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import { randomBytes } from 'crypto'

const WINDOWS_RETRY_DELAY_MS = 50

function tmpPathFor(finalPath: string): string {
  const suffix = randomBytes(4).toString('hex')
  return `${finalPath}.tmp.${process.pid}.${suffix}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Atomically write `content` to `path`. Creates parent directories if missing.
 * Uses the tmp+rename pattern so readers never observe partial content.
 */
export async function atomicWrite(
  path: string,
  content: string,
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = tmpPathFor(path)

  try {
    await writeFile(tmp, content, encoding)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }

  try {
    await rename(tmp, path)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (
      process.platform === 'win32' &&
      (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')
    ) {
      // Target may be held open by a concurrent reader. Retry once.
      await sleep(WINDOWS_RETRY_DELAY_MS)
      try {
        await rename(tmp, path)
        return
      } catch {
        /* fall through to cleanup + rethrow */
      }
    }
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/**
 * Convenience wrapper: serialize `data` as pretty-printed JSON and atomically
 * write it. Trailing newline is included for POSIX tooling compatibility.
 */
export async function atomicWriteJSON(path: string, data: unknown): Promise<void> {
  const content = JSON.stringify(data, null, 2) + '\n'
  await atomicWrite(path, content, 'utf8')
}
