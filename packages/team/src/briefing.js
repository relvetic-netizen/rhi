// Briefing — synthesizes a "welcome back" message for an agent resuming work
// in a new session. Pulls from Tier 2 (own notes) and Tier 3 (team
// knowledge) to reconstruct enough state that the agent can pick up
// effectively. NOT a full transcript — a high-signal handoff from past-self.
//
// Selection strategy (optimized for re-prime, not audit):
//   - open_question + next_step + assumption   → always include (state)
//   - decision + gotcha                        → always include (consistency)
//   - finding                                  → recent N, filtered by topic
//   - team knowledge                           → recent N relevant entries

import { readNotes, readKnowledge, truncateSafe } from './memory.js'
import { writeToMailbox } from './mailbox.js'
import { readTeam } from './team.js'
import { listTasks } from './tasks.js'
import { screenItems } from './screening/screening.js'
import {
  BRIEFING_THRESHOLD, BRIEFING_FINDING_MAX, BRIEFING_KNOWLEDGE_MAX,
  BRIEFING_RETURN_BUDGET_BYTES, RECENCY_HALF_LIFE_MS,
} from './screening/config.js'
import { emitEvent } from './tracing.js'

const FINDING_LOOKBACK_DAYS = 7
const FINDING_LIMIT = BRIEFING_FINDING_MAX
const KNOWLEDGE_LIMIT = BRIEFING_KNOWLEDGE_MAX

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return d.toISOString()
}

function formatNotes(notes, { showTaskId = true } = {}) {
  if (notes.length === 0) return '- (none)'
  return notes.map(n => {
    const topicTag = n.topic ? `[${n.topic}] ` : ''
    const taskTag = showTaskId && n.task_id ? ` (task #${n.task_id})` : ''
    return `- ${topicTag}${n.content}${taskTag}`
  }).join('\n')
}

function formatKnowledge(items) {
  if (items.length === 0) return '- (none)'
  return items.map(k => {
    const topicTag = k.topic ? `[${k.topic}] ` : ''
    const src = k.source_agent ? ` (via ${k.source_agent})` : ''
    return `- ${topicTag}${k.content}${src}`
  }).join('\n')
}

/**
 * Build a briefing for an agent. Returns structured text. Does not write
 * anywhere — `primeAgent` does the write.
 *
 * @param {object} opts
 * @param {string[]} [opts.topicsOfInterest]  — narrow finding/knowledge
 * @param {number}   [opts.findingDays]       — lookback window for findings
 */
