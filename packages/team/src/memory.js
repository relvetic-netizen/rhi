// Memory — three-tier knowledge persistence inspired by the distinction
// between "logs" (what happened) and "briefings" (what the next version of
// me needs to know). Tier 1 = inbox/session (existing, ephemeral).
// Tier 2 = per-agent notes (episodic, lab-notebook-style). Tier 3 = curated
// team knowledge (cross-session, searchable).
//
// Storage: JSONL (one record per line, append-only) so concurrent writes
// don't corrupt earlier entries.

import { readFile, appendFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { getTeamDir, sanitize } from './paths.js'
import { errorMessage, isEnoent } from './errors.js'
import { screenItems, tokenize } from './screening/screening.js'
import {
  SEARCH_THRESHOLD, SEARCH_MAX_RESULTS, SEARCH_RETURN_BUDGET_BYTES,
  RECENCY_HALF_LIFE_MS,
} from './screening/config.js'
import { emitEvent } from './tracing.js'

export const NOTE_KINDS = [
  'finding',        // observed fact about the codebase/task
  'decision',       // choice made and rationale
  'assumption',     // unverified belief being acted on
  'open_question',  // unresolved, needs answer
  'next_step',      // concrete action to take next
  'gotcha',         // surprising pitfall worth warning about
]

function notesPath(teamName, agentName) {
  return join(getTeamDir(teamName), 'notes', `${sanitize(agentName)}.jsonl`)
}

function knowledgePath(teamName) {
  return join(getTeamDir(teamName), 'knowledge.jsonl')
}

async function appendJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(record) + '\n')
}

async function readJsonl(path) {
  try {
    const raw = await readFile(path, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    const records = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line))
      } catch (e) {
        console.error(`[memory] Skipping corrupt line in ${path}: ${errorMessage(e)}`)
      }
    }
    return records
  } catch (e) {
    if (isEnoent(e)) return []
    console.error(`[memory] Failed to read ${path}: ${errorMessage(e)}`)
    return []
  }
}

// ---------------------------------------------------------------------------
// Tier 2: per-agent notes
// ---------------------------------------------------------------------------

/**
 * Write a structured note to an agent's notebook.
 *
 * @param {string} teamName
 * @param {string} agentName
 * @param {object} note
 * @param {string} note.kind   — one of NOTE_KINDS
 * @param {string} note.content
 * @param {string} [note.topic]    — short tag for searching
 * @param {string} [note.task_id]  — task this note came from
 * @param {string[]} [note.tags]
 */
export async function writeNote(teamName, agentName, note) {
  if (!NOTE_KINDS.includes(note.kind)) {
    throw new Error(`Invalid note kind "${note.kind}". Valid: ${NOTE_KINDS.join(', ')}`)
  }
  const record = {
    id: `note_${randomBytes(6).toString('hex')}`,
    kind: note.kind,
    topic: note.topic || '',
    content: note.content,
    agent: agentName,
    task_id: note.task_id || null,
    tags: Array.isArray(note.tags) ? note.tags : [],
    timestamp: new Date().toISOString(),
  }
  await appendJsonl(notesPath(teamName, agentName), record)
  return record
}

/**
 * Read notes for an agent with optional filters.
 *
 * @param {object} [opts]
 * @param {string|string[]} [opts.kind]   — filter by kind(s)
 * @param {string}   [opts.topic]        — substring match on topic
 * @param {string}   [opts.since]        — ISO timestamp, include records with ts >= since
 * @param {number}   [opts.limit]        — return only the last N records
 * @param {string[]} [opts.tags]         — match if any tag in opts.tags is present
 */
