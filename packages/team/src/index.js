#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { z } from 'zod'

import { createTeam, readTeam, deleteTeam, listTeams, updateMemberStatus, cloneMember } from './team.js'
import { writeToMailbox, readUnreadMessages, markMessagesAsRead, broadcastMessage } from './mailbox.js'
import { createTask, updateTask, listTasks, deleteTask, completeTask } from './tasks.js'
import { errorMessage } from './errors.js'
import { withSpan, emitEvent } from './tracing.js'
import { fireHook } from './hooks.js'
import { renderForAgent } from './prompt-template.js'
import { performHandoff } from './handoffs.js'
import { getItems, popItem, clearSession, countItems } from './sessions.js'
import { setTurnLimit, resetTurns, getTurnCounts } from './turns.js'
import { listApprovalsWithLazySweep, getApproval, decide, pruneApprovals, expirePendingApprovals } from './approvals.js'
import { sendRequest, sendRequestAsync, sendReply } from './requests.js'
import { shouldDenyHitl } from './admission.js'
import { evaluateTask, runEvaluatedTask, runConsensusTask } from './evaluator.js'
import { invoke, crossReply } from './cross-team.js'
import {
  writeNote, readNotes, promoteToKnowledge, readKnowledge,
  searchMemory, listNoteAgents, NOTE_KINDS, appendRelvetiaLog,
  formatSearchLine,
} from './memory.js'
import { buildBriefing, primeAgent, applyBriefingBudget } from './briefing.js'
import { memorySearchToolHandler } from './memory-search-mcp.js'
import { privateMemorySearchToolHandler } from './private-memory-search-mcp.js'
import {
  memoryRememberToolHandler,
  memoryLogRecentToolHandler,
  memoryStatusToolHandler,
  daemonStatusToolHandler,
} from './relvetia-memory-tools.js'
import {
  distillMarkFiredToolHandler,
  distillStatusToolHandler,
  walkerStatusToolHandler,
  scheduledTaskListToolHandler,
  scheduledTaskCreateToolHandler,
  scheduledTaskCancelToolHandler,
} from './relvetia-admin-tools.js'
import { initChannels, addChannelWatch, listChannelWatches, parseAgentAliases } from './channels.js'
import { recoverPendingOnRestart as recoverGraphPendingOnRestart } from './graph-store.js'
import { SEARCH_RETURN_BUDGET_BYTES } from './screening/config.js'

const server = new McpServer(
  { name: 'relvetia-team', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'Inbox events arrive as <channel source="relvetia-team" team="<team>" agent="<you>" from="<sender>" [request_id="<id>"] [in_reply_to="<id>"] [summary="<one-line>"] [kind="<kind>"] [timestamp="<iso>"] [instance_id="<uuid>"]>body</channel>.',
      'The agent attribute is the recipient (you). The from attribute is the sender.',
      'To reply: call team_send_message with team_name=<team>, to=<from>, from=<agent>, message=<your reply>. team_send_message has no in_reply_to argument; for async correlation, embed the request_id from the inbound tag in the reply text or summary so the original sender can match it.',
      'Channel events are real-time pushes for new inbox entries. SessionStart digest still surfaces unread entries at cold start; channel does not mark read=true, so the same entry may also appear in a SessionStart digest later — dedupe visually by request_id or content.',
    ].join(' '),
  },
)

// Recursive zod schema mirroring the JSON Schema subset understood by
// src/schema-validator.js. `looseObject` preserves unknown keywords (e.g.
// `description`, `pattern`) so callers can include them without rejection —
// the validator simply ignores any keyword it does not implement.
const jsonSchemaSubset = z.lazy(() => z.looseObject({
  type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']).optional(),
  required: z.array(z.string()).optional(),
  properties: z.record(z.string(), jsonSchemaSubset).optional(),
  items: jsonSchemaSubset.optional(),
  enum: z.array(z.unknown()).optional(),
}))

// ============================================================
// safeTool wrapper — catches all errors and returns structured
// error responses instead of crashing the MCP server.
// ============================================================

function safeTool(server, name, description, schema, handler, options = {}) {
  // Optional pre-handler strict-mode pass (Codex P1 #1, saga 8 Phase 2-revB).
  // The MCP SDK wraps the raw `schema` shape with `z.object(...)` internally
  // (non-strict — unknown keys are silently stripped). When `options.strict`
  // is true we run an additional `z.strictObject(...)` parse pass BEFORE
  // delegating to the user handler, so unknown keys are rejected at the
  // safeTool boundary instead of being silently dropped. Opt-in so the 38
  // pre-existing team_* tools (which never declared strict behavior) keep
  // their established lenient surface; the saga 7 memory_search + saga 8
  // memory_remember / memory_log_recent / memory_status / daemon_status
  // opt in explicitly via `{ strict: true }`.
  const strictParser = options.strict ? z.strictObject(schema) : null

  server.tool(name, description, schema, async (args) => {
    const spanAttrs = {
      tool: name,
      // traceTeam:false routes the span to the global trace path. Used by tools
      // that delete the team dir (team_delete) — otherwise the trace processor's
      // ensureDir recreates the directory with a fresh traces.jsonl after rm.
      team_name: options.traceTeam === false ? null : args?.team_name,
      arg_keys: Object.keys(args || {}),
    }
    return await withSpan(`tool.${name}`, spanAttrs, async () => {
      const start = Date.now()
      await fireHook('before_tool', { tool: name, args })
      try {
        // Strict pre-handler pass: throws on unknown keys; caught below
        // and returned as the standard isError envelope.
        if (strictParser) strictParser.parse(args)
        const result = await handler(args)
        await fireHook('after_tool', {
          tool: name, args, result, error: null, duration_ms: Date.now() - start,
        })
        return result
      } catch (e) {
        const msg = errorMessage(e)
        console.error(`[relvetia-team] Tool ${name} failed: ${msg}`)
        await fireHook('after_tool', {
          tool: name, args, result: null, error: msg, duration_ms: Date.now() - start,
        })
        return {
          content: [{ type: 'text', text: `Error in ${name}: ${msg}` }],
          isError: true,
        }
      }
    })
  })
}

// ============================================================
// Context-budget helpers (PR-1)
// ============================================================
// Caps the byte size of team_get_session / team_read_inbox responses so a
// single call cannot blow out the caller's context window. Handler-layer
// only — disk, mailbox state, and the mark-read path are untouched.
// Set RELVETIA_CAP_DISABLE=1 to bypass (dev-only, for before/after harness).
//
// Design rationale + DON'T list: docs/context-latency-p1-plan-2026-05-15.md

export const SESSION_RETURN_BUDGET_BYTES = 24_000
export const INBOX_PER_ITEM_BUDGET_BYTES = 8_000

const _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function truncateSafe(text, maxBytes, marker = '…[truncated]') {
  if (typeof text !== 'string' || text.length === 0) return text ?? ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= maxBytes) return ''
  const targetBytes = maxBytes - markerBytes
  let acc = 0
  let cut = 0
  let lastNewlineCut = -1
  for (const { segment, index } of _segmenter.segment(text)) {
    const bytes = Buffer.byteLength(segment, 'utf8')
    if (acc + bytes > targetBytes) break
    acc += bytes
    cut = index + segment.length
    if (segment === '\n' && acc >= targetBytes * 0.9) lastNewlineCut = cut
  }
  return text.slice(0, lastNewlineCut > -1 ? lastNewlineCut : cut) + marker
}

function _formatSessionItem(m) {
  const readTag = m.read ? '' : ' UNREAD'
  const colorTag = m.color ? ` [${m.color}]` : ''
  const summaryTag = m.summary ? ` (${m.summary})` : ''
  return `<session_item from="${m.from}"${colorTag}${summaryTag} time="${m.timestamp}"${readTag}>\n${m.text}\n</session_item>`
}

function _formatInboxMessage(m) {
  const colorTag = m.color ? ` [${m.color}]` : ''
  const summaryTag = m.summary ? ` (${m.summary})` : ''
  return `<teammate_message from="${m.from}"${colorTag}${summaryTag} time="${m.timestamp}">\n${m.text}\n</teammate_message>`
}

function _capDisabled(opts) {
  if (opts && typeof opts.capDisabled === 'boolean') return opts.capDisabled
  return process.env.RELVETIA_CAP_DISABLE === '1'
}

export function capSessionItems(items, opts = {}) {
  const budget = opts.budgetBytes ?? SESSION_RETURN_BUDGET_BYTES
  const formattedAll = items.map(_formatSessionItem)
  const beforeBytes = Buffer.byteLength(formattedAll.join('\n\n'), 'utf8')

  // Build final text including prefix/notice overhead so the returned text
  // itself fits in budget (PR-28 review fix: previous impl only capped body,
  // letting prefix/notice push the final payload over budget by 2-22 bytes).
  // `truncated=true` emits the [NOTICE:...] header for both item-drop and
  // single-item-text-truncate paths; the caller never needs to add a prefix.
  const _build = (kept, formatted, truncated) => {
    const joined = formatted.join('\n\n')
    if (!truncated) {
      return `${items.length} item(s):\n\n${joined}`
    }
    const bodyBytes = Buffer.byteLength(joined, 'utf8')
    const notice = `[NOTICE: showing ${kept.length} of ${items.length} items (${bodyBytes} bytes / budget ${budget}). Use team_get_session(limit=N) for explicit limit, or query inbox files directly for full text.]`
    return notice + '\n' + joined
  }

  if (_capDisabled(opts)) {
    const text = _build(items.slice(), formattedAll.slice(), false)
    return {
      text,
      beforeBytes,
      afterBytes: Buffer.byteLength(text, 'utf8'),
      truncated: false,
      omittedCount: 0,
      keptCount: items.length,
    }
  }

  let kept = items.slice()
  let formatted = formattedAll.slice()
  let omittedCount = 0
  let truncated = false

  while (kept.length > 1 && Buffer.byteLength(_build(kept, formatted, truncated || kept.length < items.length), 'utf8') > budget) {
    kept.shift()
    formatted.shift()
    omittedCount += 1
    truncated = true
  }

  if (kept.length === 1 && Buffer.byteLength(_build(kept, formatted, truncated), 'utf8') > budget) {
    const orig = kept[0]
    const stubKept = [{ ...orig, text: '' }]
    const stubFormatted = [_formatSessionItem(stubKept[0])]
    const stubFinalBytes = Buffer.byteLength(_build(stubKept, stubFormatted, true), 'utf8')
    const textBudget = Math.max(0, budget - stubFinalBytes)
    const truncatedText = truncateSafe(orig.text, textBudget)
    kept = [{ ...orig, text: truncatedText }]
    formatted = [_formatSessionItem(kept[0])]
    truncated = true
  }

  const finalText = _build(kept, formatted, truncated)
  return {
    text: finalText,
    beforeBytes,
    afterBytes: Buffer.byteLength(finalText, 'utf8'),
    truncated,
    omittedCount,
    keptCount: kept.length,
  }
}

