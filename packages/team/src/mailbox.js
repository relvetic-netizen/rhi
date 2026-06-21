// Mailbox system — modeled on Claude Code's teammateMailbox.ts
// Key patterns adopted:
//   - Separate .lock file (teammateMailbox.ts:142)
//   - Corrupt line recovery inside lock (skip and log)
//   - Promise.allSettled for broadcast (resilience per-recipient)
//   - Atomic file writes for the (rare) full-rewrite paths
//
// Storage format: JSONL (one message per line, append-only). Switched from
// JSON-array because read-modify-write of the whole array under contention
// caused n=16 p99 latency = 1259ms (Step 2 baseline). Append-only writes
// drop the per-write cost from O(messages) to O(1) and eliminate the
// `JSON.stringify(all)` serialization cost on the hot path.
//
// Legacy `[ {...}, {...} ]` files are auto-migrated on first write under the
// inbox lock — one-time O(n) rewrite, then all subsequent writes are O(1)
// appends.

import { readFile, writeFile, appendFile, stat } from 'node:fs/promises'
import { getInboxPath, getInboxDir, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeFileAtomic } from './fs-utils.js'
import { errorMessage, isEnoent, isEexist } from './errors.js'
import { runGuardrails } from './guardrails.js'
import { fireHook } from './hooks.js'
import { recordTurn } from './turns.js'
import { enqueueApproval } from './approvals.js'

/**
 * Parse inbox content. Handles both formats:
 *   - JSONL (current): one JSON object per line, blank lines OK
 *   - Legacy JSON array `[ {...}, {...} ]` (auto-migrated on next write)
 * Returns [] on missing or unrecoverable input.
 */
export function parseInboxSafe(content, inboxPath) {
  if (typeof content !== 'string' || content.length === 0) return []
  const trimmed = content.trimStart()
  // Legacy array format
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed)) {
        console.error(`[mailbox] Inbox ${inboxPath} root is not an array, treating as empty`)
        return []
      }
      return parsed
    } catch (e) {
      console.error(`[mailbox] Corrupt legacy JSON in ${inboxPath}: ${errorMessage(e)}, treating as empty`)
      return []
    }
  }
  // JSONL
  const out = []
  const lines = content.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object') out.push(obj)
    } catch (e) {
      console.error(`[mailbox] Skipping corrupt line in ${inboxPath}: ${errorMessage(e)}`)
    }
  }
  return out
}

function serializeJsonl(messages) {
  return messages.map(m => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '')
}

async function readInboxRaw(inboxPath) {
  try {
    return await readFile(inboxPath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return ''
    throw e
  }
}

function isLegacyFormat(raw) {
  return typeof raw === 'string' && raw.trimStart().startsWith('[')
}

/**
 * True if the existing file content cannot be safely appended to.
 * - Empty file: safe (will append cleanly).
 * - Ends with newline: safe (each prior line is its own record).
 * - Anything else: needs a full rewrite to recover.
 */
function needsRewrite(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false
  if (isLegacyFormat(raw)) return true
  return !raw.endsWith('\n')
}

/**
 * Cheaply detect whether the inbox file needs the rare full-rewrite path
 * (legacy JSON-array, or corrupt content not ending with newline).
 *
 * Reads only the first 4 bytes (to spot `[`) and the last byte (to check
 * for `\n`). Avoids slurping the whole file just for the format check on
 * the hot append path. Returns false for missing files (will be created
 * by the appendFile step).
 */
async function needsRewriteFile(inboxPath) {
  let size
  try {
    size = (await stat(inboxPath)).size
  } catch (e) {
    if (isEnoent(e)) return false
    throw e
  }
  if (size === 0) return false
  // Probe first byte for legacy `[` marker.
  const head = await readSlice(inboxPath, 0, 1)
  if (head === '[') return true
  // Probe last byte for newline.
  const tail = await readSlice(inboxPath, Math.max(0, size - 1), 1)
  return tail !== '\n'
}

async function readSlice(path, start, length) {
  const { open } = await import('node:fs/promises')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.slice(0, bytesRead).toString('utf-8')
  } finally {
    await fh.close()
  }
}

export async function readMailbox(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName)
  try {
    const data = await readFile(inboxPath, 'utf-8')
    return parseInboxSafe(data, inboxPath)
  } catch (e) {
    if (isEnoent(e)) return []
    console.error(`[mailbox] Failed to read inbox ${agentName}: ${errorMessage(e)}`)
    return []
  }
}

/**
 * Drop-in helper for code that wants to read+modify+rewrite an inbox under
 * lock (mark-read, pop, etc.). Handles legacy → JSONL migration transparently.
 */
async function readMessagesUnderLock(inboxPath) {
  const raw = await readInboxRaw(inboxPath)
  return parseInboxSafe(raw, inboxPath)
}

