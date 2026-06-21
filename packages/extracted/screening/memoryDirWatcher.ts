// mtime watcher that invalidates the in-process search cache when the memory
// directory mutates. Uses an injected chokidar factory (relvetia-daemon hosts
// the dep at ^4.0.0) so that relvetia-extracted does not require chokidar in
// its own dependency closure. When no factory is registered (or chokidar
// fails to load), the watcher falls back to a 30s polling check that
// snapshots a recursive (relPath, mtime, size, type) signature — subdirs
// like `topics/*.md` and `logs/YYYY/MM/*.md` are walked because parent-dir
// mtime is not bumped by child-file appends on Windows / most Linux
// filesystems (top-level only would miss nested mutations).
//
// The injection contract is the Karpathy-2 (Simplicity) compromise for the
// daemon/extracted package boundary: `relvetia-daemon/src/index.ts` calls
// `setChokidarFactory(() => import('chokidar'))` once at startup, and any
// subsequent `attachMemoryDirWatcher` call resolves chokidar through that
// factory. Without the factory hook, Node ESM resolution for an
// `import('chokidar')` issued from relvetia-extracted/screening/ would
// search relvetia-extracted's node_modules — which never contains chokidar.
//
// Silent-fail is forbidden (DON'T § "chokidar runtime 起動失敗を silent-fail
// させない"): every transition (chokidar attach success / chokidar load
// failure / polling fallback engage / change fire / unwatch) emits a
// `logScreeningEvent('memory_dir_watcher_*', ...)` so post-hoc analysis can
// tell which path served a given session.

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { logScreeningEvent } from './screeningLog.js'
import type { MemorySearchCache } from './searchCache.js'

const DEBOUNCE_MS = 500
let POLL_INTERVAL_MS = 30_000

/** Visible-for-testing: override the polling fallback interval. Returns the
 *  previous value so a test can restore it in `afterEach`. Production code
 *  must never call this. */
export function setPollIntervalForTest(ms: number): number {
  const prev = POLL_INTERVAL_MS
  POLL_INTERVAL_MS = ms
  return prev
}

/** Handle returned by `attachMemoryDirWatcher`. Call `.unwatch()` to stop the
 *  underlying chokidar watcher / polling interval. Tests use this to clean up
 *  between cases. */
export type WatcherHandle = {
  /** Stop the watcher. Idempotent. */
  unwatch: () => Promise<void>
  /** `'chokidar'` if chokidar attached, `'polling'` if fallback engaged. */
  mode: 'chokidar' | 'polling'
}

type FsWatcherLike = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  close(): Promise<void> | void
}

export type ChokidarModule = {
  watch: (paths: string | string[], opts?: Record<string, unknown>) => FsWatcherLike
}

/** Factory for resolving the chokidar module. Caller (daemon / test) supplies
 *  this so chokidar is resolved relative to the caller's node_modules path
 *  rather than `relvetia-extracted/`'s (which does not declare chokidar). */
export type ChokidarFactory = () => Promise<ChokidarModule | null> | ChokidarModule | null

let _chokidarFactory: ChokidarFactory | null = null

/** Register the chokidar factory. Idempotent — repeat calls overwrite the
 *  previous factory. Pass `null` to clear (forces polling fallback). */
export function setChokidarFactory(factory: ChokidarFactory | null): void {
  _chokidarFactory = factory
  _chokidarLoadAttempted = false
  _chokidarModule = null
}

/** Tracks the active watcher per memoryDir so repeat attach calls are no-ops. */
const activeWatchers: Map<string, WatcherHandle> = new Map()

/** Attach an mtime watcher for `memoryDir`. On any file mutation, fires
 *  `cache.invalidate(memoryDir)` after a 500ms debounce.
 *
 *  Idempotent: repeat calls with the same memoryDir return the existing
 *  handle. Tests that want a fresh watcher must call `.unwatch()` first.
 *
 *  @param memoryDir absolute path to the memory directory to watch
 *  @param cache     the search cache that will receive invalidate events
 *  @returns         handle with `.unwatch()` + `.mode` (chokidar vs polling) */