export function capInboxMessages(messages, opts = {}) {
  const budget = opts.perItemBudgetBytes ?? INBOX_PER_ITEM_BUDGET_BYTES
  const beforeJoined = messages.map(_formatInboxMessage).join('\n\n')
  const beforeBytes = Buffer.byteLength(beforeJoined, 'utf8')

  if (_capDisabled(opts)) {
    return {
      text: beforeJoined,
      beforeBytes,
      afterBytes: beforeBytes,
      truncated: false,
      truncatedCount: 0,
    }
  }

  let truncatedCount = 0
  const formatted = messages.map(m => {
    const origText = m.text ?? ''
    if (Buffer.byteLength(origText, 'utf8') <= budget) {
      return _formatInboxMessage(m)
    }
    truncatedCount += 1
    return _formatInboxMessage({ ...m, text: truncateSafe(origText, budget) })
  })
  const joined = formatted.join('\n\n')
  if (truncatedCount === 0) {
    return {
      text: joined,
      beforeBytes,
      afterBytes: Buffer.byteLength(joined, 'utf8'),
      truncated: false,
      truncatedCount: 0,
    }
  }

  const notice = `[NOTICE: ${truncatedCount} of ${messages.length} message bodies truncated to fit ${budget}B/item. Original disk content unchanged.]`
  const withNotice = notice + '\n' + joined
  return {
    text: withNotice,
    beforeBytes,
    afterBytes: Buffer.byteLength(withNotice, 'utf8'),
    truncated: true,
    truncatedCount,
  }
}

// ============================================================
// Team Management Tools
// ============================================================

safeTool(server,
  'team_create',
  'Create a new agent team with named members. Each member gets a mailbox and shared task list.',
  {
    team_name: z.string().describe('Unique team name (alphanumeric, dashes, underscores)'),
    description: z.string().optional().describe('Team purpose description'),
    members: z.array(z.object({
      name: z.string().describe('Agent name (e.g., "researcher", "implementer")'),
      role: z.string().optional().describe('Role description'),
      prompt: z.string().optional().describe('Initial instruction for this agent'),
      model: z.string().optional().describe('Model override (e.g., "sonnet", "opus")'),
    })).describe('List of team members to create (excluding team-lead which is automatic)'),
  },
  async ({ team_name, description, members }) => {
    const existing = await readTeam(team_name)
    if (existing) {
      return { content: [{ type: 'text', text: `Team "${team_name}" already exists. Use team_delete first or choose a different name.` }] }
    }

    const team = await createTeam(team_name, members, description)
    const memberList = team.members.map(m => `  - ${m.name} (${m.role}) [${m.color}]`).join('\n')

    return {
      content: [{
        type: 'text',
        text: `Team "${team_name}" created successfully.\n\nMembers:\n${memberList}\n\nNext step: Send initial instructions via team_send_message to each member.\n\nShared task list: ~/.claude/tasks/${team_name}/\nMailboxes: ~/.claude/teams/${team_name}/inboxes/`,
      }],
    }
  }
)

safeTool(server,
  'team_status',
  'Get the current status of a team: members, their activity, and unread message counts.',
  {
    team_name: z.string().describe('Team name to check'),
  },
  async ({ team_name }) => {
    const team = await readTeam(team_name)
    if (!team) {
      return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    }

    const tasks = await listTasks(team_name)
    const pending = tasks.filter(t => t.status === 'pending').length
    const inProgress = tasks.filter(t => t.status === 'in_progress').length
    const completed = tasks.filter(t => t.status === 'completed').length

    const memberLines = []
    for (const m of team.members) {
      let unreadCount = 0
      try {
        const unread = await readUnreadMessages(team_name, m.name)
        unreadCount = unread.length
      } catch (e) {
        console.error(`[team_status] Failed to read inbox for ${m.name}: ${errorMessage(e)}`)
      }
      const status = m.isActive ? 'ACTIVE' : 'idle'
      memberLines.push(`  ${m.color ? `[${m.color}]` : ''} ${m.name} (${m.role}) - ${status} - ${unreadCount} unread`)
    }

    return {
      content: [{
        type: 'text',
        text: `Team: ${team.name}\nDescription: ${team.description || '(none)'}\nCreated: ${new Date(team.createdAt).toISOString()}\n\nMembers:\n${memberLines.join('\n')}\n\nTasks: ${pending} pending, ${inProgress} in progress, ${completed} completed (${tasks.length} total)`,
      }],
    }
  }
)

safeTool(server,
  'team_delete',
  'Delete a team and all associated data (mailboxes, tasks, tmux sessions).',
  {
    team_name: z.string().describe('Team name to delete'),
  },
  async ({ team_name }) => {
    const team = await readTeam(team_name)
    if (!team) {
      return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    }

    await deleteTeam(team_name)
    return { content: [{ type: 'text', text: `Team "${team_name}" deleted. Tmux sessions killed, all data removed.` }] }
  },
  { traceTeam: false }
)

safeTool(server,
  'team_list',
  'List all existing teams.',
  {},
  async () => {
    const teams = await listTeams()
    if (teams.length === 0) {
      return { content: [{ type: 'text', text: 'No teams found.' }] }
    }

    const lines = teams.map(t => {
      const memberCount = t.members.length
      const active = t.members.filter(m => m.isActive).length
      return `  - ${t.name}: ${memberCount} members (${active} active) - ${t.description || '(no description)'}`
    })

    return { content: [{ type: 'text', text: `Teams:\n${lines.join('\n')}` }] }
  }
)

// ============================================================
// Mailbox Tools
// ============================================================

safeTool(server,
  'team_send_message',
  'Send a message to a teammate\'s inbox. Use "*" as recipient to broadcast to all members. requires_approval=true enqueues the message for team-lead approval instead of delivering.',
  {
    team_name: z.string().describe('Team name'),
    to: z.string().describe('Recipient agent name, or "*" for broadcast'),
    message: z.string().describe('Message content'),
    summary: z.string().optional().describe('5-10 word summary shown as preview'),
    from: z.string().default('team-lead').describe('Sender name (defaults to team-lead)'),
    requires_approval: z.boolean().default(false).describe('If true, enqueue for HITL approval instead of delivering'),
    orchestrator_session_id: z.string().optional().describe('Orchestrator session id; persisted on the inbox message so the inbox-watcher inject-relay can reach the originating orchestrator session.'),
  },
  async ({ team_name, to, message, summary, from, requires_approval, orchestrator_session_id }) => {
    const team = await readTeam(team_name)
    if (!team) {
      return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    }

    // M7 admission gate (Sprint 3b): an autonomous worker MUST NOT block
    // waiting on a human reviewer. shouldDenyHitl returns a structured
    // autonomous fallback when (requires_approval && known taskId &&
    // autonomous marker), otherwise null (HITL allow path = backward compat).
    const denied = shouldDenyHitl({
      requiresApproval: requires_approval,
      originalRequest: { team_name, to, message, summary, from },
    })
    if (denied) {
      return {
        content: [{ type: 'text', text: `[HITL_ADMISSION_DENIED] autonomous_path taskId=${denied.taskId} source=${denied.source} fallback=${denied.fallback}` }],
        isError: true,
      }
    }

    const sender = team.members.find(m => m.name === from)

    if (to === '*') {
      const { delivered, pending, failed } = await broadcastMessage(team_name, from, message, summary, team.members, {
        orchestrator_session_id,
        requires_approval,
      })
      let text = `Broadcast sent to ${delivered.length} members: ${delivered.join(', ')}`
      if (pending.length > 0) {
        text += `\nPending approval for ${pending.length} members: ${pending.map(p => `${p.to}=${p.approval_id}`).join(', ')}`
      }
      if (failed.length > 0) {
        text += `\nFailed to deliver to: ${failed.join(', ')}`
      }
      return { content: [{ type: 'text', text }] }
    }

    const recipient = team.members.find(m => m.name === to)
    if (!recipient) {
      const names = team.members.map(m => m.name).join(', ')
      return { content: [{ type: 'text', text: `Member "${to}" not found. Available: ${names}` }] }
    }

    const result = await writeToMailbox(team_name, to, {
      from,
      text: message,
      summary,
      color: sender?.color,
      requires_approval,
      ...(orchestrator_session_id ? { orchestrator_session_id } : {}),
    })

    if (result.pending_approval_id) {
      return { content: [{ type: 'text', text: `Message enqueued for approval: ${result.pending_approval_id}` }] }
    }
    if (result.blocked) {
      return { content: [{ type: 'text', text: `Message blocked: ${result.reason}` }], isError: true }
    }
    return { content: [{ type: 'text', text: `Message sent to ${to}'s inbox.` }] }
  }
)

// Shape the per-message payload that rides on structuredContent.messages so
// that callers whose harness elides content[] still see the full body. Caller
// can refuse the payload by setting RELVETIA_INBOX_EMBED=off if a future
// elision rule starts treating the embedded text as a leak vector — the
// content[] text remains the canonical payload.
function _toInboxStructuredMessage(m) {
  return {
    from: m.from,
    text: m.text,
    summary: m.summary ?? null,
    timestamp: m.timestamp,
    color: m.color ?? null,
    request_id: m.request_id ?? null,
  }
}

function _embedInboxMessages() {
  return process.env.RELVETIA_INBOX_EMBED !== 'off'
}

safeTool(server,
  'team_read_inbox',
  'Read unread messages from your inbox. Marks them as read after retrieval. Each message body is capped to ~8KB in content[]; the same per-message data also rides on structuredContent.messages so callers whose harness elides content[] still see the body (set RELVETIA_INBOX_EMBED=off to opt out). Oversized bodies are truncated in the response (disk content unchanged) with a leading [NOTICE:...] line + structuredContent.truncated.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Your agent name (whose inbox to read)'),
    peek: z.boolean().default(false).describe('If true, do not mark as read'),
  },
  async ({ team_name, agent_name, peek }) => {
    const unread = await readUnreadMessages(team_name, agent_name)
    const embedMessages = _embedInboxMessages()

    if (unread.length === 0) {
      return {
        content: [{ type: 'text', text: 'No unread messages.' }],
        structuredContent: {
          truncated: false,
          omitted_count: 0,
          ...(embedMessages ? { messages: [] } : {}),
        },
      }
    }

    if (!peek) {
      await markMessagesAsRead(team_name, agent_name)
    }

    const cap = capInboxMessages(unread)
    if (cap.truncated) {
      await emitEvent('memory.capped', {
        layer: 'inbox',
        team_name,
        agent_name,
        items_truncated: cap.truncatedCount,
      })
      // Only embed the messages that survived the byte cap (i.e. were
      // actually formatted into cap.text). Truncated tail messages are
      // omitted from `messages` too, mirroring the content[] payload so
      // the embedded array never exceeds the byte budget the cap enforces.
      const survived = unread.slice(0, unread.length - cap.truncatedCount)
      return {
        content: [{ type: 'text', text: cap.text }],
        structuredContent: {
          truncated: true,
          omitted_count: cap.truncatedCount,
          total: unread.length,
          ...(embedMessages ? { messages: survived.map(_toInboxStructuredMessage) } : {}),
        },
      }
    }

    return {
      content: [{ type: 'text', text: `${unread.length} unread message(s):\n\n${cap.text}` }],
      structuredContent: {
        truncated: false,
        omitted_count: 0,
        total: unread.length,
        ...(embedMessages ? { messages: unread.map(_toInboxStructuredMessage) } : {}),
      },
    }
  }
)

