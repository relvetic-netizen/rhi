// S3b-E — 24h TTL fake-clock fallback for HITL pending approvals.
// Date.now() is read via the `now` argument so tests can advance time
// deterministically (impl plan §4.3). Wave 1 minimal: in-memory + on-disk
// approvals.json sweep; persistence of in-flight request graph deferred to
// Wave 2 (handoff DON'T 32, OQ6).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  enqueueApproval,
  listApprovals,
  listApprovalsWithLazySweep,
  isApprovalExpired,
  expirePendingApprovals,
  APPROVAL_TTL_MS,
  decide,
} from '../approvals.js'
import { createTeam } from '../team.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-approval-ttl__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-approval-ttl')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  await createTeam(TEST_TEAM, [
    { name: 'alice', role: 'worker' },
    { name: 'bob', role: 'worker' },
  ], 'test')
})

describe('isApprovalExpired (pure boundary check)', () => {
  it('APPROVAL_TTL_MS is 24h', () => {
    assert.equal(APPROVAL_TTL_MS, 24 * 60 * 60 * 1000)
  })

  it('returns false for non-pending approvals', () => {
    const created = new Date('2026-05-09T00:00:00Z').toISOString()
    const now = Date.parse('2026-05-15T00:00:00Z')
    assert.equal(isApprovalExpired({ status: 'approved', createdAt: created }, { now }), false)
    assert.equal(isApprovalExpired({ status: 'rejected', createdAt: created }, { now }), false)
  })

  it('returns false at TTL - 1ms (boundary)', () => {
    const createdAtMs = Date.parse('2026-05-01T00:00:00Z')
    const now = createdAtMs + APPROVAL_TTL_MS - 1
    assert.equal(
      isApprovalExpired({
        status: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
      }, { now }),
      false,
    )
  })

  it('returns false at exactly TTL (boundary)', () => {
    const createdAtMs = Date.parse('2026-05-01T00:00:00Z')
    const now = createdAtMs + APPROVAL_TTL_MS
    assert.equal(
      isApprovalExpired({
        status: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
      }, { now }),
      false,
      'strictly greater than (>) TTL is the contract — exactly 24h is still pending',
    )
  })

  it('returns true at TTL + 1ms (boundary)', () => {
    const createdAtMs = Date.parse('2026-05-01T00:00:00Z')
    const now = createdAtMs + APPROVAL_TTL_MS + 1
    assert.equal(
      isApprovalExpired({
        status: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
      }, { now }),
      true,
    )
  })

  it('returns false on missing createdAt', () => {
    assert.equal(isApprovalExpired({ status: 'pending' }, { now: Date.now() }), false)
  })

  it('returns false on unparseable createdAt', () => {
    assert.equal(
      isApprovalExpired({ status: 'pending', createdAt: 'not-a-date' }, { now: Date.now() }),
      false,
    )
  })

  it('returns false for null/undefined approval', () => {
    assert.equal(isApprovalExpired(null, { now: Date.now() }), false)
    assert.equal(isApprovalExpired(undefined, { now: Date.now() }), false)
  })

  it('respects custom ttlMs argument (shorter)', () => {
    const createdAtMs = Date.parse('2026-05-01T00:00:00Z')
    const now = createdAtMs + 10_000 // 10 seconds later
    assert.equal(
      isApprovalExpired({
        status: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
      }, { now, ttlMs: 5_000 }),
      true,
    )
  })

  it('respects custom ttlMs argument (longer)', () => {
    const createdAtMs = Date.parse('2026-05-01T00:00:00Z')
    const now = createdAtMs + 10_000
    assert.equal(
      isApprovalExpired({
        status: 'pending',
        createdAt: new Date(createdAtMs).toISOString(),
      }, { now, ttlMs: 30_000 }),
      false,
    )
  })
})

