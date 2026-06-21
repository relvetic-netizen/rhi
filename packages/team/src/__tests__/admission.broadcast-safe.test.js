// W3-S2 P1-3 — admission.evaluateBroadcastAdmission tests.
// W2-DONT-7 (target_team='*' deny) is unchanged — see admission.test.js.
// This file verifies the safe broadcast route additive.

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluateBroadcastAdmission,
  BROADCAST_FANOUT_DEFAULT,
  BROADCAST_FANOUT_MAX,
} from '../admission.js'
import { formatBroadcastEnvelope } from '../graph-store.js'

describe('evaluateBroadcastAdmission: required fields', () => {
  test('rejects missing audit_label', () => {
    const r = evaluateBroadcastAdmission({ recipients: ['team-a:agent-x'] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_audit_label_required')
  })

  test('rejects empty audit_label after trim', () => {
    const r = evaluateBroadcastAdmission({ audit_label: '   ', recipients: ['t:a'] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_audit_label_required')
  })

  test('rejects missing recipients', () => {
    const r = evaluateBroadcastAdmission({ audit_label: 'progress-report' })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_recipients_required')
  })

  test('rejects empty recipients array', () => {
    const r = evaluateBroadcastAdmission({ audit_label: 'l', recipients: [] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_recipients_required')
  })
})

describe('evaluateBroadcastAdmission: recipient validation', () => {
  test('rejects non-string recipient', () => {
    const r = evaluateBroadcastAdmission({ audit_label: 'l', recipients: [123] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_recipient_invalid')
  })

  test('rejects empty-string recipient', () => {
    const r = evaluateBroadcastAdmission({ audit_label: 'l', recipients: [''] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_recipient_invalid')
  })

  test('rejects wildcard recipient (W2-DONT-7 carry per recipient)', () => {
    const r = evaluateBroadcastAdmission({ audit_label: 'l', recipients: ['*'] })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_wildcard_not_allowed')
  })

  test('rejects duplicate recipients', () => {
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: ['t:a', 't:b', 't:a'],
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_duplicate_recipients')
  })
})

describe('evaluateBroadcastAdmission: fanout_limit', () => {
  test('default fanout_limit is BROADCAST_FANOUT_DEFAULT (10)', () => {
    assert.equal(BROADCAST_FANOUT_DEFAULT, 10)
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: ['a:1'],
    })
    assert.equal(r.allow, true)
    assert.equal(r.fanout_limit, 10)
  })

  test('rejects fanout_limit below 1', () => {
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: ['a:1'],
      fanout_limit: 0,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_fanout_limit_invalid')
  })

  test('rejects fanout_limit above BROADCAST_FANOUT_MAX', () => {
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: ['a:1'],
      fanout_limit: BROADCAST_FANOUT_MAX + 1,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_fanout_limit_invalid')
  })

  test('rejects when recipients exceed fanout_limit', () => {
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: Array.from({ length: 12 }, (_, i) => `a:${i}`),
      fanout_limit: 10,
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'broadcast_fanout_exceeded')
    assert.equal(r.attempted, 12)
    assert.equal(r.fanout_limit, 10)
  })

  test('allows recipients exactly at fanout_limit', () => {
    const r = evaluateBroadcastAdmission({
      audit_label: 'l',
      recipients: Array.from({ length: 5 }, (_, i) => `a:${i}`),
      fanout_limit: 5,
    })
    assert.equal(r.allow, true)
    assert.equal(r.recipients.length, 5)
  })
})

describe('evaluateBroadcastAdmission: success envelope', () => {
  test('returns audit envelope with rule W3-S2-P1-3 and kind broadcast_safe', () => {
    const nowMs = 1234567890000
    const r = evaluateBroadcastAdmission({
      audit_label: 'sprint-summary',
      recipients: ['team-alpha:lead', 'team-beta:lead'],
      fanout_limit: 10,
      source_team: 'orchestration',
      source_agent: 'coordinator',
      now_ms: nowMs,
    })
    assert.equal(r.allow, true)
    assert.equal(r.audit_label, 'sprint-summary')
    assert.deepEqual(r.recipients, ['team-alpha:lead', 'team-beta:lead'])
    assert.equal(r.fanout_limit, 10)
    assert.equal(r.audit.rule, 'W3-S2-P1-3')
    assert.equal(r.audit.kind, 'broadcast_safe')
    assert.equal(r.audit.audit_label, 'sprint-summary')
    assert.equal(r.audit.source_team, 'orchestration')
    assert.equal(r.audit.source_agent, 'coordinator')
    assert.equal(r.audit.recipient_count, 2)
    assert.equal(r.audit.fanout_limit, 10)
    assert.equal(r.audit.at_ms, nowMs)
  })

  test('clones recipients defensively (caller mutation does not corrupt envelope)', () => {
    const recipients = ['t:a', 't:b']
    const r = evaluateBroadcastAdmission({ audit_label: 'l', recipients })
    recipients.push('t:c')  // caller mutation post-call
    assert.equal(r.recipients.length, 2)
  })
})

describe('formatBroadcastEnvelope (graph-store)', () => {
  test('builds envelope from admission result', () => {
    const admission = evaluateBroadcastAdmission({
      audit_label: 'progress',
      recipients: ['t1:a', 't2:b'],
      source_team: 'src',
      source_agent: 'me',
    })
    const env = formatBroadcastEnvelope({
      audit_label: admission.audit_label,
      recipients: admission.recipients,
      fanout_limit: admission.fanout_limit,
      source_team: 'src',
      source_agent: 'me',
      nowMs: 1700000000000,
    })
    assert.equal(env.kind, 'broadcast_safe')
    assert.equal(env.audit_label, 'progress')
    assert.deepEqual(env.recipients, ['t1:a', 't2:b'])
    assert.equal(env.source_team, 'src')
    assert.equal(env.source_agent, 'me')
    assert.equal(env.started_at, 1700000000000)
    assert.equal(typeof env.request_id, 'string')
    assert.ok(env.request_id.length > 0)
  })

  test('explicit request_id pass-through', () => {
    const env = formatBroadcastEnvelope({
      audit_label: 'l',
      recipients: ['t:a'],
      fanout_limit: 5,
      request_id: 'fixed-id-1234',
    })
    assert.equal(env.request_id, 'fixed-id-1234')
  })

  test('rejects missing audit_label', () => {
    assert.throws(() => formatBroadcastEnvelope({
      recipients: ['t:a'],
      fanout_limit: 1,
    }), /audit_label required/)
  })

  test('rejects empty recipients', () => {
    assert.throws(() => formatBroadcastEnvelope({
      audit_label: 'l',
      recipients: [],
      fanout_limit: 1,
    }), /recipients required/)
  })

  test('rejects non-positive fanout_limit', () => {
    assert.throws(() => formatBroadcastEnvelope({
      audit_label: 'l',
      recipients: ['t:a'],
      fanout_limit: 0,
    }), /fanout_limit/)
  })
})

describe('W2-DONT-7 carry: target_team="*" still denied (regression guard)', () => {
  test('legacy path stays denied via separate evaluateCrossTeamAdmission', async () => {
    // Spot-check: evaluateBroadcastAdmission is the safe route; the unsafe
    // wildcard path is on evaluateCrossTeamAdmission. Both coexist.
    const { evaluateCrossTeamAdmission } = await import('../admission.js')
    const r = evaluateCrossTeamAdmission({
      source_team: 'a',
      source_agent: 's',
      target_team: '*',
      target_agent: 'broadcast',
    })
    assert.equal(r.allow, false)
    assert.equal(r.reason, 'cross_team_broadcast_denied')
    assert.equal(r.audit.rule, 'W2-DONT-7')
  })
})
