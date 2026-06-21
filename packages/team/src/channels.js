// Channels capability — pushes new inbox entries as
// `notifications/claude/channel` events to the active Claude Code session.
//
// Spec: docs/specs/channels-integration.md
// Docs: https://code.claude.com/docs/en/channels-reference
//
// Each receiver claude session spawns its own relvetia-team MCP subprocess
// over stdio. The subprocess inherits RELVETIA_TEAM / RELVETIA_AGENT env
// vars (set by spawn-relay.mjs) and watches its OWN agent inbox file for
// new entries. Cold-start unread is the responsibility of the SessionStart
// hook (relvetia-inbox-injector.mjs); channels delivers only entries that
// arrive AFTER subprocess init (post-baseline).

import { appendFile, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { watch as fsWatch } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'

import { parseInboxSafe } from './mailbox.js'
import { getInboxPath, getInboxDir, ensureDir } from './paths.js'

const POLL_INTERVAL_MS = 5000

function logErr(e) {
  console.error('[channels]', e?.stack || e?.message || e)
}

/**
 * Compose a stable dedupe key for a mailbox entry. Entries have no `id`
 * field, so we derive one from request_id, in_reply_to, or a hash of
 * timestamp+from+text.
 *
 * Spec §5.2 dedupeKey.
 */
export function dedupeKey(entry) {
  if (entry?.request_id) return `req:${entry.request_id}`
  if (entry?.in_reply_to) return `rep:${entry.in_reply_to}:${entry.timestamp ?? ''}`
  const ts = entry?.timestamp ?? ''
  const from = entry?.from ?? ''
  const text = entry?.text ?? ''
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 8)
  return `gen:${ts}|${from}|${hash}`
}

function deriveKind(entry) {
  if (entry?.request_id) return 'request'
  if (entry?.in_reply_to) return 'reply'
  return 'message'
}

/**
 * Build the notification meta object. Empty / undefined optional fields
 * are omitted (Channels reference: keys may only contain letters, digits,
 * underscores; empty string would still surface as an empty attribute).
 */
export function buildMeta({ team, agent, instanceId, entry }) {
  const meta = { team, agent, instance_id: instanceId, kind: deriveKind(entry) }
  if (entry.from) meta.from = String(entry.from)
  if (entry.request_id) meta.request_id = String(entry.request_id)
  if (entry.in_reply_to) meta.in_reply_to = String(entry.in_reply_to)
  if (entry.orchestrator_session_id) meta.orchestrator_session_id = String(entry.orchestrator_session_id)
  if (entry.summary) meta.summary = String(entry.summary)
  if (entry.timestamp) meta.timestamp = String(entry.timestamp)
  return meta
}

async function emit(server, ctx, entry) {
  await server.notification({
    method: 'notifications/claude/channel',
    params: { content: entry.text ?? '', meta: buildMeta({ ...ctx, entry }) },
  })
}