export async function buildBriefing(teamName, agentName, opts = {}) {
  const team = await readTeam(teamName)
  const findingSince = isoDaysAgo(opts.findingDays ?? FINDING_LOOKBACK_DAYS)

  // Always-include: state + consistency notes (no date filter — they're rare)
  const essential = await readNotes(teamName, agentName, {
    kind: ['open_question', 'next_step', 'assumption'],
  })
  const consistency = await readNotes(teamName, agentName, {
    kind: ['decision', 'gotcha'],
  })

  // Recent findings. topicsOfInterest is a hard filter (substring match,
  // preserves the prior contract); screening then reorders the survivors
  // by relevance + recency. Without topics we keep the existing recent-N
  // behavior so empty briefings stay O(1) on the prime path.
  let findings
  let knowledge
  if (opts.topicsOfInterest && opts.topicsOfInterest.length > 0) {
    const needles = opts.topicsOfInterest.map(t => t.toLowerCase())
    const recentFindings = await readNotes(teamName, agentName, {
      kind: 'finding', since: findingSince,
    })
    const allKnowledge = await readKnowledge(teamName, {})
    const matchesAnyTopic = (rec) => {
      const hay = ((rec.topic || '') + ' ' + (rec.content || '')).toLowerCase()
      return needles.some(n => hay.includes(n))
    }
    const matchedFindings = recentFindings.filter(matchesAnyTopic)
    const matchedKnowledge = allKnowledge.filter(matchesAnyTopic)
    const topicQuery = opts.topicsOfInterest.join(' ').trim()
    findings = matchedFindings.length > 1 && topicQuery.length > 0
      ? screenItems(
          matchedFindings,
          f => ((f.topic || '') + ' ' + (f.content || '')),
          topicQuery,
          {
            threshold: BRIEFING_THRESHOLD,
            maxResults: FINDING_LIMIT,
            boostRecency: true,
            recencyHalfLifeMs: RECENCY_HALF_LIFE_MS,
          },
          f => Date.now() - new Date(f.timestamp || 0).getTime(),
        ).map(s => s.item)
      : matchedFindings.slice(0, FINDING_LIMIT)
    knowledge = matchedKnowledge.length > 1 && topicQuery.length > 0
      ? screenItems(
          matchedKnowledge,
          k => ((k.topic || '') + ' ' + (k.content || '')),
          topicQuery,
          {
            threshold: BRIEFING_THRESHOLD,
            maxResults: KNOWLEDGE_LIMIT,
            boostRecency: true,
            recencyHalfLifeMs: RECENCY_HALF_LIFE_MS,
          },
          k => Date.now() - new Date(k.timestamp || 0).getTime(),
        ).map(s => s.item)
      : matchedKnowledge.slice(0, KNOWLEDGE_LIMIT)
    if (
      recentFindings.length > matchedFindings.length ||
      allKnowledge.length > matchedKnowledge.length
    ) {
      await emitEvent('memory.capped', {
        layer: 'briefing',
        team_name: teamName,
        agent_name: agentName,
        findings_pool: recentFindings.length,
        findings_kept: findings.length,
        knowledge_pool: allKnowledge.length,
        knowledge_kept: knowledge.length,
      })
    }
  } else {
    findings = await readNotes(teamName, agentName, {
      kind: 'finding', since: findingSince, limit: FINDING_LIMIT,
    })
    knowledge = await readKnowledge(teamName, { limit: KNOWLEDGE_LIMIT })
  }

  // Open tasks assigned to this agent. listTasks is safe-by-default
  // (returns [] on ENOENT, getTask swallows per-file errors), so no catch.
  const allTasks = await listTasks(teamName)
  const myOpenTasks = allTasks.filter(
    t => t.owner === agentName && (t.status === 'pending' || t.status === 'in_progress')
  )

  const group = (arr, kind) => arr.filter(n => n.kind === kind)

  const sections = [
    `<briefing for="${agentName}" team="${team?.name || teamName}" generated_at="${new Date().toISOString()}">`,
    `You have resumed work. Before acting, read this briefing carefully — it's`,
    `what your past self left for you across previous sessions.`,
    ``,
    `## Open questions (need resolution)`,
    formatNotes(group(essential, 'open_question')),
    ``,
    `## Next steps (work queued for you)`,
    formatNotes(group(essential, 'next_step')),
    ``,
    `## Assumptions you're operating under (verify if stale)`,
    formatNotes(group(essential, 'assumption')),
    ``,
    `## Decisions to stay consistent with`,
    formatNotes(group(consistency, 'decision')),
    ``,
    `## Gotchas to avoid`,
    formatNotes(group(consistency, 'gotcha')),
    ``,
    `## Your open tasks`,
    myOpenTasks.length === 0
      ? '- (none)'
      : myOpenTasks.map(t => `- #${t.id} [${t.status}]: ${t.subject}`).join('\n'),
    ``,
    `## Recent findings (last ${opts.findingDays ?? FINDING_LOOKBACK_DAYS} days)`,
    formatNotes(findings),
    ``,
    `## Team-wide knowledge (curated)`,
    formatKnowledge(knowledge),
    ``,
    `When you finish meaningful work, record what matters for the next-you via`,
    `team_note (finding/decision/gotcha/assumption/open_question/next_step).`,
    `Promote team-wide truths via team_remember.`,
    `</briefing>`,
  ]

  return {
    text: sections.join('\n'),
    counts: {
      open_questions: group(essential, 'open_question').length,
      next_steps: group(essential, 'next_step').length,
      assumptions: group(essential, 'assumption').length,
      decisions: group(consistency, 'decision').length,
      gotchas: group(consistency, 'gotcha').length,
      findings: findings.length,
      knowledge: knowledge.length,
      open_tasks: myOpenTasks.length,
    },
  }
}

/**
 * Apply the briefing byte budget. Returns the (possibly-truncated) text plus
 * structured metadata. Truncation is grapheme-safe and appends a NOTICE so the
 * agent knows coverage is incomplete. Plan v3.1 hard-cap.
 *
 * @param {string} text
 * @param {number} [budget] — default BRIEFING_RETURN_BUDGET_BYTES
 * @returns {{ text: string, truncated: boolean, omitted_bytes: number, total_bytes: number, budget_bytes: number }}
 */
export function applyBriefingBudget(text, budget = BRIEFING_RETURN_BUDGET_BYTES) {
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= budget) {
    return { text, truncated: false, omitted_bytes: 0, total_bytes: totalBytes, budget_bytes: budget }
  }
  const marker = `\n\n[NOTICE: briefing truncated to fit ${Math.round(budget / 1024)}KB byte budget; ${totalBytes - budget} bytes dropped. Narrow topics_of_interest or finding_days for full coverage.]`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const room = Math.max(0, budget - markerBytes)
  const head = truncateSafe(text, room)
  const cappedText = head + marker
  return {
    text: cappedText,
    truncated: true,
    omitted_bytes: totalBytes - Buffer.byteLength(head, 'utf8'),
    total_bytes: totalBytes,
    budget_bytes: budget,
  }
}

/**
 * Build the briefing and deliver it to the agent's inbox as a "welcome back"
 * message. The agent reads it via team_read_inbox on startup.
 *
 * Marked with from='past-self' and skips guardrails/turns so it always lands.
 * The delivered text is byte-capped (BRIEFING_RETURN_BUDGET_BYTES) so a
 * pathological briefing cannot exhaust the inbox / context window.
 */
export async function primeAgent(teamName, agentName, opts = {}) {
  const briefing = await buildBriefing(teamName, agentName, opts)
  const capped = applyBriefingBudget(briefing.text)
  if (capped.truncated) {
    await emitEvent('memory.capped', {
      layer: 'briefing',
      team_name: teamName,
      agent_name: agentName,
      omitted_bytes: capped.omitted_bytes,
      total_bytes: capped.total_bytes,
      budget_bytes: capped.budget_bytes,
    })
  }
  await writeToMailbox(teamName, agentName, {
    from: 'past-self',
    text: capped.text,
    summary: 'briefing: resume from prior session',
  }, { skipGuardrails: true, skipTurns: true, skipApproval: true })
  return { ...briefing, budget: capped }
}