safeTool(server,
  'team_member_active',
  'Update a team member\'s active status.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent name'),
    is_active: z.boolean().describe('Whether the agent is active'),
  },
  async ({ team_name, agent_name, is_active }) => {
    await updateMemberStatus(team_name, agent_name, is_active)
    return { content: [{ type: 'text', text: `${agent_name} marked as ${is_active ? 'active' : 'idle'}.` }] }
  }
)

safeTool(server,
  'team_add_watch',
  'Register an additional channels-mode watcher so this session receives proactive notify on a secondary (team, agent) inbox. Use after team_clone_member when a Discord-launched session (primary env binding = discord-claude/claude-N) needs cross-team push notifications on a virtual identity (e.g. relvetia/orchestrator-X). Idempotent — re-adding the same binding returns {deduped:true} and reuses the existing watcher.',
  {
    team_name: z.string().describe('Team that owns the inbox to watch'),
    agent_name: z.string().describe('Agent (mailbox owner) within that team'),
  },
  async ({ team_name, agent_name }) => {
    const handle = await addChannelWatch(server.server, { team: team_name, agent: agent_name })
    const watches = listChannelWatches()
    const status = handle.deduped ? 'already watching' : 'watch added'
    return {
      content: [{
        type: 'text',
        text: `${status}: ${team_name}/${agent_name}\nactive watches (${watches.length}): ${watches.map(w => `${w.team}/${w.agent}`).join(', ')}`,
      }],
      structuredContent: {
        team: team_name,
        agent: agent_name,
        deduped: handle.deduped,
        watches,
      },
    }
  }
)

// ============================================================
// Shared Task Tools
// ============================================================

safeTool(server,
  'team_create_task',
  'Create a new task in the team\'s shared task list.',
  {
    team_name: z.string().describe('Team name'),
    subject: z.string().describe('Task title'),
    description: z.string().optional().describe('Detailed task description'),
    owner: z.string().optional().describe('Agent name who owns this task'),
    blocked_by: z.array(z.string()).optional().describe('Task IDs that must complete before this one'),
    result_schema: jsonSchemaSubset.optional().describe('JSON Schema describing the expected structured result on completion (supports type/required/properties/items/enum)'),
  },
  async ({ team_name, subject, description, owner, blocked_by, result_schema }) => {
    const task = await createTask(team_name, {
      subject,
      description,
      owner,
      blockedBy: blocked_by || [],
      resultSchema: result_schema || null,
    })

    return {
      content: [{
        type: 'text',
        text: `Task #${task.id} created: "${subject}"${owner ? ` (assigned to ${owner})` : ''}${blocked_by?.length ? ` [blocked by: ${blocked_by.join(', ')}]` : ''}${result_schema ? ' [schema required]' : ''}`,
      }],
    }
  }
)

safeTool(server,
  'team_complete_task',
  'Mark a task completed with an optional structured result. Enforces resultSchema validation and blockedBy dependencies.',
  {
    team_name: z.string().describe('Team name'),
    task_id: z.string().describe('Task ID to complete'),
    result: z.unknown().optional().describe('Structured result payload; validated against the task\'s result_schema if set'),
    force: z.boolean().default(false).describe('Bypass blockedBy dependency check'),
  },
  async ({ team_name, task_id, result, force }) => {
    const outcome = await completeTask(team_name, task_id, result, { force })
    if (!outcome.ok) {
      return {
        content: [{ type: 'text', text: `Cannot complete #${task_id}: ${outcome.errors.join('; ')}` }],
        isError: true,
      }
    }
    await fireHook('on_task_update', {
      team: team_name, task_id, updates: { status: 'completed', result }, task: outcome.task,
    })

    // Prompt the agent to record memory for the future self,
    // returned inline in the tool response so the LLM naturally reads it.
    const owner = outcome.task.owner
    const reminder = owner
      ? `\n\n[memory reminder] Before moving on, record anything your next-session-self will need: ` +
        `call team_note(agent_name="${owner}", task_id="${task_id}", kind=..., content=...) ` +
        `for each finding/decision/gotcha/assumption worth preserving. ` +
        `If a fact is canonical and team-wide, also call team_remember.`
      : ''
    return { content: [{ type: 'text', text: `Task #${task_id} completed.${reminder}` }] }
  }
)

safeTool(server,
  'team_update_task',
  'Update a task\'s status, owner, or description.',
  {
    team_name: z.string().describe('Team name'),
    task_id: z.string().describe('Task ID to update'),
    status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('New status'),
    owner: z.string().optional().describe('New owner'),
    description: z.string().optional().describe('Updated description'),
  },
  async ({ team_name, task_id, status, owner, description }) => {
    const updates = {}
    if (status) updates.status = status
    if (owner !== undefined) updates.owner = owner
    if (description !== undefined) updates.description = description

    const updated = await updateTask(team_name, task_id, updates)
    if (!updated) {
      return { content: [{ type: 'text', text: `Task #${task_id} not found.` }] }
    }

    await fireHook('on_task_update', {
      team: team_name, task_id, updates, task: updated,
    })

    return {
      content: [{
        type: 'text',
        text: `Task #${task_id} updated: ${updated.subject} [${updated.status}]${updated.owner ? ` -> ${updated.owner}` : ''}`,
      }],
    }
  }
)

safeTool(server,
  'team_list_tasks',
  'List all tasks in the team\'s shared task list. Optionally filter by status or owner.',
  {
    team_name: z.string().describe('Team name'),
    status: z.enum(['pending', 'in_progress', 'completed', 'all']).default('all').describe('Filter by status'),
    owner: z.string().optional().describe('Filter by owner agent name'),
  },
  async ({ team_name, status, owner }) => {
    let tasks = await listTasks(team_name)

    if (status !== 'all') {
      tasks = tasks.filter(t => t.status === status)
    }
    if (owner) {
      tasks = tasks.filter(t => t.owner === owner)
    }

    if (tasks.length === 0) {
      return { content: [{ type: 'text', text: 'No tasks found matching criteria.' }] }
    }

    const STATUS_ICON = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }
    const lines = tasks.map(t => {
      const icon = STATUS_ICON[t.status] || '[ ]'
      const ownerTag = t.owner ? ` @${t.owner}` : ''
      const blockers = t.blockedBy?.length ? ` (blocked by: #${t.blockedBy.join(', #')})` : ''
      const schemaTag = t.resultSchema ? ' [schema]' : ''
      const resultTag = t.result != null ? ' [has-result]' : ''
      return `  ${icon} #${t.id}: ${t.subject}${ownerTag}${blockers}${schemaTag}${resultTag}`
    })

    return { content: [{ type: 'text', text: `Tasks (${tasks.length}):\n${lines.join('\n')}` }] }
  }
)

// ============================================================
// Handoff & Session Tools
// ============================================================

safeTool(server,
  'team_handoff',
  'Transfer responsibility to another teammate with an explicit <handoff> envelope. Optionally transfers ownership of a task, applies an input_filter, flips activity flags, and emits a trace event.',
  {
    team_name: z.string().describe('Team name'),
    to: z.string().describe('Recipient agent name'),
    reason: z.string().describe('Why the handoff is happening'),
    payload: z.string().optional().describe('Context payload the recipient needs'),
    input_filter: z.object({
      name: z.enum(['none', 'truncate', 'last_n_lines', 'remove_code_blocks']),
      max_length: z.number().optional(),
      n: z.number().optional(),
    }).optional().describe('Transform applied to payload before delivery'),
    task_id: z.string().optional().describe('Transfer ownership of this task to the recipient'),
    from: z.string().default('team-lead').describe('Sender name'),
    requires_approval: z.boolean().default(false).describe('If true, enqueue handoff for HITL approval instead of delivering'),
  },
  async ({ team_name, to, reason, payload, input_filter, task_id, from, requires_approval }) => {
    const team = await readTeam(team_name)
    if (!team) {
      return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    }
    const recipient = team.members.find(m => m.name === to)
    if (!recipient) {
      const names = team.members.map(m => m.name).join(', ')
      return { content: [{ type: 'text', text: `Recipient "${to}" not found. Available: ${names}` }] }
    }
    const sender = team.members.find(m => m.name === from)

    const result = await performHandoff({
      teamName: team_name,
      from, to, reason,
      payload: payload || '',
      inputFilter: input_filter || null,
      taskId: task_id || null,
      senderColor: sender?.color,
      requiresApproval: requires_approval,
    })

    if (result.pending_approval_id) {
      return { content: [{ type: 'text', text: `Handoff enqueued for approval: ${result.pending_approval_id}` }] }
    }
    if (!result.delivered) {
      return { content: [{ type: 'text', text: `Handoff failed: ${result.reason}` }], isError: true }
    }

    const taskInfo = result.task ? ` (task #${result.task.id} reassigned to ${to})` : ''
    return { content: [{ type: 'text', text: `Handoff ${from} → ${to}: ${reason}${taskInfo}` }] }
  }
)

safeTool(server,
  'team_get_session',
  'Read the full session history for an agent (read + unread). Supports limit/since/unread_only filters. Output is capped to ~24KB; older items are dropped (or the single returned item is truncated) when the budget is exceeded — a leading [NOTICE:...] line + structuredContent.truncated signal the cap.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent whose session to read'),
    limit: z.number().int().min(0).max(1000).optional().describe('Return only the most recent N items (omit for default; 0 also means "no count limit" but the byte cap still applies)'),
    since: z.string().optional().describe('ISO timestamp; include items with timestamp >= since'),
    unread_only: z.boolean().default(false).describe('Return only unread items'),
  },
  async ({ team_name, agent_name, limit, since, unread_only }) => {
    const items = await getItems(team_name, agent_name, {
      limit, since, unreadOnly: unread_only,
    })
    if (items.length === 0) {
      return {
        content: [{ type: 'text', text: 'No session items.' }],
        structuredContent: { truncated: false, omitted_count: 0, total: 0 },
      }
    }
    const cap = capSessionItems(items)
    if (cap.truncated) {
      await emitEvent('memory.capped', {
        layer: 'session',
        team_name,
        agent_name,
        before_bytes: cap.beforeBytes,
        after_bytes: cap.afterBytes,
        omitted_count: cap.omittedCount,
      })
    }
    return {
      content: [{ type: 'text', text: cap.text }],
      structuredContent: {
        truncated: cap.truncated,
        omitted_count: cap.omittedCount,
        total: items.length,
      },
    }
  }
)