function sidecarPath(inboxPath, suffix) {
  const ext = extname(inboxPath) || '.json'
  const base = basename(inboxPath, ext)
  return join(dirname(inboxPath), `${base}.${suffix}`)
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function appendChannelError(errorPath, { team, agent, instanceId, dedupeKey: key, error, retryCount }) {
  const line = {
    timestamp: new Date().toISOString(),
    team,
    agent,
    instanceId,
    dedupeKey: key,
    error_message: errorMessage(error),
    retry_count: retryCount,
  }
  await appendFile(errorPath, `${JSON.stringify(line)}\n`, 'utf8')
}

async function readLastEmitted(lastEmittedPath) {
  let raw
  try {
    raw = await readFile(lastEmittedPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed?.lastEmittedKey === 'string' && parsed.lastEmittedKey.length > 0
      ? parsed
      : null
  } catch {
    return null
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await rename(tmp, filePath)
  } catch (error) {
    try { await unlink(tmp) } catch {}
    throw error
  }
}

function seedSeenFromBaseline(entries, lastEmittedKey) {
  const seen = new Set()
  if (!lastEmittedKey) {
    for (const entry of entries) seen.add(dedupeKey(entry))
    return seen
  }

  const lastIndex = entries.findIndex(entry => dedupeKey(entry) === lastEmittedKey)
  if (lastIndex < 0) {
    for (const entry of entries) seen.add(dedupeKey(entry))
    return seen
  }
  for (let i = 0; i <= lastIndex; i += 1) seen.add(dedupeKey(entries[i]))
  return seen
}

// Module-level registry keyed by `${team}:${agent}` so a process that adds the
// same identity twice (e.g. SessionStart hook + a subsequent team_add_watch
// tool call) reuses the existing watcher rather than spinning up duplicates
// and double-emitting every notification. Each entry holds `{ team, agent,
// close, rescan }`.
const _activeWatchers = new Map()

function _watchKey(team, agent) {
  return `${team}:${agent}`
}

/**
 * Parse the optional RELVETIA_AGENT_ALIASES env var. Each alias is an extra
 * (team, agent) binding the subprocess should also watch in addition to the
 * primary env-driven binding. Used by spawn-relay / SessionStart pre-seeding
 * when a session needs proactive notify for more than one mailbox (e.g. a
 * Discord-launched session bound to `discord-claude/claude-N` that also
 * needs to receive on `relvetia/orchestrator-meta-phase2` from
 * team_clone_member).
 *
 * Shape: `'[{"team":"T1","agent":"A1"},{"team":"T2","agent":"A2"}]'`. Malformed
 * input logs a warning and returns []; entries missing either field are
 * dropped.
 *
 * @returns {Array<{team: string, agent: string}>}
 */
export function parseAgentAliases() {
  const raw = process.env.RELVETIA_AGENT_ALIASES
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logErr(new Error(`Invalid RELVETIA_AGENT_ALIASES (must be JSON array of {team,agent}): ${errorMessage(err)}`))
    return []
  }
  if (!Array.isArray(parsed)) {
    logErr(new Error('RELVETIA_AGENT_ALIASES must be a JSON array, got ' + typeof parsed))
    return []
  }
  return parsed.filter(a => a && typeof a.team === 'string' && a.team.length > 0 && typeof a.agent === 'string' && a.agent.length > 0)
}

/**
 * List active channel watchers. Returns a snapshot — mutating the returned
 * array does not affect the registry. Public so tests / debugging tools /
 * future telemetry can inspect which bindings the subprocess is honoring.
 *
 * @returns {Array<{team: string, agent: string}>}
 */
export function listChannelWatches() {
  return Array.from(_activeWatchers.values()).map(w => ({ team: w.team, agent: w.agent }))
}

/**
 * Close every active channel watcher and reset the registry. Used by tests
 * that share a process across describe blocks; production teardown should
 * still call close() on the individual handles returned by initChannels /
 * addChannelWatch so process.once('exit') hooks can target a specific one.
 */
export function closeAllChannelWatches() {
  for (const w of [..._activeWatchers.values()]) {
    try { w.close() } catch {}
  }
  _activeWatchers.clear()
}

/**
 * Build the watcher state for one (team, agent) pair. Private; callers go
 * through addChannelWatch (which handles registry dedup) or initChannels
 * (which handles env-default resolution + primary binding).
 */
async function _initSingleWatch(server, { team, agent, instanceId, channelErrorsPath: errPath, lastEmittedPath: lePath, isTransportAlive: probe, enableFsWatch = true, enableInitialRescan = true }) {
  const inboxPath = getInboxPath(team, agent)
  const channelErrorsPath = errPath ?? sidecarPath(inboxPath, 'channel-errors.jsonl')
  const lastEmittedPath = lePath ?? sidecarPath(inboxPath, 'last-emitted.json')
  const isTransportAlive = typeof probe === 'function' ? probe : () => true

  await ensureDir(getInboxDir(team))
  try {
    await writeFile(inboxPath, '', { flag: 'wx' })
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e
  }

  const baselineRaw = await readFile(inboxPath, 'utf-8').catch(e => {
    if (e?.code === 'ENOENT') return ''
    throw e
  })
  const baselineEntries = parseInboxSafe(baselineRaw, inboxPath)
  const lastEmitted = await readLastEmitted(lastEmittedPath)
  const seen = seedSeenFromBaseline(baselineEntries, lastEmitted?.lastEmittedKey)
  const retryCounts = new Map()

  let closed = false
  let watcher = null
  let pollTimer = null
  let rescanInFlight = null

  async function rescanInner() {
    if (closed) return
    let raw
    try {
      raw = await readFile(inboxPath, 'utf-8')
    } catch (e) {
      if (e?.code === 'ENOENT') return
      throw e
    }
    const entries = parseInboxSafe(raw, inboxPath)
    for (const entry of entries) {
      if (closed) return
      const key = dedupeKey(entry)
      if (seen.has(key)) continue
      try {
        await emit(server, { team, agent, instanceId }, entry)
        if (!isTransportAlive()) {
          throw new Error('MCP transport liveness probe failed after notification resolve')
        }
        await writeJsonAtomic(lastEmittedPath, {
          team,
          agent,
          lastEmittedKey: key,
          ts: new Date().toISOString(),
          instanceId,
        })
        seen.add(key)
        retryCounts.delete(key)
      } catch (e) {
        const retryCount = (retryCounts.get(key) ?? 0) + 1
        retryCounts.set(key, retryCount)
        await appendChannelError(channelErrorsPath, {
          team,
          agent,
          instanceId,
          dedupeKey: key,
          error: e,
          retryCount,
        }).catch(logErr)
        logErr(e)
      }
    }
  }

  // Coalesce overlapping rescans so a burst of fs.watch events doesn't
  // cause out-of-order JSONL parses. New rescan calls during an in-flight
  // run wait for it to settle and then re-run once.
  function rescan() {
    if (rescanInFlight) {
      return rescanInFlight.then(() => {
        if (closed) return
        return rescan()
      })
    }
    rescanInFlight = rescanInner()
      .catch(logErr)
      .finally(() => { rescanInFlight = null })
    return rescanInFlight
  }

  if (enableFsWatch) {
    try {
      watcher = fsWatch(inboxPath, { persistent: true }, () => {
        rescan()
      })
      watcher.on('error', logErr)
    } catch (e) {
      logErr(e)
    }
  }

  // Race-window absorption: an entry may be appended between baseline read
  // and watcher arming. setImmediate gives the event loop one tick to drain
  // before a defensive rescan.
  if (enableInitialRescan) setImmediate(() => { rescan() })

  // Polling backup: Windows fs.watch occasionally drops events on atomic
  // rename writes (the rare full-rewrite path in mailbox.js).
  pollTimer = setInterval(() => { rescan() }, POLL_INTERVAL_MS)
  if (typeof pollTimer.unref === 'function') pollTimer.unref()

  function close() {
    if (closed) return
    closed = true
    if (watcher) {
      try { watcher.close() } catch {}
      watcher = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return { close, rescan }
}

/**
 * Register an additional channels watcher for a (team, agent) binding. Safe
 * to call repeatedly: the second call for the same key is a no-op and reuses
 * the existing watcher's `close` / `rescan`. Returns the same shape as
 * initChannels() plus a `deduped: boolean` flag so callers can tell whether a
 * new watcher was actually started.
 *
 * Use case: a session whose primary RELVETIA_TEAM/RELVETIA_AGENT env binding
 * (e.g. `discord-claude/claude-N` for sessions launched via rhi-discord-bot)
 * needs proactive notify on a secondary identity created at runtime via
 * `team_clone_member` (e.g. `relvetia/orchestrator-meta-phase2`). Without
 * this, the secondary inbox accumulates messages that the channels layer
 * never pushes because it was only watching the primary binding (incident
 * observed 2026-05-25 — see ../docs/multi-watch-channels.md trail).
 *
 * @param {object} server - low-level MCP Server instance
 * @param {object} [opts]
 * @param {string} [opts.team]       - defaults to RELVETIA_TEAM / CLAUDE_SWARM_TEAM env
 * @param {string} [opts.agent]      - defaults to RELVETIA_AGENT / CLAUDE_SWARM_AGENT env
 * @param {string} [opts.instanceId] - defaults to RELVETIA_AGENT_INSTANCE_ID or a fresh UUID
 * @param {boolean} [opts.enableFsWatch]       - default true; tests / polling-only setups can disable
 * @param {boolean} [opts.enableInitialRescan] - default true; same
 * @returns {Promise<{ close: () => void, rescan: () => Promise<void>, deduped: boolean }>}
 */
export async function addChannelWatch(server, opts = {}) {
  const team = opts.team ?? process.env.RELVETIA_TEAM ?? process.env.CLAUDE_SWARM_TEAM
  const agent = opts.agent ?? process.env.RELVETIA_AGENT ?? process.env.CLAUDE_SWARM_AGENT
  if (!team || !agent) {
    return { close: () => {}, rescan: async () => {}, deduped: false }
  }

  const key = _watchKey(team, agent)
  const existing = _activeWatchers.get(key)
  if (existing) {
    return { close: existing.close, rescan: existing.rescan, deduped: true }
  }

  const instanceId = opts.instanceId ?? process.env.RELVETIA_AGENT_INSTANCE_ID ?? randomUUID()
  const handle = await _initSingleWatch(server, {
    team,
    agent,
    instanceId,
    channelErrorsPath: opts.channelErrorsPath,
    lastEmittedPath: opts.lastEmittedPath,
    isTransportAlive: opts.isTransportAlive,
    enableFsWatch: opts.enableFsWatch,
    enableInitialRescan: opts.enableInitialRescan,
  })

  // Wrap close so the registry entry is removed when the caller (or our own
  // closeAllChannelWatches) tears the watcher down. Idempotent: a second
  // close() invocation hits the inner closed guard, then no-ops the delete.
  const wrappedClose = () => {
    try { handle.close() } catch {}
    _activeWatchers.delete(key)
  }
  const entry = { team, agent, close: wrappedClose, rescan: handle.rescan }
  _activeWatchers.set(key, entry)
  return { close: wrappedClose, rescan: handle.rescan, deduped: false }
}

/**
 * Initialize the channel watcher for this subprocess. Thin compatibility
 * wrapper over addChannelWatch — preserved verbatim so existing callers
 * (index.js bootstrap, channels.test.js, downstream consumers) continue to
 * work unchanged. For runtime multi-identity setups, prefer addChannelWatch
 * directly.
 *
 * @param {object} server - low-level Server instance (mcpServer.server)
 * @param {object} [opts]
 * @param {string} [opts.team]       - defaults to env RELVETIA_TEAM
 * @param {string} [opts.agent]      - defaults to env RELVETIA_AGENT
 * @param {string} [opts.instanceId] - defaults to env RELVETIA_AGENT_INSTANCE_ID or random UUID
 * @returns {Promise<{ close: () => void, rescan: () => Promise<void> }>}
 */
export async function initChannels(server, opts = {}) {
  const { close, rescan } = await addChannelWatch(server, opts)
  return { close, rescan }
}
