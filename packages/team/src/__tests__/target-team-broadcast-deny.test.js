// W2-S3 (Sprint 3) S3-H — target_team='*' explicit broadcast deny.
//   W2-DONT-7: cross-team broadcast is forbidden in Wave 2; Wave 3 may
//   re-enable it. The schema layer accepts target_team='*' (see
//   handoff-schema cross-team test) so callers can author such manifests
//   for inspection, but the admission gate must always reject.
//
// In-team `to: "*"` (regular team_send_message broadcast) is unaffected —
// it never reaches this gate because source_team === target_team is the
// in-team short circuit.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCrossTeamAdmission } from '../admission.js'

describe('evaluateCrossTeamAdmission — S3-H broadcast deny (W2-DONT-7)', () => {
  it('denies when target_team === "*"', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
    assert.equal(r.audit?.rule, 'W2-DONT-7')
  })

  it('denies even with target_agent specified (wildcard team trumps agent)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: 'someone',
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
  })

  it('audit metadata captures source identity and timestamp', () => {
    const now = 1_700_000_000_000
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
      now_ms: now,
    })
    assert.equal(r.allow, false)
    assert.equal(r.audit?.source_team, 'team-a')
    assert.equal(r.audit?.source_agent, 'alice')
    assert.equal(r.audit?.target_team, '*')
    assert.equal(r.audit?.at_ms, now)
  })
})

describe('evaluateCrossTeamAdmission — wildcard does NOT cascade into in-team', () => {
  it('does not deny when target_team is a literal name like "*-team"', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*-team',
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('does not deny when target_team contains "*" but is not exactly "*"', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: 'team-*',
      target_agent: 'bob',
    })
    assert.equal(r.allow, true)
  })

  it('S3-H short-circuits before in-team check (wildcard always denies)', () => {
    // Even if source_team also '*' (which would be in-team by equality),
    // the rule fires because target_team='*' specifically is the broadcast
    // attempt we want to reject.
    const r = evaluateCrossTeamAdmission({
      source_team: '*',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
  })

  it('does NOT fire when source_team="*" but target_team is concrete', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: '*',
      source_agent: 'alice',
      target_team: 'team-b',
      target_agent: 'bob',
    })
    // Only target_team='*' is the broadcast deny; source_team='*' is allowed
    // through (it's the source side that wants to broadcast, not receive one).
    assert.equal(r.allow, true)
    assert.equal(r.in_team, false)
  })

  it('audit at_ms tracks now_ms (defaults to Date.now when omitted)', () => {
    const before = Date.now()
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
    })
    const after = Date.now()
    assert.ok(r.audit.at_ms >= before && r.audit.at_ms <= after)
  })
})

describe('evaluateCrossTeamAdmission — broadcast deny composability', () => {
  it('multiple broadcast denies emit consistent audit shape', () => {
    for (const sourceAgent of ['alice', 'bob', 'carol']) {
      const r = evaluateCrossTeamAdmission({
        source_team: 'team-a',
        source_agent: sourceAgent,
        target_team: '*',
        target_agent: null,
      })
      assert.equal(r.allow, false)
      assert.equal(r.reason, 'cross_team_broadcast_denied')
      assert.equal(r.audit.rule, 'W2-DONT-7')
      assert.equal(r.audit.source_agent, sourceAgent)
    }
  })

  it('broadcast deny does NOT emit fallback envelope (HITL marker is irrelevant)', () => {
    const r = evaluateCrossTeamAdmission({
      source_team: 'team-a',
      source_agent: 'alice',
      target_team: '*',
      target_agent: null,
      requires_approval: true,
      target_mode: 'autonomous',
    })
    // Broadcast deny short-circuits; no fallback envelope is built.
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
    assert.equal(r.fallback, undefined)
  })
})
