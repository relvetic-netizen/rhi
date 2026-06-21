// Guardrails — inspired by OpenAI Agents SDK input/output validators.
// Per-team config at ~/.claude/teams/{team}/guardrails.json.
// Runs on message write (input guardrail) and read (output guardrail).
// A tripped guardrail either blocks delivery or rewrites the message.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { getTeamDir } from './paths.js'
import { errorMessage, isEnoent } from './errors.js'
import { emitEvent } from './tracing.js'

// RE2 (Google's linear-time regex engine) is loaded via createRequire so the
// rest of the module still imports cleanly when re2 is unavailable (e.g. on
// platforms without prebuilt binaries). We only use RE2 for the
// `auto_require_approval` rule type — those patterns come from team config
// files and may be authored by less trusted operators, so we want hard
// linear-time guarantees against catastrophic backtracking. The legacy
// `blocklist` regex path keeps standard RegExp; that path is out of scope
// for this commit.
const _require = createRequire(import.meta.url)
let RE2 = null
try {
  RE2 = _require('re2')
} catch (e) {
  console.error(
    `[guardrails] Could not load 're2' (${errorMessage(e)}). ` +
    `Falling back to native RegExp for auto_require_approval — ` +
    `catastrophic-backtracking patterns will NOT be protected.`
  )
}

// Hard caps on auto_require_approval regex/substring config. Prevents
// pathological configs (or compromised guardrails.json) from turning each
// inbound message into a heavy compute job or a config-driven oracle.
export const MAX_AUTO_APPROVAL_PATTERNS = 50
export const MAX_AUTO_APPROVAL_PATTERN_LENGTH = 1000
// Inputs longer than this are not regex-tested at all (we conservatively
// fall through to the next matcher / next rule). 1 MiB matches typical
// max_length guardrail upper bounds and gives an additional belt-and-braces
// limit even without a max_length rule in front.
export const MAX_AUTO_APPROVAL_TEXT_LENGTH = 1024 * 1024

/**
 * Guardrail config schema (per-team JSON file):
 * {
 *   "input": [{ "type": "max_length", "limit": 10000, "action": "block" }, ...],
 *   "output": [...]
 * }
 *
 * Built-in types:
 *   - max_length  — { limit: number, action: 'block' | 'truncate' }
 *   - blocklist   — { patterns: string[], mode: 'substring'|'regex', action: 'block'|'redact' }
 *   - min_length  — { limit: number, action: 'block' }
 *   - required_from — { allowed: string[], action: 'block' } (sender allowlist)
 *   - auto_require_approval — { match: { mode, patterns?, min_length?, from_not_in? }, approval_kind? }
 *       When the rule's `match` matches, rewrites the message in-place to set
 *       `requires_approval=true` (and optionally `approval_kind`). The mailbox
 *       writer then re-routes the message through the existing approval queue
 *       instead of delivering it. Distinct from `block` because the message is
 *       not destroyed — team-lead can review and approve. Use this to enforce
 *       human review for sensitive content patterns without writing a custom
 *       hook.
 *
 * action=block returns { tripwire: true, reason, redirect_to?: 'team-lead' }
 * action=truncate/redact returns { tripwire: false, message: rewritten }
 * auto_require_approval returns { tripwire: false, message: rewritten-with-requires_approval }
 */

function guardrailsPathFor(teamName) {
  return join(getTeamDir(teamName), 'guardrails.json')
}

// Tiny in-process cache keyed by team name. A cache entry stores the parsed
// config PLUS its pre-compiled regex patterns so we don't re-compile on every
// message. Entries are re-read if the file's mtime has changed.
const configCache = new Map()  // teamName -> { mtimeMs, config }

// Compile one user-supplied regex source for auto_require_approval. Prefers
// RE2 (linear-time, no catastrophic backtracking) and falls back to RegExp
// only when RE2 is unavailable OR when the pattern uses features RE2 does
// not support (backreferences, lookaround). The fallback path is logged so
// operators can audit which patterns lost the linear-time guarantee.
function compileApprovalRegex(source) {
  if (RE2) {
    try {
      return { source, re: new RE2(source, 'i'), engine: 're2' }
    } catch (e) {
      console.error(
        `[guardrails] auto_require_approval regex "${source}" not RE2-compatible (${errorMessage(e)}); ` +
        `falling back to native RegExp without ReDoS protection.`
      )
      // fall through to RegExp
    }
  }
  try {
    return { source, re: new RegExp(source, 'i'), engine: 'regexp' }
  } catch (e) {
    console.error(`[guardrails] Invalid auto_require_approval regex "${source}": ${errorMessage(e)} — skipping`)
    return null
  }
}