export async function readNotes(teamName, agentName, opts = {}) {
  let notes = await readJsonl(notesPath(teamName, agentName))
  if (opts.kind) {
    const kinds = Array.isArray(opts.kind) ? opts.kind : [opts.kind]
    notes = notes.filter(n => kinds.includes(n.kind))
  }
  if (opts.topic) {
    const t = opts.topic.toLowerCase()
    notes = notes.filter(n => (n.topic || '').toLowerCase().includes(t))
  }
  if (opts.since) notes = notes.filter(n => n.timestamp >= opts.since)
  if (Array.isArray(opts.tags) && opts.tags.length > 0) {
    const wanted = new Set(opts.tags)
    notes = notes.filter(n => Array.isArray(n.tags) && n.tags.some(t => wanted.has(t)))
  }
  if (opts.limit && opts.limit > 0 && notes.length > opts.limit) {
    notes = notes.slice(notes.length - opts.limit)
  }
  return notes
}

// ---------------------------------------------------------------------------
// Tier 3: curated team knowledge
// ---------------------------------------------------------------------------

/**
 * Promote a fact into the shared team knowledge base. Intended for high-signal
 * findings — the "canonical answer" layer. Writers are typically:
 *   - an evaluator/judge agent after task review,
 *   - team-lead during synthesis,
 *   - an agent explicitly marking their own finding as team-wide.
 */
export async function promoteToKnowledge(teamName, entry) {
  const record = {
    id: `kn_${randomBytes(6).toString('hex')}`,
    topic: entry.topic || '',
    content: entry.content,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    source_agent: entry.source_agent || null,
    source_note_id: entry.source_note_id || null,
    timestamp: new Date().toISOString(),
  }
  await appendJsonl(knowledgePath(teamName), record)
  return record
}

export async function readKnowledge(teamName, opts = {}) {
  let items = await readJsonl(knowledgePath(teamName))
  if (opts.topic) {
    const t = opts.topic.toLowerCase()
    items = items.filter(k => (k.topic || '').toLowerCase().includes(t))
  }
  if (opts.since) items = items.filter(k => k.timestamp >= opts.since)
  if (Array.isArray(opts.tags) && opts.tags.length > 0) {
    const wanted = new Set(opts.tags)
    items = items.filter(k => Array.isArray(k.tags) && k.tags.some(t => wanted.has(t)))
  }
  if (opts.limit && opts.limit > 0 && items.length > opts.limit) {
    items = items.slice(items.length - opts.limit)
  }
  return items
}

// ---------------------------------------------------------------------------
// Cross-tier search
// ---------------------------------------------------------------------------

// Boolean query parser (no vector DB — keeps deps minimal).
// Syntax (Google-search-like):
//   single token            — substring match (case-insensitive)
//   tokenA tokenB           — AND (both must match)
//   tokenA OR tokenB        — OR (either matches)
//   -token                  — NOT (must not match)
//   "exact phrase"          — quoted = literal substring including spaces
// Combinations: `+jwt -redis "auth flow" OR oauth` is valid.
// Backward compat: single token without operators behaves identical to the old
// substring search, so existing callers see no behavior change.
function tokenizeQuery(query) {
  const tokens = []
  const re = /"([^"]+)"|(\S+)/g
  let m
  while ((m = re.exec(query)) !== null) {
    tokens.push(m[1] !== undefined
      ? { value: m[1], quoted: true }
      : { value: m[2], quoted: false })
  }
  return tokens
}

function buildGroups(tokens) {
  const groups = []
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]
    if (!tok.quoted && tok.value.toUpperCase() === 'OR') { i++; continue }
    let term = tok.value
    let neg = false
    if (!tok.quoted) {
      if (term.startsWith('-')) { neg = true; term = term.slice(1) }
      else if (term.startsWith('+')) { term = term.slice(1) }
    }
    if (!term) { i++; continue }
    const group = [{ term: term.toLowerCase(), neg }]
    i++
    while (i + 1 < tokens.length && !tokens[i].quoted && tokens[i].value.toUpperCase() === 'OR') {
      const next = tokens[i + 1]
      let nterm = next.value
      let nneg = false
      if (!next.quoted) {
        if (nterm.startsWith('-')) { nneg = true; nterm = nterm.slice(1) }
        else if (nterm.startsWith('+')) { nterm = nterm.slice(1) }
      }
      if (nterm) group.push({ term: nterm.toLowerCase(), neg: nneg })
      i += 2
    }
    groups.push(group)
  }
  return groups
}

