// W2-S3 (Sprint 3) — cross-team boundary admission gate.
//   evaluateCrossTeamAdmission runs S3-H → S3-G → S3-D → S3-B in order.
//   This file exercises S3-B (autonomous target HITL deny) and the in-team
//   short circuit; cycle detection (S3-D), target-down fallback (S3-G),
//   and broadcast deny (S3-H) live in their dedicated test files.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateCrossTeamAdmission,
  CROSS_TEAM_GRACE_MS,
} from '../admission.js'

describe('evaluateCrossTeamAdmission — in-team short circuit', () => {
  it('returns in_team:true when both teams are null', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: null,
      source_agent: 'alice',
      target_team: null,
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })

  it('returns in_team:true when source_team === target_team', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-x',
      source_agent: 'alice',
      target_team: 'team-x',
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })

  it('returns in_team:true when only source_team is null (target null treated as in-team)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: null,
      source_agent: 'alice',
      target_team: 'team-y',
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })

  it('returns in_team:true when only target_team is null', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-x',
      source_agent: 'alice',
      target_team: null,
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })
})

describe('evaluateCrossTeamAdmission — cross-team allow path', () => {
  it('allows when no rule fires (different teams, requires_approval=false)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      requires_approval: false,
      ledger_chain: [],
      started_at_ms: Date.now(),
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('allows requires_approval=true when target_mode is null (no autonomy marker)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      requires_approval: true,
      target_mode: null,
      ledger_chain: [],
      started_at_ms: Date.now(),
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('allows requires_approval=true when target_mode = "hitl"', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      requires_approval: true,
      target_mode: 'hitl',
      ledger_chain: [],
      started_at_ms: Date.now(),
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })
})

describe('evaluateCrossTeamAdmission — S3-B autonomous target HITL deny (D-W2-3)', () => {
  it('denies when target_mode=autonomous AND requires_approval=true', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-auto',
      target_agent: 'auto-1',
      requires_approval: true,
      target_mode: 'autonomous',
      ledger_chain: [],
      started_at_ms: Date.now(),
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_autonomous_hitl_denied')
    assert.ok(r.fallback)
    assert.equal(r.fallback.error, 'HITL_ADMISSION_DENIED')
    assert.equal(r.fallback.fallback, 'deferred')
    assert.equal(r.fallback.taskId, 'auto-1')
    assert.equal(r.fallback.source, 'cross_team_admission')
    assert.equal(r.audit?.rule, 'D-W2-3')
  })

  it('does NOT deny when target_mode=autonomous but requires_approval=false', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-auto',
      target_agent: 'auto-1',
      requires_approval: false,
      target_mode: 'autonomous',
      ledger_chain: [],
      started_at_ms: Date.now(),
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('passes through originalRequest into the fallback envelope', () => {
    const orig = { kind: 'team_send_message', text: 'please approve' }
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-auto',
      target_agent: 'auto-1',
      requires_approval: true,
      target_mode: 'autonomous',
      ledger_chain: [],
      started_at_ms: Date.now(),
      originalRequest: orig,
    })
    assert.equal(r.allow, false)
    assert.deepEqual(r.fallback.originalRequest, orig)
  })
})

describe('evaluateCrossTeamAdmission — input shape edge cases', () => {
  it('treats undefined target_team as in-team (matches null handling)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })

  it('coerces non-string source_team to string for comparison', () => {
    // Defensive: caller might pass a number from JSON. The String() coercion
    // ensures cross-team detection still works.
    const r = evaluateCrossTeamAdmission({
      source_team: 42,
      source_agent: 'a',
      target_team: 42,
      target_agent: 'b',
    })
    // Numeric 42 === 42 → in-team after normalization.
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })

  it('returns audit-bearing deny envelope (not a plain Error)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'a',
      target_team: '*',
      target_agent: null,
    })
    assert.equal(typeof r.audit, 'object')
    assert.notEqual(r.audit, null)
  })

  it('omitting all args returns in-team allow (defensive default)', () => {
    const r = evaluateCrossTeamAdmission()
    assert.equal(r.allow, true)
    assert.equal(r.in_team, true)
  })
})

describe('evaluateCrossTeamAdmission — autonomous fallback details', () => {
  it('fallback envelope keeps the correct shape across multiple denies', () => {
    for (let i = 0; i < 5; i += 1) {
      const r = evaluateCrossTeamAdmission({
        source_team: 'team-a',
        source_agent: 'alice',
        target_team: 'team-auto',
        target_agent: `auto-${i}`,
        requires_approval: true,
        target_mode: 'autonomous',
      })
      assert.equal(r.allow, false)
      assert.equal(r.fallback.taskId, `auto-${i}`)
      assert.equal(r.fallback.error, 'HITL_ADMISSION_DENIED')
    }
  })

  it('null target_agent results in null taskId in fallback (no synthesis)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-auto',
      target_agent: null,
      requires_approval: true,
      target_mode: 'autonomous',
    })
    assert.equal(r.allow, false)
    assert.equal(r.fallback.taskId, null)
  })

  it('passes through originalRequest verbatim (no truncation)', () => {
    const big = { kind: 'long', body: 'x'.repeat(10_000) }
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-auto',
      target_agent: 'auto-1',
      requires_approval: true,
      target_mode: 'autonomous',
      originalRequest: big,
    })
    assert.equal(r.fallback.originalRequest.body.length, 10_000)
  })
})

describe('evaluateCrossTeamAdmission — gate ordering invariants', () => {
  it('S3-H broadcast deny short-circuits before S3-G even when started_at_ms is past deadline', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
      started_at_ms: Date.now() - CROSS_TEAM_GRACE_MS - 60_000,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
  })

  it('S3-G target-down deadline short-circuits before S3-D cycle deny', () => {
    // Build a ledger_chain that would form a cycle so we can confirm S3-G
    // wins despite the cycle being present.
    const chain = [{
      request_id: 'req-prev',
      source_team: 'team-b',
      source_agent: 'bob',
      target_team: 'team-a',
      target_agent: 'alice',
      started_at: new Date().toISOString(),
      status: 'pending',
    }]
    const now = Date.now()
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      ledger_chain: chain,
      started_at_ms: now - CROSS_TEAM_GRACE_MS - 60_000,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
  })

  it('S3-D cycle deny short-circuits before S3-B autonomous deny', () => {
    const chain = [{
      request_id: 'req-prev',
      source_team: 'team-b',
      source_agent: 'bob',
      target_team: 'team-a',
      target_agent: 'alice',
      started_at: new Date().toISOString(),
      status: 'pending',
    }]
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      ledger_chain: chain,
      started_at_ms: Date.now(),
      requires_approval: true,
      target_mode: 'autonomous',
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_cycle')
  })
})