async function compileRule(rule) {
  if (rule.type === 'auto_require_approval') {
    const m = rule.match || {}
    if (m.mode === 'regex' && Array.isArray(m.patterns)) {
      // Cap pattern array length up front so a config with thousands of
      // patterns can't make every message a heavy compute job.
      const rawPatterns = m.patterns.slice(0, MAX_AUTO_APPROVAL_PATTERNS)
      if (m.patterns.length > MAX_AUTO_APPROVAL_PATTERNS) {
        console.error(
          `[guardrails] auto_require_approval regex pattern array length ${m.patterns.length} ` +
          `exceeds cap ${MAX_AUTO_APPROVAL_PATTERNS}; using first ${MAX_AUTO_APPROVAL_PATTERNS} only.`
        )
      }
      const compiled = []
      for (const p of rawPatterns) {
        if (typeof p !== 'string' || p.length === 0) {
          console.error(`[guardrails] auto_require_approval regex pattern empty/non-string — skipping (would match every message)`)
          continue
        }
        if (p.length > MAX_AUTO_APPROVAL_PATTERN_LENGTH) {
          console.error(
            `[guardrails] auto_require_approval regex pattern length ${p.length} ` +
            `exceeds cap ${MAX_AUTO_APPROVAL_PATTERN_LENGTH}; skipping.`
          )
          continue
        }
        const c = compileApprovalRegex(p)
        if (c) compiled.push(c)
      }
      return { ...rule, _matchCompiled: compiled }
    }
    if (m.mode === 'substring' && Array.isArray(m.patterns) && m.patterns.length > MAX_AUTO_APPROVAL_PATTERNS) {
      console.error(
        `[guardrails] auto_require_approval substring pattern array length ${m.patterns.length} ` +
        `exceeds cap ${MAX_AUTO_APPROVAL_PATTERNS}; truncating.`
      )
      return { ...rule, match: { ...m, patterns: m.patterns.slice(0, MAX_AUTO_APPROVAL_PATTERNS) } }
    }
    return rule
  }
  if (rule.type !== 'blocklist' || rule.mode !== 'regex') return rule
  const patterns = Array.isArray(rule.patterns) ? rule.patterns : []
  const compiled = []
  for (const p of patterns) {
    try {
      compiled.push({ source: p, re: new RegExp(p, 'i'), reGlobal: new RegExp(p, 'gi') })
    } catch (e) {
      console.error(`[guardrails] Invalid regex "${p}": ${errorMessage(e)} — skipping`)
    }
  }
  return { ...rule, _compiled: compiled }
}

async function compileConfig(parsed) {
  const input = Array.isArray(parsed.input) ? parsed.input : []
  const output = Array.isArray(parsed.output) ? parsed.output : []
  return {
    input: await Promise.all(input.map(compileRule)),
    output: await Promise.all(output.map(compileRule)),
  }
}

export async function loadGuardrails(teamName) {
  const path = guardrailsPathFor(teamName)
  let stat
  try {
    const { stat: statFn } = await import('node:fs/promises')
    stat = await statFn(path)
  } catch (e) {
    if (isEnoent(e)) return { input: [], output: [] }
    console.error(`[guardrails] stat failed for ${teamName}: ${errorMessage(e)}`)
    return { input: [], output: [] }
  }

  const cached = configCache.get(teamName)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.config

  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw)
    const config = await compileConfig(parsed)
    configCache.set(teamName, { mtimeMs: stat.mtimeMs, config })
    return config
  } catch (e) {
    console.error(`[guardrails] Failed to load ${teamName}: ${errorMessage(e)}`)
    return { input: [], output: [] }
  }
}

/**
 * Drop the cache entry for a team. Exposed for tests.
 */
export function _clearGuardrailCache(teamName) {
  if (teamName === undefined) configCache.clear()
  else configCache.delete(teamName)
}

// ReDoS defense: soft upper bound on how long we'll let a single regex.test run.
// JavaScript regexes can't be hard-killed mid-execution, but we can detect
// pathological patterns by timing each test and surfacing a warning. In
// practice this combined with i-case-only-no-global-loop mitigates most
// exponential patterns against bounded message sizes.
const REGEX_TEST_TIMEOUT_MS = 100

function safeRegexTest(re, text, patternSource) {
  const start = Date.now()
  const result = re.test(text)
  const elapsed = Date.now() - start
  if (elapsed > REGEX_TEST_TIMEOUT_MS) {
    console.error(
      `[guardrails] Slow regex "${patternSource}" took ${elapsed}ms against ${text.length}-char input. ` +
      `Consider simplifying the pattern to avoid catastrophic backtracking.`
    )
  }
  return result
}

function applyMaxLength(message, rule) {
  const text = message.text || ''
  if (text.length <= rule.limit) return { message }
  if (rule.action === 'truncate') {
    return {
      message: { ...message, text: text.slice(0, rule.limit) + '\n[truncated by guardrail]' },
    }
  }
  return { tripwire: true, reason: `message exceeds ${rule.limit} chars (got ${text.length})` }
}

function applyMinLength(message, rule) {
  const text = message.text || ''
  if (text.length >= rule.limit) return { message }
  return { tripwire: true, reason: `message shorter than ${rule.limit} chars` }
}

