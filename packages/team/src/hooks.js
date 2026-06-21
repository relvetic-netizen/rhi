// Lifecycle hooks — inspired by OpenAI Agents SDK RunHooks / AgentHooks.
// Users define hooks in ~/.claude/swarm-hooks.mjs (optional). The file exports
// an object with event handlers. All hooks are async, failures are swallowed
// with logging so a broken hook never crashes tool execution.
//
// Events:
//   - before_tool  ({ tool, args })
//   - after_tool   ({ tool, args, result, error, duration_ms })
//   - on_message   ({ team, to, from, message })    — fired after mailbox write
//   - on_task_update ({ team, task_id, updates, task })
//
// Example user hook file (~/.claude/swarm-hooks.mjs):
//   export async function before_tool({ tool, args }) {
//     console.error(`[hook] ${tool} called with`, Object.keys(args))
//   }

import { join } from 'node:path'
import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { errorMessage } from './errors.js'

// Cache the load *promise*, not just the result. Previous implementation
// assigned `loaded = true` before the import() awaited, so concurrent callers
// could re-enter loadHooks and return the still-null `cached` value.
let loadPromise = null

function hooksPath() {
  const base = process.env.CLAUDE_SWARM_HOOKS_FILE
  if (base) return base
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'swarm-hooks.mjs')
}

async function loadHooksOnce() {
  const path = hooksPath()
  try {
    await access(path)
  } catch {
    return {}
  }
  try {
    const mod = await import(pathToFileURL(path).href)
    return mod.default || mod
  } catch (e) {
    console.error(`[hooks] Failed to load ${path}: ${errorMessage(e)}`)
    return {}
  }
}

async function loadHooks() {
  if (!loadPromise) loadPromise = loadHooksOnce()
  return loadPromise
}

/**
 * Fire an event. Never throws — hook errors are logged and swallowed.
 */
export async function fireHook(event, payload) {
  const mod = await loadHooks()
  const fn = mod[event]
  if (typeof fn !== 'function') return
  try {
    await fn(payload)
  } catch (e) {
    console.error(`[hooks] ${event} hook failed: ${errorMessage(e)}`)
  }
}

/**
 * Reset cache (for tests).
 */
export function _resetHooks() {
  loadPromise = null
}