function evalGroups(groups, haystack) {
  if (groups.length === 0) return true
  return groups.every(group =>
    group.some(({ term, neg }) => {
      const hit = haystack.includes(term)
      return neg ? !hit : hit
    })
  )
}

/**
 * Build a matcher function for a boolean query. Exported for reuse / testing.
 * Returns a predicate `(record) => boolean` that checks the record's
 * topic + content + tags as a single haystack.
 *
 * @param {string} query
 * @returns {(record: object) => boolean}
 */
export function makeMatcher(query) {
  const tokens = tokenizeQuery(query || '')
  if (tokens.length === 0) return () => true
  const groups = buildGroups(tokens)
  if (groups.length === 0) return () => true
  return (rec) => {
    const haystack = [
      rec.topic || '',
      rec.content || '',
      ...(Array.isArray(rec.tags) ? rec.tags : []),
    ].join(' ').toLowerCase()
    return evalGroups(groups, haystack)
  }
}

/**
 * Boolean search across notes, knowledge, and optionally the relvetia memory
 * daily logs. Case-insensitive match against topic + content + tags.
 * Returns records annotated with `_source` = 'note' | 'knowledge' | 'relvetia'.
 *
 * Query syntax: see `makeMatcher` above. Single-token queries behave as
 * before (substring match) so existing callers see no behavior change.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {'notes'|'knowledge'|'both'|'relvetia-memory'|'all'} [opts.scope='both']
 *   — 'relvetia-memory' searches ~/.claude/memory/logs/YYYY/MM/*.md only.
 *     'all' = notes + knowledge + relvetia. Other values keep prior behavior.
 * @param {string} [opts.agent]  — limit notes search to a specific agent
 * @param {string|string[]} [opts.kind]
 * @param {number} [opts.limit]  — total results cap (default 50)
 * @param {string} [opts.relvetia_root] — override base dir (default ~/.claude/memory/logs)
 */
