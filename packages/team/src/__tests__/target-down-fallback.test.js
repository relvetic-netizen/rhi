// W2-S3 (Sprint 3) S3-G — cross-team target-down 24h TTL fallback (R-W2-2).
//   Even when the target team is live, the 24h grace window force-releases
//   the source side so it never blocks indefinitely. Fake-clock test:
//   feed `now_ms` and `started_at_ms` directly to evaluateCrossTeamAdmission
//   to simulate elapsed time without sleeping.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateCrossTeamAdmission,
  CROSS_TEAM_GRACE_MS,
} from '../admission.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

describe('CROSS_TEAM_GRACE_MS constant (24h)', () => {
  it('is exactly 24 hours in ms', () => {
    assert.equal(CROSS_TEAM_GRACE_MS, DAY_MS)
  })
})

describe('evaluateCrossTeamAdmission — S3-G target-down fallback within grace', () => {
  it('allows when started_at_ms is now (no elapsed time)', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now,
      now_ms: now,
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('allows when elapsed = 1h (well within 24h grace)', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - HOUR_MS,
      now_ms: now,
    })
    assert.equal(r.allow, true)
  })

  it('allows when elapsed = 23h 59m 59s (just under deadline)', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - (DAY_MS - 1000),
      now_ms: now,
    })
    assert.equal(r.allow, true)
  })

  it('allows when elapsed = 24h 0m 0s (boundary, NOT yet > grace)', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - DAY_MS,
      now_ms: now,
    })
    // strict >: equal should still allow.
    assert.equal(r.allow, true)
  })
})

describe('evaluateCrossTeamAdmission — S3-G target-down fallback past deadline', () => {
  it('denies with reason cross_team_target_down_timeout when elapsed > 24h', () => {
    const now = 1_700_000_000_000
    const elapsed = DAY_MS + 60_000 // 24h 1m
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - elapsed,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
    assert.equal(r.deadline_ms, now - elapsed + DAY_MS)
    assert.equal(r.elapsed_ms, elapsed)
    assert.equal(r.grace_ms, DAY_MS)
    assert.equal(r.audit?.rule, 'R-W2-2')
  })

  it('denies even if target is live (deadline is unconditional, not health-based)', () => {
    const now = Date.now()
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - DAY_MS - HOUR_MS,
      now_ms: now,
      // target_mode null = no autonomy, target is "live" by default
      target_mode: 'hitl',
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
  })

  it('audit metadata captures source/target identities and timestamps', () => {
    const now = 1_700_000_000_000
    const startedAt = now - DAY_MS - 100
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: startedAt,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.audit?.source_team, 'team-a')
    assert.equal(r.audit?.source_agent, 'alice')
    assert.equal(r.audit?.target_team, 'team-b')
    assert.equal(r.audit?.target_agent, 'bob')
    assert.equal(r.audit?.started_at_ms, startedAt)
    assert.equal(r.audit?.now_ms, now)
  })
})

describe('evaluateCrossTeamAdmission — S3-G grace_ms override', () => {
  it('respects custom grace_ms (e.g. 1h for testing)', () => {
    const now = 1_700_000_000_000
    const customGrace = HOUR_MS
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - HOUR_MS - 60_000,
      now_ms: now,
      grace_ms: customGrace,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
    assert.equal(r.grace_ms, customGrace)
  })

  it('accepts within custom grace_ms', () => {
    const now = 1_700_000_000_000
    const customGrace = 10 * HOUR_MS
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - HOUR_MS,
      now_ms: now,
      grace_ms: customGrace,
    })
    assert.equal(r.allow, true)
  })
})

describe('evaluateCrossTeamAdmission — S3-G boundary timing', () => {
  it('exactly 24h + 1ms past start: just over boundary → deny', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - DAY_MS - 1,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
  })

  it('strict inequality: elapsed === grace_ms exactly → allow', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - DAY_MS,
      now_ms: now,
    })
    assert.equal(r.allow, true)
  })

  it('grace_ms=0 means immediate timeout for any pending request', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - 1,
      now_ms: now,
      grace_ms: 0,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_target_down_timeout')
  })

  it('48h elapsed with 24h grace → deny with elapsed_ms reflecting actual lag', () => {
    const now = 1_700_000_000_000
    const elapsed = 2 * DAY_MS
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now - elapsed,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.elapsed_ms, elapsed)
  })

  it('future started_at_ms (clock skew) does NOT fire deadline', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: now + 60_000, // started 1 min in the future (clock skew)
      now_ms: now,
    })
    // now_ms - started_at_ms is negative; never > grace_ms.
    assert.equal(r.allow, true)
  })
})

describe('evaluateCrossTeamAdmission — S3-G no started_at_ms', () => {
  it('skips deadline check when started_at_ms is null', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: null,
      now_ms: Date.now(),
    })
    assert.equal(r.allow, true)
  })

  it('skips deadline check when started_at_ms is omitted entirely', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      now_ms: Date.now(),
    })
    assert.equal(r.allow, true)
  })

  it('skips deadline check when started_at_ms is NaN (Number.isFinite guard)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
      started_at_ms: Number.NaN,
      now_ms: Date.now(),
    })
    assert.equal(r.allow, true)
  })
})