export async function readUnreadMessages(teamName, agentName) {
  const messages = await readMailbox(teamName, agentName)
  const unread = messages.filter(m => m && !m.read)

  // Apply output guardrails to each message. Tripped messages are replaced
  // with a notice; rewritten messages are passed through.
  const out = []
  for (const m of unread) {
    const guard = await runGuardrails(teamName, 'output', m)
    if (guard.tripwire) {
      out.push({
        ...m,
        text: `[message blocked by output guardrail: ${guard.reason}]`,
        summary: 'guardrail-blocked',
      })
    } else {
      out.push(guard.message)
    }
  }
  return out
}

export async function writeToMailbox(teamName, recipientName, message, opts = {}) {
  // HITL — if the message is flagged requires_approval, enqueue it instead
  // of delivering. team-lead resolves it via team_approve_message /
  // team_reject_message. opts.skipApproval bypasses this path (used when
  // the approver finalizes delivery).
  if (message.requires_approval && !opts.skipApproval) {
    const record = await enqueueApproval({
      teamName, from: message.from, to: recipientName,
      kind: opts.approvalKind || 'message',
      message, metadata: opts.approvalMetadata || null,
    })
    // Notify team-lead that an approval is pending. Infinite-loop-safe
    // because we pass skipApproval=true on the recursive call.
    if (recipientName !== 'team-lead') {
      await writeToMailbox(teamName, 'team-lead', {
        from: 'approval-queue',
        text: `Pending approval ${record.id}: ${message.from} → ${recipientName}\n\n${message.text}`,
        summary: `approval pending (${record.id})`,
      }, { skipApproval: true, skipGuardrails: true, skipTurns: true })
    }
    return { blocked: false, pending_approval_id: record.id }
  }

  // max_turns — increment sender counter; if over limit, block and notify
  // team-lead. opts.skipTurns bypasses (used by system-generated notices).
  if (!opts.skipTurns && message.from && message.from !== 'team-lead') {
    const turn = await recordTurn(teamName, message.from)
    if (turn.over_limit) {
      if (recipientName !== 'team-lead') {
        await writeToMailbox(teamName, 'team-lead', {
          from: 'turn-limiter',
          text: `${message.from} exceeded turn limit (${turn.count}/${turn.limit}). Message to ${recipientName} blocked.\n\nOriginal:\n${message.text}`,
          summary: `turn limit exceeded: ${message.from}`,
        }, { skipTurns: true, skipGuardrails: true, skipApproval: true })
      }
      return { blocked: true, reason: `turn limit exceeded (${turn.count}/${turn.limit})`, turn }
    }
  }

  // Input guardrail — may block, rewrite, or redirect the message.
  // opts.skipGuardrails=true bypasses the input check (used by redirect notices
  // so they don't get blocked by the same rule that caused the redirect).
  let effectiveMessage = message
  if (!opts.skipGuardrails) {
    const guard = await runGuardrails(teamName, 'input', message)
    if (guard.tripwire) {
      const redirectTo = guard.redirect_to
      if (redirectTo && redirectTo !== recipientName) {
        const notice = {
          from: 'guardrail',
          text: `Blocked message from ${message.from} to ${recipientName}: ${guard.reason}\n\n---\nOriginal:\n${message.text}`,
          summary: `guardrail tripped (${guard.reason})`,
        }
        return await writeToMailbox(teamName, redirectTo, notice, { skipGuardrails: true })
      }
      return { blocked: true, reason: guard.reason }
    }
    effectiveMessage = guard.message
  }

  // If a guardrail (e.g. auto_require_approval) flagged the message for
  // human review, route it through the approval queue now. We re-enter the
  // approval branch above with skipGuardrails to avoid double evaluation.
  if (effectiveMessage.requires_approval && !opts.skipApproval) {
    const approvalKind = effectiveMessage._auto_approval_kind || opts.approvalKind || 'message'
    const reason = effectiveMessage._auto_approval_reason || null
    const cleanMsg = { ...effectiveMessage }
    delete cleanMsg._auto_approval_reason
    delete cleanMsg._auto_approval_kind
    const record = await enqueueApproval({
      teamName, from: cleanMsg.from, to: recipientName,
      kind: approvalKind, message: cleanMsg,
      metadata: reason ? { auto_approval_reason: reason } : null,
    })
    if (recipientName !== 'team-lead') {
      const noticeText = reason
        ? `Pending approval ${record.id}: ${cleanMsg.from} → ${recipientName}\nReason: ${reason}\n\n${cleanMsg.text}`
        : `Pending approval ${record.id}: ${cleanMsg.from} → ${recipientName}\n\n${cleanMsg.text}`
      await writeToMailbox(teamName, 'team-lead', {
        from: 'approval-queue',
        text: noticeText,
        summary: `approval pending (${record.id})`,
      }, { skipApproval: true, skipGuardrails: true, skipTurns: true })
    }
    return { blocked: false, pending_approval_id: record.id, auto_approval: true, reason }
  }

  const inboxPath = getInboxPath(teamName, recipientName)
  const lockFilePath = `${inboxPath}.lock`
  await ensureDir(getInboxDir(teamName))

  // Ensure inbox file exists (empty file = empty JSONL, legal)
  try {
    await writeFile(inboxPath, '', { flag: 'wx' })
  } catch (e) {
    if (!isEexist(e)) throw e
  }

  const newMsg = {
    from: effectiveMessage.from,
    text: effectiveMessage.text,
    timestamp: new Date().toISOString(),
    read: false,
    ...(effectiveMessage.color ? { color: effectiveMessage.color } : {}),
    ...(effectiveMessage.summary ? { summary: effectiveMessage.summary } : {}),
    ...(effectiveMessage.request_id ? { request_id: effectiveMessage.request_id } : {}),
    ...(effectiveMessage.in_reply_to ? { in_reply_to: effectiveMessage.in_reply_to } : {}),
    ...(effectiveMessage.orchestrator_session_id
      ? { orchestrator_session_id: effectiveMessage.orchestrator_session_id }
      : {}),
  }

  // Append under the inbox lock. O_APPEND makes a single appendFile atomic
  // against *other appends*, but it does NOT protect against a concurrent
  // whole-file replacement: markMessagesAsRead (and the rewrite branch below)
  // read the inbox, mutate it, and writeFileAtomic(tmp → rename) over it. An
  // append that lands between such a reader's read and its rename is silently
  // clobbered when the rename swaps in a file snapshot taken before the
  // append — the message is lost. Taking the same lock here serializes the
  // append against those rewrites so no write can vanish. (This trades the
  // former lock-free append throughput for correctness; proper-lockfile's
  // retry budget absorbs the writer contention.)
  //
  // The cheap byte-probe (`needsRewriteFile`) stays the common path: only the
  // rare legacy / corrupt inbox pays the O(n) full read + rewrite.
  const lineToAppend = JSON.stringify(newMsg) + '\n'
  await withLock(inboxPath, async () => {
    if (await needsRewriteFile(inboxPath)) {
      const raw = await readInboxRaw(inboxPath)
      if (needsRewrite(raw)) {
        const existing = parseInboxSafe(raw, inboxPath)
        existing.push(newMsg)
        await writeFileAtomic(inboxPath, serializeJsonl(existing))
        return
      }
    }
    await appendFile(inboxPath, lineToAppend)
  }, { lockfilePath: lockFilePath })

  await fireHook('on_message', {
    team: teamName,
    to: recipientName,
    from: effectiveMessage.from,
    message: effectiveMessage,
  })

  return { blocked: false }
}

