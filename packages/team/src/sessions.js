// Sessions — inspired by OpenAI Agents SDK SessionABC.
// Provides full conversation history access (not just unread) via a stable
// interface so future backends (SQLite, encrypted, remote) can be swapped in.
//
// The default implementation is a thin wrapper over mailbox.js — stored as
// per-agent JSON files. Operations that mutate state go through the same
// file-lock machinery, so concurrent reads/writes remain safe.

import { writeFile } from 'node:fs/promises'
import { getInboxPath, getInboxDir, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeFileAtomic } from './fs-utils.js'
import { errorMessage, isEnoent } from './errors.js'
import { writeToMailbox, readMailbox, parseInboxSafe } from './mailbox.js'
import { readFile } from 'node:fs/promises'

/**
 * Get session items (full history) for an agent.
 *
 * @param {string} teamName
 * @param {string} agentName
 * @param {object} [opts]
 * @param {number} [opts.limit]  — return only the last N items
 * @param {string} [opts.since]  — ISO timestamp; filter items with timestamp >= since
 * @param {boolean} [opts.unreadOnly] — only unread items (read/unread still tracked in-file)
 */
export async function getItems(teamName, agentName, opts = {}) {
  let items = await readMailbox(teamName, agentName)

  if (opts.unreadOnly) items = items.filter(m => m && !m.read)
  if (opts.since) items = items.filter(m => m?.timestamp && m.timestamp >= opts.since)
  if (opts.limit && opts.limit > 0 && items.length > opts.limit) {
    items = items.slice(items.length - opts.limit)
  }
  return items
}

/**
 * Add an item to the session (alias for writeToMailbox, so hooks and
 * guardrails run consistently).
 */
export async function addItem(teamName, agentName, item) {
  return await writeToMailbox(teamName, agentName, item)
}

/**
 * Remove and return the most recent item from the session. Returns null if
 * the session is empty. Mirrors Agents SDK's pop_item() semantics, useful
 * for undo / retry.
 */
export async function popItem(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName)
  await ensureDir(getInboxDir(teamName))

  let popped = null
  try {
    await withLock(inboxPath, async () => {
      let raw
      try {
        raw = await readFile(inboxPath, 'utf-8')
      } catch (e) {
        if (isEnoent(e)) return
        throw e
      }
      const messages = parseInboxSafe(raw, inboxPath)
      if (messages.length === 0) return
      popped = messages.pop()
      const serialized = messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '')
      await writeFileAtomic(inboxPath, serialized)
    }, { lockfilePath: `${inboxPath}.lock` })
  } catch (e) {
    if (isEnoent(e)) return null
    console.error(`[sessions] popItem failed: ${errorMessage(e)}`)
  }
  return popped
}

/**
 * Clear all session items for an agent.
 */
export async function clearSession(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName)
  await ensureDir(getInboxDir(teamName))
  try {
    await withLock(inboxPath, async () => {
      await writeFile(inboxPath, '')
    }, { lockfilePath: `${inboxPath}.lock` })
  } catch (e) {
    if (isEnoent(e)) return
    throw e
  }
}

/**
 * Count items in the session.
 */
export async function countItems(teamName, agentName) {
  const items = await readMailbox(teamName, agentName)
  return items.length
}