safeTool(server,
  'team_session_pop',
  'Remove and return the most recent session item for an agent. Useful for undo/retry.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent whose session to pop from'),
  },
  async ({ team_name, agent_name }) => {
    const popped = await popItem(team_name, agent_name)
    if (!popped) return { content: [{ type: 'text', text: 'Session is empty.' }] }
    return { content: [{ type: 'text', text: `Popped item from ${popped.from} (${popped.timestamp}): ${popped.text.slice(0, 200)}` }] }
  }
)

safeTool(server,
  'team_session_clear',
  'Clear all session items for an agent.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent whose session to clear'),
  },
  async ({ team_name, agent_name }) => {
    const before = await countItems(team_name, agent_name)
    await clearSession(team_name, agent_name)
    return { content: [{ type: 'text', text: `Cleared ${before} item(s) from ${agent_name}'s session.` }] }
  }
)

// ============================================================
// max_turns, HITL approval, agents-as-tools
// ============================================================

safeTool(server,
  'team_set_turn_limit',
  'Set a per-agent or team-wide max_turns limit. When a sender exceeds its limit, further messages are blocked and a notice is delivered to team-lead.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().nullable().optional().describe('Agent name; null or omit to set team default'),
    limit: z.number().nullable().describe('Turn limit, or null to remove the limit'),
  },
  async ({ team_name, agent_name, limit }) => {
    await setTurnLimit(team_name, agent_name || null, limit)
    const scope = agent_name ? `agent ${agent_name}` : 'team default'
    return { content: [{ type: 'text', text: `Turn limit for ${scope} set to ${limit === null ? 'unlimited' : limit}.` }] }
  }
)

safeTool(server,
  'team_reset_turns',
  'Reset the turn counter for a specific agent, or for the whole team if agent_name is omitted.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().nullable().optional().describe('Agent name; omit to reset all counters'),
  },
  async ({ team_name, agent_name }) => {
    await resetTurns(team_name, agent_name || null)
    return { content: [{ type: 'text', text: `Turn counters reset for ${agent_name || 'all agents'}.` }] }
  }
)

safeTool(server,
  'team_get_turn_counts',
  'Report current turn counts for each agent.',
  { team_name: z.string().describe('Team name') },
  async ({ team_name }) => {
    const counts = await getTurnCounts(team_name)
    const entries = Object.entries(counts)
    if (entries.length === 0) return { content: [{ type: 'text', text: 'No turns recorded.' }] }
    const lines = entries.map(([agent, n]) => `  ${agent}: ${n}`).join('\n')
    return { content: [{ type: 'text', text: `Turn counts:\n${lines}` }] }
  }
)

safeTool(server,
  'team_list_approvals',
  'List pending (or all) HITL approvals for a team.',
  {
    team_name: z.string().describe('Team name'),
    status: z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'),
  },
  async ({ team_name, status }) => {
    const items = await listApprovalsWithLazySweep(team_name, { status })
    if (items.length === 0) return { content: [{ type: 'text', text: `No ${status} approvals.` }] }
    const lines = items.map(a => {
      const reason = a.metadata?.auto_approval_reason
        ? `\n    reason: ${a.metadata.auto_approval_reason}`
        : ''
      return `  ${a.id} [${a.status}] ${a.kind}: ${a.from} → ${a.to} @ ${a.createdAt}${reason}\n    ${a.message.text.slice(0, 200)}`
    }).join('\n')
    return { content: [{ type: 'text', text: `${items.length} approval(s):\n${lines}` }] }
  }
)

safeTool(server,
  'team_approve_message',
  'Approve a pending HITL message or handoff. Delivers it to the intended recipient.',
  {
    team_name: z.string().describe('Team name'),
    approval_id: z.string().describe('Approval ID to approve'),
    approver: z.string().default('team-lead').describe('Name of the approver'),
  },
  async ({ team_name, approval_id, approver }) => {
    // P2: sweep TTL-expired pendings BEFORE the decision so a >24h stale
    // approval can't be approved via the direct tool path (the list path
    // already swept, but team_approve_message bypassed it). After the sweep an
    // expired entry reads as rejected and the guard below reports it.
    await expirePendingApprovals(team_name)
    const existing = await getApproval(team_name, approval_id)
    if (!existing) {
      return { content: [{ type: 'text', text: `Approval ${approval_id} not found.` }], isError: true }
    }
    if (existing.status !== 'pending') {
      return { content: [{ type: 'text', text: `Approval ${approval_id} already ${existing.status}.` }], isError: true }
    }
    const updated = await decide(team_name, approval_id, 'approved', { approver })

    // Deliver the underlying message now that it's approved.
    const msg = { ...updated.message, requires_approval: false }
    const write = await writeToMailbox(team_name, updated.to, msg, { skipApproval: true })

    await emitEvent('approval.decided', {
      team_name, approval_id, decision: 'approved', approver,
    })

    if (write.blocked) {
      return { content: [{ type: 'text', text: `Approved but delivery blocked: ${write.reason}` }], isError: true }
    }
    return { content: [{ type: 'text', text: `Approval ${approval_id} approved and delivered to ${updated.to}.` }] }
  }
)

safeTool(server,
  'team_prune_approvals',
  'Remove decided (approved/rejected) approvals older than `older_than_days`. Pending approvals are never pruned. Prevents unbounded growth of approvals.json.',
  {
    team_name: z.string().describe('Team name'),
    older_than_days: z.number().default(7).describe('Retention window in days'),
  },
  async ({ team_name, older_than_days }) => {
    const removed = await pruneApprovals(team_name, older_than_days * 24 * 60 * 60 * 1000)
    return { content: [{ type: 'text', text: `Pruned ${removed} decided approval(s) older than ${older_than_days} day(s).` }] }
  }
)

safeTool(server,
  'team_reject_message',
  'Reject a pending HITL message or handoff. Notifies the original sender.',
  {
    team_name: z.string().describe('Team name'),
    approval_id: z.string().describe('Approval ID to reject'),
    approver: z.string().default('team-lead').describe('Name of the approver'),
    reason: z.string().optional().describe('Rejection reason (delivered to the sender)'),
  },
  async ({ team_name, approval_id, approver, reason }) => {
    // P2: sweep TTL-expired pendings BEFORE the decision (see team_approve_message).
    await expirePendingApprovals(team_name)
    const existing = await getApproval(team_name, approval_id)
    if (!existing) {
      return { content: [{ type: 'text', text: `Approval ${approval_id} not found.` }], isError: true }
    }
    if (existing.status !== 'pending') {
      return { content: [{ type: 'text', text: `Approval ${approval_id} already ${existing.status}.` }], isError: true }
    }
    const updated = await decide(team_name, approval_id, 'rejected', { approver, reason })

    // Notify the sender.
    await writeToMailbox(team_name, updated.from, {
      from: 'approval-queue',
      text: `Your ${updated.kind} to ${updated.to} was rejected by ${approver}${reason ? `: ${reason}` : ''}.\n\nOriginal:\n${updated.message.text}`,
      summary: `rejected: ${approval_id}`,
    }, { skipApproval: true, skipGuardrails: true, skipTurns: true })

    await emitEvent('approval.decided', {
      team_name, approval_id, decision: 'rejected', approver, reason: reason || null,
    })

    return { content: [{ type: 'text', text: `Approval ${approval_id} rejected.` }] }
  }
)

safeTool(server,
  'team_request',
  'Agents-as-tools: send a request to a teammate and BLOCK until they reply (via team_reply) or timeout. Use this for bounded subtasks where you need a structured response in-line.',
  {
    team_name: z.string().describe('Team name'),
    to: z.string().describe('Recipient agent name'),
    prompt: z.string().describe('The question or subtask for the recipient'),
    timeout_ms: z.number().default(60000).describe('Max time to wait for a reply (default 60s)'),
    from: z.string().default('team-lead').describe('Sender name'),
    orchestrator_session_id: z.string().optional().describe('Orchestrator session id; persisted on the inbox message so the recipient ACK can be relayed back to the originating orchestrator session via inbox-watcher inject-relay.'),
  },
  async ({ team_name, to, prompt, timeout_ms, from, orchestrator_session_id }) => {
    const team = await readTeam(team_name)
    if (!team) return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    const recipient = team.members.find(m => m.name === to)
    if (!recipient) return { content: [{ type: 'text', text: `Member "${to}" not found.` }], isError: true }
    const sender = team.members.find(m => m.name === from)

    const result = await sendRequest({
      teamName: team_name, from, to, prompt,
      timeoutMs: timeout_ms, senderColor: sender?.color,
      orchestratorSessionId: orchestrator_session_id,
    })

    // P1-c: the pending-approval / blocked early-returns must also surface a
    // status-persist failure, otherwise a deny/hold path is silent at the tool
    // boundary and a daemon restart would mis-recover the pending entry.
    const degradedSuffix = result.graph_degraded
      ? `\n\n[warning] graph_degraded: the request status was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    if (result.pending_approval) {
      return {
        content: [{
          type: 'text',
          text: `Request held for approval (approval_id=${result.pending_approval_id}, request_id=${result.request_id}). The request was NOT delivered to ${to}; ${result.reason}. To deliver after human approval, the approver must run team_approve_message — but note that the original sync request_id has already been deregistered, so a subsequent team_reply will fail to deliver. For HITL-gated work, send via team_send_message instead.${degradedSuffix}`,
        }],
        isError: true,
      }
    }
    if (result.blocked) {
      return { content: [{ type: 'text', text: `Request blocked: ${result.reason}${degradedSuffix}` }], isError: true }
    }
    if (result.timed_out) {
      // P1-c: a timed-out request whose terminal `expired` status also failed
      // to persist leaves the graph pending; surface that here too rather than
      // only on the completed-reply path.
      const timeoutDegradedNote = result.graph_degraded
        ? `\n\n[warning] graph_degraded: the timeout status was not persisted (${result.graph_degraded_reason}); the request would not survive a daemon restart.`
        : ''
      return { content: [{ type: 'text', text: `Request ${result.request_id} timed out after ${timeout_ms}ms.${timeoutDegradedNote}` }], isError: true }
    }
    // P1-c: graph persistence failed — the request was delivered but is NOT
    // durably tracked, so a daemon restart would not recover it. Make this
    // visible at the tool boundary instead of leaving it in a log line.
    const degradedNote = result.graph_degraded
      ? `\n\n[warning] graph_degraded: this request was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    return {
      content: [{
        type: 'text',
        text: `Reply from ${result.response.from}:\n\n${result.response.text}${degradedNote}`,
      }],
    }
  }
)