function applyBlocklist(message, rule) {
  const text = message.text || ''

  // Regex mode uses precompiled patterns from loadGuardrails.
  if (rule.mode === 'regex') {
    const compiled = Array.isArray(rule._compiled) ? rule._compiled : []
    for (const { source, re, reGlobal } of compiled) {
      if (!safeRegexTest(re, text, source)) continue
      if (rule.action === 'redact') {
        return { message: { ...message, text: text.replace(reGlobal, '[REDACTED]') } }
      }
      return { tripwire: true, reason: `blocklist match: "${source}"` }
    }
    return { message }
  }

  // Substring mode — case-insensitive, linear.
  const lower = text.toLowerCase()
  const patterns = Array.isArray(rule.patterns) ? rule.patterns : []
  for (const p of patterns) {
    if (!lower.includes(p.toLowerCase())) continue
    if (rule.action === 'redact') {
      return { message: { ...message, text: text.split(p).join('[REDACTED]') } }
    }
    return { tripwire: true, reason: `blocklist match: "${p}"` }
  }
  return { message }
}

function applyRequiredFrom(message, rule) {
  const allowed = Array.isArray(rule.allowed) ? rule.allowed : []
  if (allowed.includes(message.from)) return { message }
  return { tripwire: true, reason: `sender "${message.from}" not in allowlist` }
}

function applyAutoRequireApproval(message, rule) {
  // If already flagged, no-op (don't duplicate-enqueue or override).
  if (message.requires_approval) return { message }

  const m = rule.match || {}
  const text = message.text || ''
  let matched = false
  let reason = ''

  // min_length must be a positive integer. min_length:0 (or negative) is
  // a config error that would silently match every message.
  if (
    typeof m.min_length === 'number' &&
    Number.isFinite(m.min_length) &&
    m.min_length > 0 &&
    text.length >= m.min_length
  ) {
    matched = true
    reason = `auto-approval: text length ≥ ${m.min_length}`
  }

  // from_not_in: a sender NOT on the trusted list (or missing entirely)
  // triggers approval. Treat sender-missing as untrusted — anonymous
  // messages must not bypass the allowlist.
  if (!matched && Array.isArray(m.from_not_in)) {
    const allowed = m.from_not_in.filter(x => typeof x === 'string')
    const sender = typeof message.from === 'string' ? message.from : ''
    if (!allowed.includes(sender)) {
      matched = true
      reason = sender
        ? `auto-approval: sender "${sender}" not in trusted list`
        : 'auto-approval: sender missing (not in trusted list)'
    }
  }

  if (!matched && m.mode === 'regex' && Array.isArray(rule._matchCompiled)) {
    // Belt-and-braces: even with RE2 we don't run regex against absurdly
    // long inputs. RE2 is linear in the input size, but linear * 50 MB is
    // still enough to noticeably stall the MCP server's event loop.
    if (text.length > MAX_AUTO_APPROVAL_TEXT_LENGTH) {
      console.error(
        `[guardrails] auto_require_approval skipping regex match: input length ${text.length} ` +
        `exceeds cap ${MAX_AUTO_APPROVAL_TEXT_LENGTH}.`
      )
    } else {
      for (const { source, re } of rule._matchCompiled) {
        if (safeRegexTest(re, text, source)) {
          matched = true
          reason = `auto-approval: pattern "${source}" matched`
          break
        }
      }
    }
  } else if (!matched && m.mode === 'substring' && Array.isArray(m.patterns)) {
    const lower = text.toLowerCase()
    for (const p of m.patterns) {
      const lp = String(p).toLowerCase()
      // Skip empty/non-string patterns — `''.includes('')` is always true,
      // which would silently match every message.
      if (lp.length === 0) continue
      if (lower.includes(lp)) {
        matched = true
        reason = `auto-approval: substring "${p}" matched`
        break
      }
    }
  }

  if (!matched) return { message }

  return {
    message: {
      ...message,
      requires_approval: true,
      _auto_approval_reason: reason,
      ...(rule.approval_kind ? { _auto_approval_kind: rule.approval_kind } : {}),
    },
  }
}

const BUILTIN = {
  max_length: applyMaxLength,
  min_length: applyMinLength,
  blocklist: applyBlocklist,
  required_from: applyRequiredFrom,
  auto_require_approval: applyAutoRequireApproval,
}

/**
 * Run a list of rules against a message.
 * Returns { tripwire, reason, redirect_to, message (possibly rewritten) }.
 * First tripwire short-circuits.
 */
export async function runGuardrails(teamName, direction, message) {
  const config = await loadGuardrails(teamName)
  const rules = config[direction] || []

  let current = message
  for (const rule of rules) {
    if (rule.enabled === false) continue
    const fn = BUILTIN[rule.type]
    if (!fn) {
      console.error(`[guardrails] Unknown rule type: ${rule.type}`)
      continue
    }
    const result = fn(current, rule)
    if (result.tripwire) {
      await emitEvent('guardrail.tripped', {
        team_name: teamName,
        direction,
        rule_type: rule.type,
        reason: result.reason,
        from: message.from,
      })
      return {
        tripwire: true,
        reason: result.reason,
        redirect_to: rule.redirect_to || null,
        message: current,
      }
    }
    if (result.message) current = result.message
  }
  return { tripwire: false, message: current }
}
