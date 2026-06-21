// Tracing — inspired by OpenAI Agents SDK auto-instrumented spans.
// Emits JSONL spans to ~/.claude/teams/{team}/traces.jsonl (append-only).
// Uses AsyncLocalStorage so nested tool calls inherit trace_id/parent_span_id
// without explicit threading — mirrors the SDK's contextvar pattern.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { getTeamDir, ensureDir } from './paths.js'
import { errorMessage } from './errors.js'

const storage = new AsyncLocalStorage()

// Global processors; each receives every completed span.
// Default processor = JSONL file sink. Users may add custom processors
// (e.g. forward to Langfuse) via addProcessor().
const processors = [jsonlSink]

// Disable via env var, matching OPENAI_AGENTS_DISABLE_TRACING convention.
const DISABLED = process.env.CLAUDE_SWARM_DISABLE_TRACING === '1'

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

function globalTracePath() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'swarm-traces.jsonl')
}

function tracePathFor(teamName) {
  if (!teamName) return globalTracePath()
  try {
    return join(getTeamDir(teamName), 'traces.jsonl')
  } catch {
    // sanitize may throw on empty team name
    return globalTracePath()
  }
}

async function jsonlSink(span) {
  if (DISABLED) return
  const path = tracePathFor(span.team_name)
  try {
    await ensureDir(dirname(path))
    await appendFile(path, JSON.stringify(span) + '\n')
  } catch (e) {
    console.error(`[tracing] Failed to write span: ${errorMessage(e)}`)
  }
}

/**
 * Register an additional span processor. Called with the finished span object.
 */
export function addProcessor(fn) {
  processors.push(fn)
}

/**
 * Replace all processors (useful for tests or to disable the default sink).
 */
export function setProcessors(fns) {
  processors.length = 0
  processors.push(...fns)
}

/**
 * Get the current span context (trace_id, span_id) if inside a span.
 */
export function currentContext() {
  return storage.getStore() || null
}

/**
 * Run fn() inside a new span. The span inherits trace_id from the parent
 * (if any), becomes the parent_span_id for any nested spans, and is emitted
 * to all processors once fn() settles.
 *
 * @param {string} name - Span name (e.g., "tool.team_send_message")
 * @param {object} attrs - Arbitrary attributes (tool args, team_name, etc.)
 * @param {Function} fn - Async function to execute within the span
 */
export async function withSpan(name, attrs, fn) {
  if (DISABLED) return fn()

  const parent = storage.getStore()
  const ctx = {
    trace_id: parent?.trace_id || newId('trace'),
    span_id: newId('span'),
    parent_span_id: parent?.span_id || null,
    team_name: attrs.team_name || parent?.team_name || null,
  }

  const start = Date.now()
  let status = 'ok'
  let errorMsg = null
  try {
    return await storage.run(ctx, fn)
  } catch (e) {
    status = 'error'
    errorMsg = errorMessage(e)
    throw e
  } finally {
    const span = {
      name,
      trace_id: ctx.trace_id,
      span_id: ctx.span_id,
      parent_span_id: ctx.parent_span_id,
      team_name: ctx.team_name,
      attrs,
      status,
      error: errorMsg,
      started_at: new Date(start).toISOString(),
      duration_ms: Date.now() - start,
    }
    for (const p of processors) {
      try {
        await p(span)
      } catch (e) {
        console.error(`[tracing] Processor failed: ${errorMessage(e)}`)
      }
    }
  }
}

/**
 * Fire a standalone event (zero-duration span) under the current context.
 * Use for things like guardrail_tripped, hook_fired.
 */
export async function emitEvent(name, attrs = {}) {
  if (DISABLED) return
  const parent = storage.getStore()
  const span = {
    name,
    trace_id: parent?.trace_id || newId('trace'),
    span_id: newId('span'),
    parent_span_id: parent?.span_id || null,
    team_name: attrs.team_name || parent?.team_name || null,
    attrs,
    status: 'event',
    error: null,
    started_at: new Date().toISOString(),
    duration_ms: 0,
  }
  for (const p of processors) {
    try {
      await p(span)
    } catch (e) {
      console.error(`[tracing] Processor failed on event: ${errorMessage(e)}`)
    }
  }
}