safeTool(server,
  'team_request_async',
  'Send an async (fire-and-forget) request to a teammate. Unlike team_request which blocks until reply, this returns immediately after delivery. Recipient can later team_send_message back for reply (optional). Used by orchestrators to dispatch parallel work without blocking.',
  {
    team_name: z.string().describe('Team name'),
    to: z.string().describe('Recipient agent name (broadcast "*" not supported in async v1)'),
    prompt: z.string().describe('Request body'),
    summary: z.string().optional().describe('5-10 word preview shown in inbox'),
    from: z.string().default('team-lead').describe('Sender agent name'),
    urgency_hint_ms: z.number().int().min(0).optional().describe('Hint to recipient on expected response time (informational, not enforced)'),
    orchestrator_session_id: z.string().optional().describe('Orchestrator session id; persisted on the inbox message so the recipient ACK can be relayed back to the originating orchestrator session via inbox-watcher inject-relay.'),
  },
  async ({ team_name, to, prompt, summary, from, urgency_hint_ms, orchestrator_session_id }) => {
    const team = await readTeam(team_name)
    if (!team) return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    const sender = team.members.find(m => m.name === from)
    if (!sender) return { content: [{ type: 'text', text: `Member "${from}" not found.` }], isError: true }
    if (to === '*') {
      return {
        content: [{ type: 'text', text: 'Async broadcast not supported in v1; use team_send_message for fan-out without request tracking.' }],
        isError: true,
      }
    }
    const recipient = team.members.find(m => m.name === to)
    if (!recipient) return { content: [{ type: 'text', text: `Member "${to}" not found.` }], isError: true }

    const result = await sendRequestAsync({
      teamName: team_name,
      from,
      to,
      prompt,
      summary,
      urgencyHintMs: urgency_hint_ms,
      senderColor: sender?.color,
      orchestratorSessionId: orchestrator_session_id,
    })

    if (result.pending_approval_id) {
      return {
        content: [{
          type: 'text',
          text: `Async request held for approval (approval_id=${result.pending_approval_id}, request_id=${result.request_id}). The request was NOT delivered to ${to}; ${result.reason}.`,
        }],
      }
    }
    if (result.blocked) {
      return { content: [{ type: 'text', text: `Async request blocked: ${result.reason}` }], isError: true }
    }
    return { content: [{ type: 'text', text: `Async request sent: request_id=${result.request_id} to ${to} in ${team_name}` }] }
  }
)

safeTool(server,
  'team_reply',
  'Send a reply to a pending request (created by team_request). The caller is looked up automatically. NOTE: This is for synchronous request/reply only (request_id REQUIRED). For unsolicited feedback, async follow-ups, or any message not in response to an active team_request, use team_send_message instead.',
  {
    team_name: z.string().describe('Team name'),
    request_id: z.string().describe('ID of the request you are replying to'),
    response_text: z.string().describe('Your response'),
    from: z.string().describe('Your agent name'),
  },
  async ({ team_name, request_id, response_text, from }) => {
    const team = await readTeam(team_name)
    const sender = team?.members.find(m => m.name === from)
    const result = await sendReply({
      teamName: team_name, from, requestId: request_id,
      responseText: response_text, senderColor: sender?.color,
    })
    if (result.pending_approval) {
      return {
        content: [{
          type: 'text',
          text: `Reply held for approval (approval_id=${result.pending_approval_id}). The original requester will time out before this reply is approved; do not assume the requester received it.`,
        }],
        isError: true,
      }
    }
    if (!result.delivered) {
      return { content: [{ type: 'text', text: `Reply failed: ${result.reason}` }], isError: true }
    }
    // P1-c: the reply was delivered, but if the graph status transition failed
    // the request is still `pending` in the persisted graph (a restart would
    // mis-recover it). Surface that instead of letting the replier assume the
    // request was durably resolved.
    const degradedNote = result.graph_degraded
      ? `\n\n[warning] graph_degraded: the request status was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    return { content: [{ type: 'text', text: `Reply delivered to ${result.to}.${degradedNote}` }] }
  }
)

// ============================================================
// Clone, evaluator loop, cross-team invocation
// ============================================================

safeTool(server,
  'team_clone_member',
  'Clone an existing team member into a new member with optional overrides (role, prompt, model, color, cwd). Mirrors OpenAI Agents SDK Agent.clone().',
  {
    team_name: z.string().describe('Team name'),
    from_name: z.string().describe('Existing member to copy'),
    to_name: z.string().describe('Name of the new member'),
    overrides: z.object({
      role: z.string().optional(),
      prompt: z.string().optional(),
      model: z.string().optional(),
      color: z.string().optional(),
      cwd: z.string().optional(),
    }).optional().describe('Fields to override on the clone'),
  },
  async ({ team_name, from_name, to_name, overrides }) => {
    const result = await cloneMember(team_name, from_name, to_name, overrides || {})
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Clone failed: ${result.error}` }], isError: true }
    }
    return {
      content: [{
        type: 'text',
        text: `Member "${to_name}" cloned from "${from_name}" (role: ${result.member.role}, color: ${result.member.color}).`,
      }],
    }
  }
)

safeTool(server,
  'team_evaluate_task',
  'Ask a team member (evaluator) to judge a task\'s current state and result, then append the verdict to the task. Blocks until the evaluator replies or timeout.',
  {
    team_name: z.string().describe('Team name'),
    task_id: z.string().describe('Task ID to evaluate'),
    evaluator: z.string().describe('Agent name of the judge'),
    timeout_ms: z.number().default(60000).describe('Max time to wait for the evaluator'),
    from: z.string().default('team-lead').describe('Who is requesting the evaluation'),
  },
  async ({ team_name, task_id, evaluator, timeout_ms, from }) => {
    const result = await evaluateTask({
      teamName: team_name, taskId: task_id, evaluator, from, timeoutMs: timeout_ms,
    })
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Evaluation failed: ${result.error}` }], isError: true }
    }
    const e = result.evaluation
    const promotedLine = result.promoted && result.promoted.length > 0
      ? `\nAuto-promoted to team knowledge: ${result.promoted.join(', ')}`
      : ''
    const summary = [
      `Evaluation by ${e.by} @ ${e.timestamp}:`,
      e.passed !== null ? `passed: ${e.passed}` : null,
      e.score !== null ? `score: ${e.score}` : null,
      '',
      e.text,
      promotedLine || null,
    ].filter(Boolean).join('\n')
    return { content: [{ type: 'text', text: summary }] }
  }
)

safeTool(server,
  'team_run_evaluated_task',
  'Run a worker → evaluator → REVISE/ACCEPT loop runtime. Sends `prompt` to `worker`, then `evaluator` judges the answer; if not accepted, the evaluator\'s feedback is sent back to the worker for a revision (up to `max_revisions` times). Returns the final accepted answer plus the full attempt history. Use this for self-improving subtasks where you want an in-loop quality gate without manual orchestration.',
  {
    team_name: z.string().describe('Team name'),
    worker: z.string().describe('Agent that produces answers'),
    evaluator: z.string().describe('Agent that judges and gives revision feedback (must differ from worker)'),
    prompt: z.string().describe('Initial request sent to the worker'),
    from: z.string().default('team-lead').describe('Who is orchestrating the loop'),
    max_revisions: z.number().int().min(0).max(10).default(2)
      .describe('Number of revision retries after the first attempt (0 disables, hard cap 10)'),
    timeout_ms: z.number().default(60000).describe('Per-step request timeout'),
  },
  async ({ team_name, worker, evaluator, prompt, from, max_revisions, timeout_ms }) => {
    const result = await runEvaluatedTask({
      teamName: team_name, worker, evaluator, prompt, from,
      maxRevisions: max_revisions, timeoutMs: timeout_ms,
    })
    if (!result.ok) {
      const prefix = result.pending_approval
        ? `Evaluated task held for approval (approval_id=${result.pending_approval_id})`
        : 'Evaluated task failed'
      return { content: [{ type: 'text', text: `${prefix}: ${result.error}` }], isError: true }
    }
    const verdict = result.accepted ? 'ACCEPTED' : `NOT ACCEPTED (${result.reason})`
    const ev = result.evaluation
    const excerpt = (s, n) => {
      if (typeof s !== 'string' || !s) return ''
      const flat = s.replace(/\s+/g, ' ').trim()
      return flat.length > n ? `${flat.slice(0, n)}…` : flat
    }
    const summary = [
      `Verdict: ${verdict}  (attempts=${result.attempts})`,
      ev ? `Last evaluation: passed=${ev.passed} score=${ev.score ?? 'n/a'}` : null,
      '',
      'Final answer:',
      result.result || '(no result)',
      '',
      `History (${result.history.length} attempt(s)):`,
      ...result.history.map((h, i) => {
        const e = h.evaluation
        const fb = excerpt(e.feedback, 120)
        const res = excerpt(h.result, 80)
        const fbPart = fb ? `\n      feedback: ${fb}` : ''
        const resPart = res ? `\n      result: ${res}` : ''
        return `  #${i + 1}: passed=${e.passed} score=${e.score ?? 'n/a'}${fbPart}${resPart}`
      }),
    ].filter(Boolean).join('\n')
    return { content: [{ type: 'text', text: summary }] }
  }
)