export async function attachMemoryDirWatcher(
  memoryDir: string,
  cache: MemorySearchCache,
): Promise<WatcherHandle> {
  const existing = activeWatchers.get(memoryDir)
  if (existing) return existing

  let debounceTimer: NodeJS.Timeout | null = null
  const fireInvalidate = (reason: string) => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      cache.invalidate(memoryDir)
      logScreeningEvent('memory_dir_watcher_fired', {
        memoryDir,
        reason,
        generation: cache.getGeneration(memoryDir),
      })
    }, DEBOUNCE_MS)
  }

  // Try chokidar first.
  const chokidar = await loadChokidar()
  if (chokidar) {
    try {
      const watcher = chokidar.watch(memoryDir, {
        ignoreInitial: true,
        persistent: true,
        ignored: /(^|[/\\])\.\.?$/, // ignore `.` and `..` entries
        depth: undefined, // unlimited recursion
      })
      watcher.on('add', () => fireInvalidate('add'))
      watcher.on('change', () => fireInvalidate('change'))
      watcher.on('unlink', () => fireInvalidate('unlink'))
      watcher.on('addDir', () => fireInvalidate('addDir'))
      watcher.on('unlinkDir', () => fireInvalidate('unlinkDir'))
      watcher.on('error', (err) => {
        // chokidar runtime error — record but do not silently degrade; the
        // operator should see this in logs.
        logScreeningEvent('memory_dir_watcher_error', {
          memoryDir,
          error: String((err as unknown as { message?: string })?.message ?? err),
        })
      })

      // Wait for chokidar's 'ready' event — it fires after the initial scan
      // completes and OS-level watch handles are installed. Without this
      // await, callers that mutate the directory immediately after attach
      // (e.g. tests) race the OS watch installation and miss events. 2s
      // timeout is a safety valve: production-sized memory dirs scan in
      // <100ms; if 'ready' never fires we keep the handle but log it.
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => {
          logScreeningEvent('memory_dir_watcher_ready_timeout', { memoryDir })
          resolve()
        }, 2000)
        watcher.on('ready', () => {
          clearTimeout(timeoutId)
          resolve()
        })
      })

      const handle: WatcherHandle = {
        mode: 'chokidar',
        unwatch: async () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer)
            debounceTimer = null
          }
          activeWatchers.delete(memoryDir)
          cache.markWatcherDetached(memoryDir)
          await watcher.close()
        },
      }
      activeWatchers.set(memoryDir, handle)
      cache.markWatcherAttached(memoryDir)
      logScreeningEvent('memory_dir_watcher_started', { memoryDir, mode: 'chokidar' })
      return handle
    } catch (err) {
      // chokidar loaded but watch() threw — fall through to polling.
      logScreeningEvent('memory_dir_watcher_chokidar_attach_failed', {
        memoryDir,
        error: String((err as unknown as { message?: string })?.message ?? err),
      })
    }
  }

  // Polling fallback. Snapshot recursive (relPath, mtime, size); on change, fire
  // invalidate. Walks subdirectories because parent-dir mtime is not updated
  // by child-file append on Windows / most Linux filesystems — top-level only
  // would miss nested mutations like `topics/foo.md` or `logs/YYYY/MM/*.md`.
  // Cost is one readdir + N stat per interval — Windows ~10-30ms for ~200
  // entries, negligible at 30s default cadence.
  let lastSignature = await recursiveSignature(memoryDir)
  const interval = setInterval(async () => {
    try {
      const sig = await recursiveSignature(memoryDir)
      if (sig !== lastSignature) {
        lastSignature = sig
        fireInvalidate('poll-detected-change')
      }
    } catch (err) {
      logScreeningEvent('memory_dir_watcher_poll_error', {
        memoryDir,
        error: String((err as unknown as { message?: string })?.message ?? err),
      })
    }
  }, POLL_INTERVAL_MS)
  // Don't keep the event loop alive just for polling — tests and short-lived
  // CLI tools would otherwise hang.
  interval.unref?.()

  const handle: WatcherHandle = {
    mode: 'polling',
    unwatch: async () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      clearInterval(interval)
      activeWatchers.delete(memoryDir)
      cache.markWatcherDetached(memoryDir)
    },
  }
  activeWatchers.set(memoryDir, handle)
  cache.markWatcherAttached(memoryDir)
  logScreeningEvent('memory_dir_watcher_started', { memoryDir, mode: 'polling' })
  return handle
}