export async function searchMemory(teamName, query, opts = {}) {
  const scope = opts.scope || 'both'
  const limit = opts.limit && opts.limit > 0 ? opts.limit : SEARCH_MAX_RESULTS
  const match = makeMatcher(query)

  const results = []
  const includeNotes = scope === 'notes' || scope === 'both' || scope === 'all'
  const includeKnowledge = scope === 'knowledge' || scope === 'both' || scope === 'all'
  const includeRelvetia = scope === 'relvetia-memory' || scope === 'all'

  if (includeNotes) {
    const agents = opts.agent ? [opts.agent] : await listNoteAgents(teamName)
    for (const agent of agents) {
      const notes = await readNotes(teamName, agent, { kind: opts.kind })
      for (const n of notes) if (match(n)) results.push({ ...n, _source: 'note' })
    }
  }
  if (includeKnowledge) {
    const k = await readKnowledge(teamName)
    for (const item of k) if (match(item)) results.push({ ...item, _source: 'knowledge' })
  }
  if (includeRelvetia) {
    const hits = await searchRelvetiaLogs(query, {
      root: opts.relvetia_root,
      limit,
    })
    for (const h of hits) results.push({ ...h, _source: 'relvetia' })
  }

  // Boolean matcher decided admission; screening enforces an absolute
  // relevance threshold (SEARCH_THRESHOLD) on top so noise notes that only
  // match a single stopword-like term drop out. Survivors are returned in
  // score-descending order. Safety valve: if screening produces nothing
  // (query was stopword-only / no token overlap), fall back to the full
  // boolean-admitted set ordered by timestamp and flag _fallback so the
  // caller can hint the user to refine the query.
  const trimmedQuery = (query || '').trim()
  const queryTokens = trimmedQuery.length > 0 ? tokenize(trimmedQuery) : []

  let ranked
  let rankedCount = 0
  let fallback = false
  if (queryTokens.length === 0) {
    results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
    ranked = results
    rankedCount = results.length
  } else {
    const scored = screenItems(
      results,
      r => ((r.topic || '') + ' ' + (r.content || '') + ' ' + (Array.isArray(r.tags) ? r.tags.join(' ') : '')),
      trimmedQuery,
      {
        threshold: SEARCH_THRESHOLD,
        maxResults: results.length,
        boostRecency: true,
        recencyHalfLifeMs: RECENCY_HALF_LIFE_MS,
      },
      r => Date.now() - new Date(r.timestamp || 0).getTime(),
    )
    rankedCount = scored.length
    if (scored.length > 0) {
      ranked = scored.map(s => s.item)
    } else {
      // Screening rejected everything (e.g., stopword-only query). Returning
      // empty would be too surprising when the boolean matcher had matches,
      // so we fall back to timestamp order and signal it.
      const ts = [...results].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
      ranked = ts
      fallback = true
    }
  }

  const totalCount = ranked.length
  const capped = ranked.slice(0, limit)

  // Byte-cap the final formatted text. We format here to mirror the index
  // handler so the budget reflects what the caller actually receives. If the
  // first item alone exceeds the budget, we grapheme-safe-truncate its line
  // and attach it via _preformatted so formatSearchLine returns it verbatim.
  let truncated = false
  let omittedCount = 0
  const bounded = []
  let runningBytes = 0
  for (const r of capped) {
    const line = formatSearchLine(r)
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1
    if (runningBytes + lineBytes > SEARCH_RETURN_BUDGET_BYTES) {
      if (bounded.length === 0) {
        const marker = ' …[TRUNCATED]'
        const headerBytes = Buffer.byteLength(marker, 'utf8')
        const room = Math.max(0, SEARCH_RETURN_BUDGET_BYTES - headerBytes - 1)
        const cutLine = truncateSafe(line, room) + marker
        bounded.push({ ...r, _preformatted: cutLine })
        runningBytes += Buffer.byteLength(cutLine, 'utf8') + 1
      }
      truncated = true
      omittedCount = capped.length - bounded.length
      break
    }
    bounded.push(r)
    runningBytes += lineBytes
  }

  if (truncated) {
    await emitEvent('memory.capped', {
      layer: 'search',
      team_name: teamName,
      omitted_count: omittedCount,
      kept_count: bounded.length,
      ranked_count: rankedCount,
      total_count: totalCount,
      budget_bytes: SEARCH_RETURN_BUDGET_BYTES,
    })
  }

  bounded._truncated = truncated
  bounded._omittedCount = omittedCount
  bounded._keptCount = bounded.length
  bounded._totalCount = totalCount
  bounded._rankedCount = rankedCount
  bounded._budgetBytes = SEARCH_RETURN_BUDGET_BYTES
  bounded._fallback = fallback
  return bounded
}

// Grapheme-safe truncation. Returns text trimmed so its UTF-8 byte length
// does not exceed maxBytes, cutting on grapheme cluster boundaries so we
// never split a multi-byte codepoint or a ZWJ sequence (emoji families etc.).
export function truncateSafe(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  if (maxBytes <= 0) return ''
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' })
  let acc = ''
  let accBytes = 0
  for (const { segment } of seg.segment(text)) {
    const segBytes = Buffer.byteLength(segment, 'utf8')
    if (accBytes + segBytes > maxBytes) break
    acc += segment
    accBytes += segBytes
  }
  return acc
}

export function formatSearchLine(r) {
  if (r._preformatted) return r._preformatted
  let src
  if (r._source === 'knowledge') src = '[KN]'
  else if (r._source === 'relvetia') src = '[REL]'
  else src = `[${r.kind}@${r.agent}]`
  const topic = r.topic ? ` ${r.topic}:` : ''
  return `${src}${topic} ${r.content}  (${r.timestamp})`
}

// ---------------------------------------------------------------------------
// relvetia-memory bridge — read-only grep wrapper over ~/.claude/memory/logs/
// ---------------------------------------------------------------------------

function defaultRelvetiaRoot() {
  return process.env.RELVETIA_MEMORY_ROOT
    || join(homedir(), '.claude', 'memory', 'logs')
}

const LOG_LINE_RE = /^-\s*\[(\d{2}:\d{2})\]\s*((?:\[[^\]]+\]\s*)*)(.+)$/