safeTool(server,
  'team_run_consensus_task',
  'Run a worker → N parallel evaluators → quorum loop. Each round: worker produces an answer, N evaluators independently judge it (in parallel via schema-validated requests). Default-ACCEPT semantics: accept iff no evaluator explicitly says passed=false (abstains from schema-failed evaluators do NOT block ACCEPT). When `quorum` is given, require at least that many passed=true votes instead. On revise, feedback from refuting evaluators is deduped by first 80 chars and merged into the worker revision prompt. Use this when one judge can hallucinate and you want multi-vote robustness.',
  {
    team_name: z.string().describe('Team name'),
    worker: z.string().describe('Agent that produces answers'),
    evaluators: z.array(z.string()).min(2).describe('Agent names that judge the worker. Must have at least 2 distinct members, none equal to worker.'),
    prompt: z.string().describe('Initial request sent to the worker'),
    from: z.string().default('team-lead').describe('Who is orchestrating the loop'),
    quorum: z.number().int().min(1).optional().describe('Optional minimum passed=true votes for ACCEPT (default = no quorum, ACCEPT iff zero explicit refutes). When set, abstains count against quorum.'),
    max_revisions: z.number().int().min(0).max(10).default(2)
      .describe('Number of revision retries after the first attempt (0 disables, hard cap 10)'),
    timeout_ms: z.number().default(60000).describe('Per-request timeout (applies to each worker turn and each evaluator turn independently)'),
  },
  async ({ team_name, worker, evaluators, prompt, from, quorum, max_revisions, timeout_ms }) => {
    const result = await runConsensusTask({
      teamName: team_name, worker, evaluators, prompt, from,
      quorum, maxRevisions: max_revisions, timeoutMs: timeout_ms,
    })
    if (!result.ok) {
      const prefix = result.pending_approval
        ? `Consensus task held for approval (approval_id=${result.pending_approval_id}, evaluator=${result.held_evaluator || '?'})`
        : 'Consensus task failed'
      return { content: [{ type: 'text', text: `${prefix}: ${result.error}` }], isError: true }
    }
    const verdict = result.accepted ? 'ACCEPTED' : `NOT ACCEPTED (${result.reason})`
    const s = result.summary || { accepts: 0, refutes: 0, abstains: 0, total: 0 }
    const excerpt = (str, n) => {
      if (typeof str !== 'string' || !str) return ''
      const flat = str.replace(/\s+/g, ' ').trim()
      return flat.length > n ? `${flat.slice(0, n)}…` : flat
    }
    const voteLines = (result.votes || []).map(v => {
      const label = v.passed === true ? 'ACCEPT' : v.passed === false ? 'REFUTE' : 'ABSTAIN'
      const fb = v.passed === false ? `  — ${excerpt(v.feedback, 100)}` : ''
      return `  - ${v.evaluator}: ${label}${fb}`
    })
    const summary = [
      `Verdict: ${verdict}  (attempts=${result.attempts})`,
      `Final vote: ${s.accepts} accept / ${s.refutes} refute / ${s.abstains} abstain (of ${s.total})`,
      '',
      'Per-evaluator votes (last round):',
      ...voteLines,
      '',
      'Final answer:',
      result.result || '(no result)',
    ].filter(Boolean).join('\n')
    return { content: [{ type: 'text', text: summary }] }
  }
)

safeTool(server,
  'team_invoke',
  'Invoke an agent in ANOTHER team and block until they reply (via team_cross_reply) or timeout. Extends agents-as-tools across team boundaries.',
  {
    source_team: z.string().describe('Your team name'),
    source_agent: z.string().describe('Your agent name (who will receive the reply)'),
    target_team: z.string().describe('Team where the invoked agent lives'),
    target_agent: z.string().describe('Agent to invoke in the target team'),
    prompt: z.string().describe('Subtask / question for the target agent'),
    timeout_ms: z.number().default(60000),
    requires_approval: z.boolean().default(false).describe('Mark this cross-team invocation as HITL-gated. When the target team is configured mode:"autonomous", the admission gate (S3-B) denies the request so an autonomous worker is never blocked waiting on human approval that will never come.'),
  },
  async ({ source_team, source_agent, target_team, target_agent, prompt, timeout_ms, requires_approval }) => {
    const srcTeam = await readTeam(source_team)
    const sender = srcTeam?.members.find(m => m.name === source_agent)
    const result = await invoke({
      sourceTeam: source_team, sourceAgent: source_agent,
      targetTeam: target_team, targetAgent: target_agent,
      prompt, timeoutMs: timeout_ms, senderColor: sender?.color,
      requiresApproval: requires_approval,
    })
    // P1-c: admission-deny / error early-returns must also surface a
    // status-persist failure, otherwise the deny path is silent at the tool
    // boundary and a daemon restart would mis-recover the pending entry.
    const degradedSuffix = result.graph_degraded
      ? `\n\n[warning] graph_degraded: the request status was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    if (result.error) {
      return { content: [{ type: 'text', text: `Invoke failed: ${result.error}${degradedSuffix}` }], isError: true }
    }
    if (result.blocked) {
      return { content: [{ type: 'text', text: `Invoke blocked: ${result.reason}${degradedSuffix}` }], isError: true }
    }
    if (result.timed_out) {
      // P1-c: same as team_request — a timed-out cross-team invoke whose
      // `expired` status failed to persist must still surface graph_degraded.
      const timeoutDegradedNote = result.graph_degraded
        ? `\n\n[warning] graph_degraded: the timeout status was not persisted (${result.graph_degraded_reason}); the request would not survive a daemon restart.`
        : ''
      return { content: [{ type: 'text', text: `Cross-team invoke ${result.request_id} timed out.${timeoutDegradedNote}` }], isError: true }
    }
    // P1-c: surface non-durable (un-persisted) cross-team request at the tool
    // boundary so the caller doesn't assume restart recovery will see it.
    const degradedNote = result.graph_degraded
      ? `\n\n[warning] graph_degraded: this cross-team request was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    return {
      content: [{
        type: 'text',
        text: `Reply from ${result.response.from}:\n\n${result.response.text}${degradedNote}`,
      }],
    }
  }
)

safeTool(server,
  'team_cross_reply',
  'Reply to a cross-team request received in your inbox. Reads the source_team / source_agent / request_id from the original <cross-team-request> envelope.',
  {
    source_team: z.string().describe('Team of the original requester'),
    source_agent: z.string().describe('Agent that issued the request'),
    request_id: z.string().describe('ID from the <cross-team-request> envelope'),
    from_team: z.string().describe('Your team name'),
    from_agent: z.string().describe('Your agent name'),
    response_text: z.string().describe('Your response'),
  },
  async ({ source_team, source_agent, request_id, from_team, from_agent, response_text }) => {
    const result = await crossReply({
      sourceTeam: source_team, sourceAgent: source_agent,
      requestId: request_id, fromTeam: from_team, fromAgent: from_agent,
      responseText: response_text,
    })
    if (!result.delivered) {
      return { content: [{ type: 'text', text: `Cross-reply failed: ${result.reason}` }], isError: true }
    }
    const degradedNote = result.graph_degraded
      ? `\n\n[warning] graph_degraded: the request status was not persisted (${result.graph_degraded_reason}); it would not survive a daemon restart.`
      : ''
    return { content: [{ type: 'text', text: `Cross-reply delivered to ${source_agent}@${source_team}.${degradedNote}` }] }
  }
)

// ============================================================
// Memory / Knowledge / Briefing
// ============================================================

safeTool(server,
  'team_note',
  'Record a structured note to your agent notebook (Tier 2 memory). Use for findings, decisions, assumptions, open questions, next steps, gotchas — anything your future self resuming in a new session will need to know. KEEP IT SHORT.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Your agent name'),
    kind: z.enum(NOTE_KINDS).describe('What kind of note: finding | decision | assumption | open_question | next_step | gotcha'),
    content: z.string().describe('One-sentence statement. Example: "JWT validation is centralized in middleware.ts; bypass is not allowed"'),
    topic: z.string().optional().describe('Short tag for searching (e.g. "auth", "db-migration")'),
    task_id: z.string().optional().describe('Task this note came from'),
    tags: z.array(z.string()).optional(),
  },
  async ({ team_name, agent_name, kind, content, topic, task_id, tags }) => {
    const note = await writeNote(team_name, agent_name, { kind, content, topic, task_id, tags })
    return { content: [{ type: 'text', text: `Noted ${note.id} (${kind}${topic ? `/${topic}` : ''}).` }] }
  }
)

safeTool(server,
  'team_remember',
  'Promote a fact to the team-wide knowledge base (Tier 3). Use this ONLY for high-signal facts that matter to other agents, not for personal working notes. Optionally mirror to the relvetia daily log via also_log_to_relvetia=true.',
  {
    team_name: z.string().describe('Team name'),
    content: z.string().describe('The canonical statement. Example: "Production uses Redis 7; AOF fsync every second"'),
    topic: z.string().optional().describe('Short tag for retrieval'),
    source_agent: z.string().optional().describe('Agent who discovered this (for attribution)'),
    source_note_id: z.string().optional().describe('Note this was promoted from'),
    tags: z.array(z.string()).optional(),
    also_log_to_relvetia: z.boolean().optional().describe('If true, also append a single line to ~/.claude/memory/logs/YYYY/MM/YYYY-MM-DD.md (relvetia daily log). Default false; opt-in to bridge cross-session memory.'),
  },
  async ({ team_name, content, topic, source_agent, source_note_id, tags, also_log_to_relvetia }) => {
    const kn = await promoteToKnowledge(team_name, { content, topic, source_agent, source_note_id, tags })
    let extra = ''
    if (also_log_to_relvetia) {
      try {
        const logTags = ['team_remember', team_name]
        if (topic) logTags.push(topic)
        if (Array.isArray(tags)) logTags.push(...tags)
        const { file } = await appendRelvetiaLog(content, { tags: logTags })
        extra = ` + relvetia log: ${file}`
      } catch (e) {
        extra = ` (relvetia log append failed: ${e.message})`
      }
    }
    return { content: [{ type: 'text', text: `Remembered ${kn.id}${topic ? ` (topic: ${topic})` : ''}.${extra}` }] }
  }
)

safeTool(server,
  'memory_search',
  'Screening-aware search over the relvetia persistent memory (~/.claude/memory/). Uses the same TF-IDF + Trim-and-Square + 5-stage retrieval engine as the saga 5 baseline-v3 (Recall@5 ≥94% / MRR ≥0.93 on Path A). Returns results whose relevance passes an absolute threshold — items below the threshold are completely excluded, not just ranked lower. Distinct from team_search_memory (which is a grep-style boolean matcher over team notes/knowledge + an optional relvetia-memory bridge); both co-exist and are non-overlapping by design (saga 6 §3.4). Read-only; production memory dir is never mutated.',
  {
    query: z.string().min(1).max(2000).describe('Search query (TF-IDF + Trim-and-Square screening applied; case-insensitive).'),
    maxResults: z.number().int().min(1).max(50).optional().describe('Maximum results (default: screeningConfig.searchMaxResults).'),
    scoreStrategy: z.enum(['default', 'llm-reranker-cap-only']).optional().describe('Phase 3 ScoreStrategy slot; Phase 1 accepts the value but currently uses the engine default (NoopScoreStrategy).'),
  },
  async (args) => memorySearchToolHandler(args),
  { strict: true },
)

safeTool(server,
  'private_memory_search',
  'Search a configured persona\'s private memory namespace using the same TF-IDF + Trim-and-Square + 5-stage retrieval engine as memory_search (diary/** is included because self-recall is allowed for the persona/Claude internal context). Disabled by default for public distribution: returns an empty disabled envelope unless a persona is configured — either via PRIVATE_* env vars (env path, takes precedence) or a persona.config.json at $PERSONA_CONFIG_PATH or ~/.claude/persona.config.json (see persona.config.example.json). When the active persona sets expectedHost and/or marker, the gate enforces them (COMPUTERNAME match + marker file present); a persona that sets neither is host-gate-less. Read-only; never mutates production memory files.',
  {
    query: z.string().min(1).max(2000).describe('Search query against the private/ corpus (case-insensitive).'),
    k: z.number().int().min(1).max(20).optional().describe('Maximum results (default: 8).'),
  },
  async (args) => privateMemorySearchToolHandler(args),
  { strict: true },
)

