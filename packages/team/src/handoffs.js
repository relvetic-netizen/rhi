// Handoffs — inspired by OpenAI Agents SDK `handoff()`.
// A handoff is an explicit transfer of responsibility from one agent to
// another. Unlike a plain message, it:
//   - Delivers a structured <handoff> envelope the recipient can parse.
//   - Optionally transfers ownership of a task atomically.
//   - Marks the sender idle and the recipient active.
//   - Runs an input_filter over the payload (trim/summarize) before delivery.
//   - Emits a trace event and fires the on_handoff lifecycle hook.

import { writeToMailbox } from './mailbox.js'
import { updateMemberStatus } from './team.js'
import { updateTask } from './tasks.js'
import { emitEvent } from './tracing.js'
import { fireHook } from './hooks.js'
import { errorMessage } from './errors.js'

// ---------------------------------------------------------------------------
// Built-in input filters
// Filters take (text, config) and return transformed text. They are pure —
// no LLM calls, so relvetia-team stays LLM-agnostic at this layer.
// ---------------------------------------------------------------------------

const FILTERS = {
  none: (text) => text,

  truncate: (text, { max_length = 2000 } = {}) => {
    if (!text || text.length <= max_length) return text
    return text.slice(0, max_length) + '\n[truncated by handoff filter]'
  },

  last_n_lines: (text, { n = 20 } = {}) => {
    if (!text) return text
    const lines = text.split('\n')
    if (lines.length <= n) return text
    return '[earlier lines omitted]\n' + lines.slice(-n).join('\n')
  },

  remove_code_blocks: (text) => {
    if (!text) return text
    return text.replace(/```[\s\S]*?```/g, '[code block removed]')
  },
}

function applyFilter(text, spec) {
  if (!spec || !spec.name) return text
  const fn = FILTERS[spec.name]
  if (!fn) {
    console.error(`[handoff] Unknown input filter: ${spec.name}`)
    return text
  }
  try {
    return fn(text, spec)
  } catch (e) {
    console.error(`[handoff] Filter ${spec.name} failed: ${errorMessage(e)}`)
    return text
  }
}

/**
 * Perform a handoff.
 *
 * @param {object} args
 * @param {string} args.teamName
 * @param {string} args.from        — sender agent name
 * @param {string} args.to          — recipient agent name
 * @param {string} args.reason      — why the handoff is happening
 * @param {string} [args.payload]   — context the recipient needs
 * @param {object} [args.inputFilter] — { name: 'truncate'|'last_n_lines'|'remove_code_blocks'|'none', ...config }
 * @param {string} [args.taskId]    — transfer ownership of this task to `to`
 * @param {string} [args.senderColor]
 * @returns {{ delivered: boolean, reason?: string, task?: object }}
 */
export async function performHandoff({
  teamName, from, to, reason, payload = '', inputFilter, taskId, senderColor,
  requiresApproval = false,
}) {
  const filtered = applyFilter(payload, inputFilter)

  // Build the handoff envelope. The <handoff ...> wrapper gives the recipient
  // a clear signal that this is a transfer, not an ordinary message.
  const envelope =
    `<handoff from="${from}" reason="${reason}">\n` +
    (filtered ? `${filtered}\n` : '') +
    `</handoff>`

  const write = await writeToMailbox(teamName, to, {
    from,
    text: envelope,
    summary: `handoff: ${reason}`.slice(0, 80),
    color: senderColor,
    requires_approval: requiresApproval,
  }, {
    approvalKind: 'handoff',
    approvalMetadata: { reason, task_id: taskId || null, input_filter: inputFilter || null },
  })

  if (write.blocked) {
    return { delivered: false, reason: `blocked: ${write.reason}` }
  }
  if (write.pending_approval_id) {
    return { delivered: false, pending_approval_id: write.pending_approval_id, reason: 'awaiting approval' }
  }

  // Transfer task ownership atomically if requested.
  let updatedTask = null
  if (taskId) {
    updatedTask = await updateTask(teamName, taskId, { owner: to, status: 'in_progress' })
  }

  // Flip activity flags. Errors are non-fatal — the handoff message already
  // landed, so we log and continue.
  try {
    await updateMemberStatus(teamName, from, false)
    await updateMemberStatus(teamName, to, true)
  } catch (e) {
    console.error(`[handoff] Failed to update activity flags: ${errorMessage(e)}`)
  }

  await emitEvent('handoff', {
    team_name: teamName, from, to, reason, task_id: taskId || null,
    filter: inputFilter?.name || 'none',
  })
  await fireHook('on_handoff', {
    team: teamName, from, to, reason, task: updatedTask,
  })

  return { delivered: true, task: updatedTask }
}