describe('expirePendingApprovals — fake-clock sweep', () => {
  it('returns empty array when no approvals exist', async () => {
    const result = await expirePendingApprovals(TEST_TEAM, { now: Date.now() })
    assert.deepEqual(result, [])
  })

  it('does not expire fresh pending approvals (now < createdAt + 24h)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + 1000 // 1 second later
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.deepEqual(expired, [])
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
  })

  it('expires pending approvals older than 24h with autonomous_fallback marker', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(expired.length, 1)
    assert.equal(expired[0].id, r.id)
    assert.equal(expired[0].status, 'rejected')
    assert.equal(expired[0].fallback, 'autonomous')
    assert.equal(expired[0].reason, 'ttl_exceeded_autonomous_fallback')
    assert.equal(expired[0].approver, '__autonomous_ttl_fallback__')
    assert.equal(expired[0].decidedAt, new Date(now).toISOString())
  })

  it('persists expired status to disk (survives reload)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    await expirePendingApprovals(TEST_TEAM, { now })
    const all = await listApprovals(TEST_TEAM, { status: 'all' })
    assert.equal(all.length, 1)
    assert.equal(all[0].status, 'rejected')
    assert.equal(all[0].fallback, 'autonomous')
  })

  it('does not touch already-decided approvals', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    await decide(TEST_TEAM, r.id, 'approved', { approver: 'team-lead' })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS * 10
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.deepEqual(expired, [])
    const all = await listApprovals(TEST_TEAM, { status: 'all' })
    assert.equal(all[0].status, 'approved')
  })

  it('expires only old pending records, leaves fresh ones untouched (mixed batch)', async () => {
    // Enqueue two approvals (real wall-clock timestamps are ~ms apart).
    const old1 = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'old', from: 'alice' },
    })
    const fresh = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'fresh', from: 'alice' },
    })
    // Set `now` to a point where old1 has expired (>TTL since old1.createdAt)
    // but fresh has not (<TTL since fresh.createdAt). To make this work
    // deterministically, use a short ttlMs so a small ms gap puts them on
    // opposite sides of the boundary.
    const old1Ms = Date.parse(old1.createdAt)
    const freshMs = Date.parse(fresh.createdAt)
    assert.ok(freshMs >= old1Ms, 'second enqueue must have createdAt >= first')
    // ttl = (freshMs - old1Ms) / 2; pick now so old1 is expired, fresh is not.
    const gap = freshMs - old1Ms
    if (gap === 0) {
      // Wall-clock granularity gave both the same ms. Skip the boundary
      // assertion (test environment-dependent) but still verify the sweep
      // doesn't crash.
      const expired = await expirePendingApprovals(TEST_TEAM, { now: old1Ms + 10, ttlMs: 5 })
      assert.equal(expired.length, 2, 'both expire when both are older than ttl')
      return
    }
    const ttlMs = Math.max(1, gap - 1)
    const nowAt = old1Ms + ttlMs + 1 // old1 expired; fresh might or might not be
    const expired = await expirePendingApprovals(TEST_TEAM, { now: nowAt, ttlMs })
    assert.equal(expired.length, 1)
    assert.equal(expired[0].id, old1.id)
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].id, fresh.id)
  })

  it('idempotent: second sweep at same now returns empty', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    const first = await expirePendingApprovals(TEST_TEAM, { now })
    const second = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(first.length, 1)
    assert.deepEqual(second, [])
  })

  it('respects custom ttlMs (short TTL for testing)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + 10_000
    const expired = await expirePendingApprovals(TEST_TEAM, { now, ttlMs: 5_000 })
    assert.equal(expired.length, 1)
  })

  it('does not write file when nothing expires (avoids spurious mtime bump)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const before = await readFile(
      join(TMP, 'teams', TEST_TEAM, 'approvals.json'),
      'utf-8',
    )
    const now = Date.parse(r.createdAt) + 1000 // not expired
    await expirePendingApprovals(TEST_TEAM, { now })
    const after = await readFile(
      join(TMP, 'teams', TEST_TEAM, 'approvals.json'),
      'utf-8',
    )
    assert.equal(before, after, 'no-op sweep must not modify file')
  })

  it('TTL boundary at exact 24h still pending', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS // exactly 24h
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.deepEqual(expired, [], 'exactly 24h must not expire (>, not >=)')
  })

  it('TTL boundary at 24h + 1ms expires', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(expired.length, 1)
  })

  it('expired record carries autonomous fallback marker (consumer can detect)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    const rec = expired[0]
    // Consumer (autonomous worker) sees:
    //   status: rejected → "human did not approve"
    //   fallback: autonomous → "but this rejection was the system's TTL fallback, not a human decision"
    //   reason: ttl_exceeded_autonomous_fallback
    assert.equal(rec.status, 'rejected')
    assert.equal(rec.fallback, 'autonomous')
    assert.equal(rec.reason, 'ttl_exceeded_autonomous_fallback')
  })

  it('decidedAt is stamped from `now` (not real wall clock)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse('2030-01-01T00:00:00Z')
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(expired[0].decidedAt, new Date(now).toISOString())
  })

  it('default now is real Date.now() (production path)', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    // Without explicit `now`, the default reads Date.now() — fresh approval
    // must NOT expire.
    const expired = await expirePendingApprovals(TEST_TEAM)
    assert.deepEqual(expired, [])
  })

  it('approver field documents that this was a system fallback', async () => {
    const r = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'hi', from: 'alice' },
    })
    const now = Date.parse(r.createdAt) + APPROVAL_TTL_MS + 1
    const expired = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(expired[0].approver, '__autonomous_ttl_fallback__')
  })

  it('multiple parallel sweeps with same now produce consistent count', async () => {
    // Enqueue 5 approvals
    const records = await Promise.all([1, 2, 3, 4, 5].map(i => enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: `m${i}`, from: 'alice' },
    })))
    const now = Date.parse(records[0].createdAt) + APPROVAL_TTL_MS + 100
    // Sweep twice in series (we can't trivially run in parallel because they
    // share an exclusive file lock; serial under same now is the contract).
    const first = await expirePendingApprovals(TEST_TEAM, { now })
    const second = await expirePendingApprovals(TEST_TEAM, { now })
    assert.equal(first.length, 5)
    assert.equal(second.length, 0)
  })

  it('team_list_approvals lazy path expires old pending approvals before listing', async () => {
    const record = await enqueueApproval({
      teamName: TEST_TEAM, from: 'alice', to: 'bob', kind: 'message',
      message: { text: 'stale approval', from: 'alice' },
    })
    const realNow = Date.now
    Date.now = () => Date.parse(record.createdAt) + APPROVAL_TTL_MS + 1
    try {
      const pending = await listApprovalsWithLazySweep(TEST_TEAM, { status: 'pending' })
      assert.deepEqual(pending, [])

      const all = await listApprovals(TEST_TEAM, { status: 'all' })
      assert.equal(all.length, 1)
      assert.equal(all[0].status, 'rejected')
      assert.equal(all[0].reason, 'ttl_exceeded_autonomous_fallback')
    } finally {
      Date.now = realNow
    }
  })
})
