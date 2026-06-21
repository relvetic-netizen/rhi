// Human-in-the-Loop approval queue — inspired by OpenAI Agents SDK
// tool-level `needs_approval=True`. Messages flagged requires_approval=true
// are NOT delivered to the recipient inbox. Instead they land in a pending
// queue; team-lead (or any designated approver) calls team_approve_message
// or team_reject_message to resolve them.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getTeamDir, ensureDir } from './paths.js'
import { withLock } from './lockfile.js'
import { writeFileAtomic } from './fs-utils.js'
import { errorMessage, isEnoent } from './errors.js'

function approvalsPath(teamName) {
  return join(getTeamDir(teamName), 'approvals.json')
}

async function readAll(teamName) {
  try {
    const raw = await readFile(approvalsPath(teamName), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    if (isEnoent(e)) return []
    console.error(`[approvals] Failed to read: ${errorMessage(e)}`)
    return []
  }
}

/**
 * Enqueue a pending approval. Returns the created record (with auto-id).
 *
 * @param {object} args
 * @param {string} args.teamName
 * @param {string} args.from
 * @param {string} args.to           — final recipient if approved
 * @param {string} args.kind         — 'message' | 'handoff'
 * @param {object} args.message      — message payload (full object)
 * @param {object} [args.metadata]   — handoff reason, task_id, etc.
 */
export async function enqueueApproval({ teamName, from, to, kind, message, metadata }) {
  const path = approvalsPath(teamName)
  await ensureDir(getTeamDir(teamName))

  const record = {
    id: `ap_${randomBytes(6).toString('hex')}`,
    createdAt: new Date().toISOString(),
    from, to, kind, message, metadata: metadata || null,
    status: 'pending',
    approver: null,
    reason: null,
    decidedAt: null,
  }

  await withLock(path, async () => {
    const all = await readAll(teamName)
    all.push(record)
    await writeFileAtomic(path, JSON.stringify(all, null, 2))
  }, { lockfilePath: `${path}.lock` })

  return record
}

export async function listApprovals(teamName, { status = 'pending' } = {}) {
  const all = await readAll(teamName)
  if (status === 'all') return all
  return all.filter(a => a.status === status)
}

export async function listApprovalsWithLazySweep(teamName, { status = 'pending' } = {}) {
  await expirePendingApprovals(teamName)
  return listApprovals(teamName, { status })
}

export async function getApproval(teamName, approvalId) {
  const all = await readAll(teamName)
  return all.find(a => a.id === approvalId) || null
}

/**
 * Mark an approval as approved or rejected. Atomic under the file lock.
 * Returns the updated record, or null if not found / already decided.
 */
export async function decide(teamName, approvalId, decision, { approver, reason } = {}) {
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error(`Invalid decision: ${decision}`)
  }
  const path = approvalsPath(teamName)
  let updated = null
  await withLock(path, async () => {
    const all = await readAll(teamName)
    const idx = all.findIndex(a => a.id === approvalId)
    if (idx < 0) return
    if (all[idx].status !== 'pending') return
    all[idx].status = decision
    all[idx].approver = approver || null
    all[idx].reason = reason || null
    all[idx].decidedAt = new Date().toISOString()
    updated = all[idx]
    await writeFileAtomic(path, JSON.stringify(all, null, 2))
  }, { lockfilePath: `${path}.lock` })
  return updated
}

// Sprint 3b S3b-E — autonomous fallback for long-pending approvals.
// Without TTL, an autonomous worker that called requires_approval=true and
// then crashed (or whose human reviewer never showed up) would leave the
// approval queue growing forever (R12b). The TTL fallback resolves a
// pending approval with `decided=rejected, reason=ttl_exceeded_autonomous_fallback`
// after 24h. Date.now() is read via the `now` argument so fake-clock tests
// can advance time deterministically (impl plan §4.3).
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

export function isApprovalExpired(approval, { now = Date.now(), ttlMs = APPROVAL_TTL_MS } = {}) {
  if (!approval || approval.status !== 'pending') return false
  if (typeof approval.createdAt !== 'string') return false
  const createdAtMs = Date.parse(approval.createdAt)
  if (!Number.isFinite(createdAtMs)) return false
  return (now - createdAtMs) > ttlMs
}

/**
 * Sweep pending approvals older than `ttlMs` and resolve them with the
 * autonomous fallback. Returns the list of newly fallback-resolved records.
 *
 * Wave 1 minimal: in-place rejection with reason='ttl_exceeded' so the
 * sender (autonomous worker) sees a concrete decision instead of an
 * indefinite pending state. Persistence of the in-flight request graph is
 * deferred to Wave 2 (handoff DON'T 32, OQ6).
 */
export async function expirePendingApprovals(
  teamName,
  { now = Date.now(), ttlMs = APPROVAL_TTL_MS } = {},
) {
  const path = approvalsPath(teamName)
  const expired = []
  await withLock(path, async () => {
    const all = await readAll(teamName)
    let mutated = false
    for (let i = 0; i < all.length; i++) {
      if (isApprovalExpired(all[i], { now, ttlMs })) {
        all[i].status = 'rejected'
        all[i].approver = '__autonomous_ttl_fallback__'
        all[i].reason = 'ttl_exceeded_autonomous_fallback'
        all[i].decidedAt = new Date(now).toISOString()
        all[i].fallback = 'autonomous'
        expired.push(all[i])
        mutated = true
      }
    }
    if (mutated) {
      await writeFileAtomic(path, JSON.stringify(all, null, 2))
    }
  }, { lockfilePath: `${path}.lock` })
  return expired
}

/**
 * Remove decided (approved/rejected) approvals older than `olderThanMs`.
 * Pending approvals are never pruned regardless of age. Safe to call
 * periodically or on-demand.
 *
 * Returns the number of records removed.
 */
export async function pruneApprovals(teamName, olderThanMs = 7 * 24 * 60 * 60 * 1000) {
  const path = approvalsPath(teamName)
  const cutoff = Date.now() - olderThanMs
  let removed = 0
  await withLock(path, async () => {
    const all = await readAll(teamName)
    const kept = all.filter(a => {
      if (a.status === 'pending') return true
      const decidedTs = a.decidedAt ? Date.parse(a.decidedAt) : 0
      const keep = decidedTs > cutoff
      if (!keep) removed++
      return keep
    })
    if (removed > 0) {
      await writeFileAtomic(path, JSON.stringify(kept, null, 2))
    }
  }, { lockfilePath: `${path}.lock` })
  return removed
}