/**
 * Scan relvetia daily logs (YYYY/MM/YYYY-MM-DD.md) and return lines that
 * match the boolean query. Each hit becomes a record:
 *   { date, time, content, tags, file, timestamp, topic }
 * `timestamp` is ISO local for sortability. `tags` are extracted from the
 * `[tag1][tag2]` prefix convention. `content` is the post-tag text.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.root] — override base dir
 * @param {number} [opts.limit] — soft cap (default 200)
 */
export async function searchRelvetiaLogs(query, opts = {}) {
  const root = opts.root || defaultRelvetiaRoot()
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 200
  const match = makeMatcher(query)

  const files = await listLogFiles(root)
  const hits = []
  for (const file of files) {
    let raw
    try { raw = await readFile(file, 'utf-8') }
    catch (e) {
      if (!isEnoent(e)) console.error(`[memory] relvetia log read failed ${file}: ${errorMessage(e)}`)
      continue
    }
    const date = file.match(/(\d{4})[\/\\](\d{2})[\/\\](\d{4}-\d{2}-\d{2})\.md$/)?.[3] || ''
    const lines = raw.split('\n')
    for (const line of lines) {
      const m = LOG_LINE_RE.exec(line)
      if (!m) continue
      const [, time, tagPrefix, body] = m
      const tags = []
      const tagRe = /\[([^\]]+)\]/g
      let tm
      while ((tm = tagRe.exec(tagPrefix)) !== null) tags.push(tm[1])
      const content = body.trim()
      const topic = tags[0] || ''
      const rec = { date, time, content, tags, file, topic, timestamp: `${date}T${time}:00` }
      if (match(rec)) {
        hits.push(rec)
        if (hits.length >= limit) return hits
      }
    }
  }
  return hits
}

async function listLogFiles(root) {
  // root layout: <root>/YYYY/MM/YYYY-MM-DD.md
  const out = []
  let years
  try { years = await readdir(root) }
  catch (e) {
    if (isEnoent(e)) return []
    console.error(`[memory] relvetia root read failed ${root}: ${errorMessage(e)}`)
    return []
  }
  for (const y of years.sort()) {
    if (!/^\d{4}$/.test(y)) continue
    let months
    try { months = await readdir(join(root, y)) } catch { continue }
    for (const mo of months.sort()) {
      if (!/^\d{2}$/.test(mo)) continue
      let days
      try { days = await readdir(join(root, y, mo)) } catch { continue }
      for (const d of days.sort()) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(d)) out.push(join(root, y, mo, d))
      }
    }
  }
  return out
}

/**
 * Append a single relvetia-style log line to today's daily log.
 * Format: `- [HH:MM] [tag1][tag2] content` (JST minute precision).
 *
 * @param {string} content — the line body (post-tag)
 * @param {object} [opts]
 * @param {string[]} [opts.tags]
 * @param {string} [opts.root]
 * @param {Date} [opts.now] — for testing
 */
export async function appendRelvetiaLog(content, opts = {}) {
  const root = opts.root || defaultRelvetiaRoot()
  const now = opts.now || new Date()
  // JST = UTC+9. Use Intl-aware parts so DST/host TZ don't matter.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]))
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const time = `${parts.hour}:${parts.minute}`
  const file = join(root, parts.year, parts.month, `${date}.md`)
  const tagPart = Array.isArray(opts.tags) && opts.tags.length
    ? opts.tags.map(t => `[${t}]`).join('') + ' '
    : ''
  const line = `- [${time}] ${tagPart}${content}\n`
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, line)
  return { file, line: line.trimEnd() }
}

/**
 * Enumerate agents that have any notes recorded. Used by search when no
 * specific agent filter is provided.
 */
export async function listNoteAgents(teamName) {
  try {
    const dir = join(getTeamDir(teamName), 'notes')
    const files = await readdir(dir)
    return files
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''))
  } catch (e) {
    if (isEnoent(e)) return []
    console.error(`[memory] Failed to list note agents: ${errorMessage(e)}`)
    return []
  }
}