safeTool(server,
  'memory_remember',
  'Append a single timestamped line to today\'s relvetia daily log (~/.claude/memory/logs/YYYY/MM/YYYY-MM-DD.md, JST minute precision). The only one of the four saga 8 memory tools (memory_search / memory_remember / memory_log_recent / memory_status) that mutates the relvetia memory directory; the other three are read-only. NOTE: the pre-existing team_remember(also_log_to_relvetia=true) is a separate, coexisting write path via the same appendRelvetiaLog (see src/index.js team_remember handler) — server-wide there are two relvetia-log writers, not one. memory_remember writes ONLY to the daily log file (stats.json / index.json / MEMORY.md / concepts/graph.json are never touched — invariant enforced by relvetia-memory-tools.test.js production-invariant sentinel + the dedicated contract-claim sentinel in the same file). Set $RELVETIA_MEMORY_DIR for test isolation. Tags are serialised as a "[tag1][tag2]" prefix. Returns the absolute log file path and the line that was written.',
  {
    // Codex P1 #2, saga 8 Phase 2-revB: content + tags must be single-line
    // and tags must not contain "]" so a malicious / careless caller cannot
    // break the LOG_LINE_RE parse contract in memory.js. Without these
    // regex constraints, content="line1\nline2" would write two physical
    // lines, the second of which memory_log_recent's regex would either
    // drop or misattribute as a separate untagged entry.
    content: z.string().min(1).max(8000)
      .regex(/^[^\r\n]+$/, 'content must be a single line — newlines are forbidden because memory_log_recent parses one entry per physical line')
      .describe('Log line body (post-tag), single physical line (no newlines).'),
    tags: z.array(
      z.string().min(1).max(64)
        .regex(/^[^\]\r\n]+$/, 'tag must not contain "]" or newlines — those break the [tag1][tag2] prefix parse in memory.js LOG_LINE_RE'),
    ).max(16).optional().describe('Tag prefix list (e.g., ["log","saga8"] → "[log][saga8]"). Each tag must be a single line without "]". Omit for an unprefixed line.'),
  },
  async (args) => memoryRememberToolHandler(args),
  { strict: true },
)

safeTool(server,
  'memory_log_recent',
  'Read structured entries from the relvetia daily logs (~/.claude/memory/logs/) within the last `days` days, newest-first. Returns each line parsed into { date, time, content, tags, file, topic, timestamp }. Read-only; never mutates production memory files (invariant covered by the sentinel test). Distinct from memory_search (which is screening-aware over MEMORY.md / topics / logs) — memory_log_recent is a chronological tail of raw daily-log lines without any relevance ranking.',
  {
    days: z.number().int().min(1).max(30).optional().describe('Days back to include (default: 1 = today only).'),
    limit: z.number().int().min(1).max(500).optional().describe('Maximum entries returned (default: 100, hard cap 500).'),
  },
  async (args) => memoryLogRecentToolHandler(args),
  { strict: true },
)

safeTool(server,
  'memory_status',
  'Summarise relvetia memory state: MEMORY.md line count, topics/*.md file count (recursive), logs/YYYY/MM/*.md file count, log date range (firstDate / lastDate / totalDays), index.json entry count, and the last distillation timestamp (parsed from "Last distilled:" line in MEMORY.md, or .last-distill mtime as fallback). Read-only; touches no production memory files. Equivalent to the `/relvetia status` slash command but callable from any tool context.',
  {},
  async (args) => memoryStatusToolHandler(args),
  { strict: true },
)

safeTool(server,
  'daemon_status',
  'Probe the relvetia-daemon PM2 process state + scheduler lock file health. Reads `pm2 jlist` (JSON; graceful when pm2 binary is absent → pm2State="unknown") and the lock file at $RELVETIA_DIR/.claude/.scheduler.lock (default ~/.claude/relvetia/.claude/.scheduler.lock). Returns { pm2State: online|stopped|errored|unknown, lockFile: {exists,pid,alive}, uptime (seconds), restartCount, recentRestart (ISO|null) }. Read-only; never starts or stops the daemon.',
  {},
  async (args) => daemonStatusToolHandler(args),
  { strict: true },
)

// =====================================================================
// Saga 9 Phase 3: relvetia admin tools (6 tools, file-only operations).
//
// All six tools operate on $RELVETIA_DIR (default ~/.claude/relvetia) and
// — for walker_status only — $RELVETIA_WALKER_SCHEDULE_PATH (default
// ~/.claude/relvetia/persona/walkers/schedule.json). Mutations land on
// scheduled_tasks.json ONLY. Production memory files (stats.json /
// index.json / MEMORY.md / concepts/graph.json) are NEVER touched —
// invariant pinned by relvetia-admin-tools.test.js production-invariant
// sentinel (saga 8 §16 lived practice).
// =====================================================================

safeTool(server,
  'distill_mark_fired',
  'Bookkeeping-only: set `lastFiredAt = now` for a distill-family task (relvetia-dream | relvetia-verify | relvetia-optimize) in scheduled_tasks.json. **This tool does NOT invoke the distill subprocess AND does NOT affect the daemon\'s nextFireAt schedule.** Codex P0 saga 9 §17 NEW lesson lived practice: the daemon\'s `nextFireAt` map (relvetia-daemon/src/scheduler.ts L142-162) is an in-memory cache that is NOT invalidated by external file changes; the chokidar watch only refreshes the tasks array (`load(false)`), not the cache. So an external `lastFiredAt` write neither triggers a fire nor shifts the next fire. Intended use = bookkeeping (e.g., "I just ran distill manually via /relvetia dream outside the daemon, record that fact so distill_status reflects it"). For actual triggering, use the /relvetia dream slash command. To shift the daemon schedule, restart pm2 relvetia-daemon. Cooldown: force=false skips when lastFiredAt within 6h; force=true bypasses. Returns { marked, taskId, lastFiredAt, message }. Mutation target: scheduled_tasks.json only — production memory dir is never touched (saga 8 §16 + saga 9 §17 sentinel pins this).',
  {
    force: z.boolean().optional().describe('Bypass the 6h cooldown gate (default: false).'),
    taskId: z.enum(['relvetia-dream', 'relvetia-verify', 'relvetia-optimize']).optional()
      .describe('Which permanent distill-family task to mark (default: relvetia-dream).'),
  },
  async (args) => distillMarkFiredToolHandler(args),
  { strict: true },
)

safeTool(server,
  'distill_status',
  'Read-only view of the three STATIC_PERMANENT_TASKS that drive nightly distillation (relvetia-dream / relvetia-verify / relvetia-optimize, mirrored from relvetia-daemon/src/bootstrap.ts L27-53). Saga 10 Phase 4-2 P2 #3: structured return is { tasks, static, dynamic } — `tasks` keeps its prior shape (only the 3 STATIC entries) for backward compat, `static` aliases `tasks`, and `dynamic` surfaces every non-STATIC entry from scheduled_tasks.json (walkers + ad-hoc scheduled_task_create entries) so an operator gets a single read-only inventory of scheduled entries from this surface. Each STATIC entry: { id, cron, lastFiredAt, nextFireAt, permanent, registered }. Each dynamic entry adds `cronAcceptedByLocalValidator: boolean` (saga 10 revB P1 #5 + revD honest scope = the result of isValidCronExpression(cron), the **local 5-field cron validator only — NOT a full daemon-acceptance check**. `true` = local validator passed; the daemon may still drop the entry on other grounds (missing prompt/createdAt/id, etc.). `false` = local validator rejected; the daemon (using the `croner` library, see relvetia-daemon/src/cron.ts L14) may still accept croner-only syntax such as day-of-week aliases (`MON`, `TUE`, ...), the `@daily` shorthand, or 6-field crons. Full daemon-side mirror is saga 11+ scope.). cron is sourced from scheduled_tasks.json when registered; STATIC fallback otherwise. nextFireAt is always null — predictive next-fire computation lives in the daemon\'s in-memory nextFireAt cache (relvetia-daemon/src/scheduler.ts), not in this tool. Read-only; never mutates production memory files.',
  {},
  async (args) => distillStatusToolHandler(args),
  { strict: true },
)

safeTool(server,
  'walker_status',
  'Read-only view of the persona walker schedule. Reads ~/.claude/relvetia/persona/walkers/schedule.json (override via $RELVETIA_WALKER_SCHEDULE_PATH), expands each walker\'s HH:MM list into 5-field cron strings (mirror of relvetia-daemon/src/bootstrap.ts hhmmToCron), and joins lastFiredAt from scheduled_tasks.json by id. Returns walkers=[] when schedule.json is missing or malformed JSON (graceful — never throws across the MCP boundary). Read-only; never mutates production memory files.',
  {},
  async (args) => walkerStatusToolHandler(args),
  { strict: true },
)

safeTool(server,
  'scheduled_task_list',
  'Read-only list of all entries in scheduled_tasks.json (~/.claude/relvetia/.claude/scheduled_tasks.json, override via $RELVETIA_DIR). Returns { tasks: Array<{ id, cron, prompt, createdAt, lastFiredAt:number|null, recurring, permanent, nativeHandler? }> }. includePermanent=true (default) returns the full list; false filters out permanent=true tasks (the bootstrap-registered distill family + walkers). Read-only; never mutates production memory files.',
  {
    includePermanent: z.boolean().optional().describe('Include permanent tasks in the result (default: true).'),
  },
  async (args) => scheduledTaskListToolHandler(args),
  { strict: true },
)

safeTool(server,
  'scheduled_task_create',
  'Append a new task to scheduled_tasks.json (~/.claude/relvetia/.claude/scheduled_tasks.json). Generates an 8-char hex id, writes { id, cron, prompt, createdAt, recurring? } via tmp+rename atomic write. permanent is NEVER set by this tool — that flag is reserved for bootstrap-registered tasks (relvetia-daemon/src/bootstrap.ts STATIC_PERMANENT_TASKS). recurring defaults to true; pass false for a one-shot task (deleted by the daemon after firing). **Cron string is validated at the MCP boundary** (saga 9 P1 #1 lived practice via isValidCronExpression — mirrors the daemon\'s 5-field parser surface). Malformed crons throw INVALID_CRON before any file write so scheduled_tasks.json is never half-written with a task the daemon would silently drop at read time. Returns { id, cron, recurring, createdAt }. The MCP version of the `/relvetia schedule` slash command.',
  {
    cron: z.string().min(1).max(200).describe('5-field cron expression (e.g. "0 9 * * *"). Validated at the MCP boundary via isValidCronExpression — daemon-parity 5-field parser; out-of-range or malformed input is rejected before file write (saga 9 P1 #1).'),
    prompt: z.string().min(1).max(8000).describe('Prompt body fired when the cron triggers.'),
    recurring: z.boolean().optional().describe('When false, task is one-shot (deleted after fire). Default: true.'),
  },
  async (args) => scheduledTaskCreateToolHandler(args),
  { strict: true },
)