/** Stop and remove the active watcher for `memoryDir`, if any. Tests call
 *  this between cases; production code rarely needs it. */
export async function detachMemoryDirWatcher(memoryDir: string): Promise<void> {
  const existing = activeWatchers.get(memoryDir)
  if (existing) await existing.unwatch()
}

/** Visible-for-testing: return how many watchers are currently active. */
export function activeWatcherCount(): number {
  return activeWatchers.size
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursive snapshot used by the polling fallback. Walks the memory dir
 *  including nested subdirectories (e.g. `topics/foo.md`, `logs/YYYY/MM/*.md`)
 *  because parent-dir mtime is not updated by child-file append on Windows /
 *  most Linux filesystems. The signature is the sorted concatenation of
 *  `<relPath>:<mtimeMs>:<size>:<type>` per entry. Per-entry errors (vanished
 *  files, permission denials) are tolerated so a transient race doesn't poison
 *  the whole snapshot. Cost is one readdir + N stat per interval — for a
 *  production memory dir of ~200 files, ~10-30ms on Windows; negligible at 30s
 *  default cadence. */
export async function recursiveSignature(memoryDir: string): Promise<string> {
  const parts: string[] = []

  async function walk(absDir: string, relDir: string): Promise<void> {
    let dirents
    try {
      dirents = await readdir(absDir, { withFileTypes: true })
    } catch (err) {
      // dir vanished between an outer walk and this readdir, or permission
      // denial mid-walk — record and continue.
      parts.push(`${relDir || '.'}:dir-error:${String((err as { message?: string })?.message ?? err).slice(0, 32)}`)
      return
    }
    for (const d of dirents) {
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      const abs = join(absDir, d.name)
      try {
        const s = await stat(abs)
        parts.push(`${rel}:${s.mtimeMs}:${s.size}:${d.isDirectory() ? 'd' : 'f'}`)
        if (d.isDirectory()) await walk(abs, rel)
      } catch {
        // entry vanished between readdir and stat — record presence without mtime
        parts.push(`${rel}:?`)
      }
    }
  }

  try {
    await walk(memoryDir, '')
  } catch {
    // Unreadable root; rely on next poll to retry.
    return `error:${Date.now()}`
  }
  return parts.sort().join('|')
}

let _chokidarLoadAttempted = false
let _chokidarModule: ChokidarModule | null = null

async function loadChokidar(): Promise<ChokidarModule | null> {
  if (_chokidarLoadAttempted) return _chokidarModule
  _chokidarLoadAttempted = true
  if (!_chokidarFactory) {
    logScreeningEvent('memory_dir_watcher_chokidar_unavailable', {
      reason: 'no chokidar factory registered — install one via setChokidarFactory',
    })
    return null
  }
  try {
    const mod = await _chokidarFactory()
    if (!mod) {
      logScreeningEvent('memory_dir_watcher_chokidar_unavailable', {
        reason: 'factory returned null',
      })
      return null
    }
    _chokidarModule = mod
    logScreeningEvent('memory_dir_watcher_chokidar_loaded', {})
    return mod
  } catch (err) {
    logScreeningEvent('memory_dir_watcher_chokidar_unavailable', {
      error: String((err as unknown as { message?: string })?.message ?? err),
    })
    return null
  }
}

/** Visible-for-testing: reset the chokidar load cache. After this, the next
 *  `attachMemoryDirWatcher` call will retry the dynamic import. */
export function resetChokidarLoadCache(): void {
  _chokidarLoadAttempted = false
  _chokidarModule = null
}