export async function markMessagesAsRead(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName)
  const lockFilePath = `${inboxPath}.lock`

  try {
    await withLock(inboxPath, async () => {
      const messages = await readMessagesUnderLock(inboxPath)
      if (messages.length === 0) return
      let changed = false
      for (const m of messages) {
        if (m && !m.read) {
          m.read = true
          changed = true
        }
      }
      if (changed) {
        await writeFileAtomic(inboxPath, serializeJsonl(messages))
      }
    }, { lockfilePath: lockFilePath })
  } catch (e) {
    if (isEnoent(e)) return
    throw e
  }
}

/**
 * Broadcast to all team members except sender.
 * Uses Promise.allSettled so one failed delivery doesn't block others.
 */
export async function broadcastMessage(teamName, senderName, text, summary, members, options = {}) {
  const recipients = members.filter(m => m.name !== senderName)
  const senderColor = members.find(m => m.name === senderName)?.color
  const orchestratorSessionId = options.orchestrator_session_id
  const requiresApproval = options.requires_approval

  const results = await Promise.allSettled(
    recipients.map(member =>
      writeToMailbox(teamName, member.name, {
        from: senderName,
        text,
        summary,
        color: senderColor,
        ...(requiresApproval ? { requires_approval: true } : {}),
        ...(orchestratorSessionId ? { orchestrator_session_id: orchestratorSessionId } : {}),
      })
    )
  )

  const delivered = []
  const pending = []
  const failed = []
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      if (result.value?.pending_approval_id) {
        pending.push({ to: recipients[i].name, approval_id: result.value.pending_approval_id })
      } else if (result.value?.blocked) {
        failed.push(recipients[i].name)
      } else {
        delivered.push(recipients[i].name)
      }
    } else {
      console.error(`[mailbox] Broadcast to ${recipients[i].name} failed: ${errorMessage(result.reason)}`)
      failed.push(recipients[i].name)
    }
  })

  return { delivered, pending, failed }
}

export async function clearMailbox(teamName, agentName) {
  const inboxPath = getInboxPath(teamName, agentName)
  const lockFilePath = `${inboxPath}.lock`
  try {
    // Truncate under the lock so a concurrent append can't be interleaved
    // with (and lost to) the clear, matching writeToMailbox/markMessagesAsRead.
    await withLock(inboxPath, async () => {
      await writeFile(inboxPath, '')
    }, { lockfilePath: lockFilePath })
  } catch (e) {
    if (isEnoent(e)) return
    throw e
  }
}