safeTool(server,
  'scheduled_task_cancel',
  'Remove a non-permanent task from scheduled_tasks.json (~/.claude/relvetia/.claude/scheduled_tasks.json) by id. Refuses to remove permanent=true tasks (bootstrap-registered distill family + walker family) — the daemon would re-create them on next restart anyway, so a silent cancel here would just confuse the operator. To suppress a walker, edit schedule.json (enabled=false). To remove a distill task, delete its entry in relvetia-daemon/src/bootstrap.ts STATIC_PERMANENT_TASKS. Returns { cancelled, removedTask, message }. The MCP version of the `/relvetia cancel` slash command.',
  {
    id: z.string().min(1).max(200).describe('Task id to cancel (from scheduled_task_list output).'),
  },
  async (args) => scheduledTaskCancelToolHandler(args),
  { strict: true },
)

safeTool(server,
  'team_search_memory',
  'Boolean-search the team\'s notes (Tier 2), knowledge (Tier 3), and/or the relvetia daily logs (~/.claude/memory/logs/). Query syntax: AND (default), OR, NOT (-token), quoted phrase. Use this BEFORE asking teammates — the answer may already be recorded. scope=relvetia-memory or scope=all bridges to ~/.claude/memory/logs/ for cross-session context. Non-empty queries are ranked by TF-IDF + recency screening; the formatted response is byte-capped (~16KB) and the MCP envelope carries structuredContent.truncated when the cap fires.',
  {
    team_name: z.string().describe('Team name'),
    query: z.string().describe('Search query; empty string returns everything in scope ordered by timestamp. Non-empty: ranked by relevance (TF-IDF + recency). Supports AND (default), OR, -token (NOT), "quoted phrase".'),
    scope: z.enum(['notes', 'knowledge', 'both', 'relvetia-memory', 'all']).default('both').describe('"relvetia-memory" = ~/.claude/memory/logs/ only; "all" = notes+knowledge+relvetia.'),
    agent: z.string().optional().describe('Limit notes search to this agent'),
    kind: z.enum(NOTE_KINDS).optional().describe('Filter notes by kind'),
    limit: z.number().int().min(1).max(200).default(20).describe('Max results (1..200, default 20).'),
  },
  async ({ team_name, query, scope, agent, kind, limit }) => {
    const results = await searchMemory(team_name, query, { scope, agent, kind, limit })
    if (results.length === 0) return { content: [{ type: 'text', text: 'No matching memory.' }] }
    const lines = results.map(formatSearchLine)
    const truncated = Boolean(results._truncated)
    const omittedCount = Number(results._omittedCount || 0)
    const keptCount = Number(results._keptCount ?? results.length)
    const totalCount = Number(results._totalCount ?? results.length)
    const rankedCount = Number(results._rankedCount ?? results.length)
    const budgetBytes = Number(results._budgetBytes ?? SEARCH_RETURN_BUDGET_BYTES)
    const fallback = Boolean(results._fallback)
    const header = truncated
      ? `[NOTICE: showing ${keptCount} match(es); ${omittedCount} dropped to fit ${Math.round(budgetBytes / 1024)}KB byte budget. Refine the query for full coverage.]`
      : `${results.length} match(es):`
    return {
      content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
      structuredContent: {
        truncated,
        omitted_count: omittedCount,
        kept_count: keptCount,
        total_count: totalCount,
        ranked_count: rankedCount,
        budget_bytes: budgetBytes,
        fallback,
      },
    }
  }
)

safeTool(server,
  'team_list_notes',
  'List an agent\'s notes with optional filters (kind, topic, recent). Useful for browsing your own notebook before a task.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent whose notes to list'),
    kind: z.enum(NOTE_KINDS).optional(),
    topic: z.string().optional().describe('Substring match on topic'),
    since: z.string().optional().describe('ISO timestamp; include notes with ts >= since'),
    limit: z.number().default(50),
  },
  async ({ team_name, agent_name, kind, topic, since, limit }) => {
    const notes = await readNotes(team_name, agent_name, { kind, topic, since, limit })
    if (notes.length === 0) return { content: [{ type: 'text', text: 'No notes.' }] }
    const lines = notes.map(n => `[${n.kind}] ${n.topic ? n.topic + ': ' : ''}${n.content}  (${n.timestamp})`)
    return { content: [{ type: 'text', text: `${notes.length} note(s):\n${lines.join('\n')}` }] }
  }
)

safeTool(server,
  'team_prime_agent',
  'Build a briefing from an agent\'s notes + team knowledge and deliver it to their inbox as a "welcome back" message. Call this BEFORE the agent resumes work in a new session.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent to prime'),
    topics_of_interest: z.array(z.string()).optional().describe('Narrow findings/knowledge to these topics'),
    finding_days: z.number().optional().describe('Look back this many days for recent findings'),
  },
  async ({ team_name, agent_name, topics_of_interest, finding_days }) => {
    const briefing = await primeAgent(team_name, agent_name, {
      topicsOfInterest: topics_of_interest,
      findingDays: finding_days,
    })
    const c = briefing.counts
    const summary =
      `Briefing delivered to ${agent_name}: ` +
      `${c.open_questions} open questions, ${c.next_steps} next steps, ` +
      `${c.assumptions} assumptions, ${c.decisions} decisions, ${c.gotchas} gotchas, ` +
      `${c.findings} recent findings, ${c.knowledge} team knowledge entries, ${c.open_tasks} open tasks.`
    return { content: [{ type: 'text', text: summary }] }
  }
)

safeTool(server,
  'team_build_briefing',
  'Build a briefing for an agent WITHOUT writing it to any inbox. Useful for preview, logging, or when you want to embed the briefing in another message. The formatted text is byte-capped (~32KB) and the MCP envelope carries structuredContent.truncated when the cap fires.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent to build briefing for'),
    topics_of_interest: z.array(z.string()).optional(),
    finding_days: z.number().optional(),
  },
  async ({ team_name, agent_name, topics_of_interest, finding_days }) => {
    const briefing = await buildBriefing(team_name, agent_name, {
      topicsOfInterest: topics_of_interest,
      findingDays: finding_days,
    })
    const capped = applyBriefingBudget(briefing.text)
    if (capped.truncated) {
      await emitEvent('memory.capped', {
        layer: 'briefing',
        team_name,
        agent_name,
        omitted_bytes: capped.omitted_bytes,
        total_bytes: capped.total_bytes,
        budget_bytes: capped.budget_bytes,
      })
    }
    return {
      content: [{ type: 'text', text: capped.text }],
      structuredContent: {
        truncated: capped.truncated,
        omitted_bytes: capped.omitted_bytes,
        total_bytes: capped.total_bytes,
        budget_bytes: capped.budget_bytes,
        counts: briefing.counts,
      },
    }
  }
)

safeTool(server,
  'team_render_prompt',
  'Render a template string with live team context ({unread_count}, {open_tasks}, {agent}, {role}, {members}, {team}, {total_tasks}). Used for dynamic instructions.',
  {
    team_name: z.string().describe('Team name'),
    agent_name: z.string().describe('Agent whose context to use'),
    template: z.string().describe('Template with {var} placeholders'),
  },
  async ({ team_name, agent_name, template }) => {
    const team = await readTeam(team_name)
    if (!team) {
      return { content: [{ type: 'text', text: `Team "${team_name}" not found.` }] }
    }
    const rendered = await renderForAgent(template, team_name, agent_name)
    return { content: [{ type: 'text', text: rendered }] }
  }
)

safeTool(server,
  'team_delete_task',
  'Delete a task from the shared task list.',
  {
    team_name: z.string().describe('Team name'),
    task_id: z.string().describe('Task ID to delete'),
  },
  async ({ team_name, task_id }) => {
    const deleted = await deleteTask(team_name, task_id)
    if (!deleted) {
      return { content: [{ type: 'text', text: `Task #${task_id} not found.` }] }
    }
    return { content: [{ type: 'text', text: `Task #${task_id} deleted.` }] }
  }
)

// ============================================================
// Start Server
// ============================================================

export { server }

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // W2-S4 S4-E — daemon crash recovery: walk pending requests in
  // ~/.claude/relvetia/team-graph.json and expire any past deadline (no grace,
  // previous daemon process is gone). Best-effort: failures are logged but do
  // not block startup. Skipped silently when graph file missing (default source).
  try {
    const recovered = recoverGraphPendingOnRestart()
    if (recovered.expired.length > 0) {
      console.error(
        `[graph-store] crash-recovery: expired ${recovered.expired.length}/${recovered.total} pending request(s) (source=${recovered.source})`,
      )
      for (const e of recovered.expired) {
        console.error(
          `[graph-store]   ${e.from} → ${e.to} request_id=${e.request_id} deadline_at=${e.deadline_at}`,
        )
      }
    }
  } catch (err) {
    console.error(`[graph-store] crash-recovery error: ${err?.message ?? err}`)
  }

  // Channels: must run AFTER connect (notification() throws "Not connected"
  // if the transport isn't attached). Owns its own teardown on process exit.
  const channels = await initChannels(server.server, {})

  // Optional pre-seed: RELVETIA_AGENT_ALIASES='[{"team":"T","agent":"A"}, ...]'
  // adds secondary channels watchers at startup so spawn-relay / SessionStart
  // can grant a Discord-launched session (primary: discord-claude/claude-N)
  // proactive notify on cross-team identities (e.g. relvetia/orchestrator-X)
  // without a follow-up team_add_watch tool call. Failures here are non-fatal
  // — the primary watch keeps working.
  const aliasHandles = []
  for (const alias of parseAgentAliases()) {
    try {
      const handle = await addChannelWatch(server.server, alias)
      aliasHandles.push(handle)
    } catch (err) {
      console.error(`[channels] alias pre-seed failed for ${alias.team}/${alias.agent}: ${err?.message ?? err}`)
    }
  }

  const closeChannels = () => {
    try { channels.close() } catch {}
    for (const h of aliasHandles) { try { h.close() } catch {} }
  }
  process.once('SIGINT', closeChannels)
  process.once('SIGTERM', closeChannels)
  process.once('exit', closeChannels)
}

