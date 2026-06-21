import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { invoke, crossReply } from '../cross-team.js'
import { createTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { setProcessors } from '../tracing.js'

const SOURCE_TEAM = '__test-cross-src__'
const TARGET_TEAM = '__test-cross-tgt__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-cross')

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
  await createTeam(SOURCE_TEAM, [{ name: 'requester', role: 'coord' }], 'source')
  await createTeam(TARGET_TEAM, [{ name: 'specialist', role: 'expert' }], 'target')
})

describe('invoke (cross-team)', () => {
  it('blocks wildcard target_team before registry or mailbox writes', async () => {
    const result = await invoke({
      sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
      targetTeam: '*', targetAgent: 'specialist',
      prompt: 'broadcast attempt',
      timeoutMs: 200, pollIntervalMs: 50,
    })

    assert.equal(result.replied, false)
    assert.equal(result.blocked, true)
    assert.equal(result.reason, 'cross_team_broadcast_denied')
    assert.equal(result.admission_audit.rule, 'W2-DONT-7')
  })

  it('allows in-team invoke through admission short-circuit', async () => {
    await createTeam('__test-cross-same__', [
      { name: 'requester', role: 'coord' },
      { name: 'specialist', role: 'expert' },
    ], 'same-team')

    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const inbox = await readMailbox('__test-cross-same__', 'specialist')
      const req = inbox.find(m => m.request_id)
      assert.ok(req, 'specialist should receive in-team invoke request')
      await crossReply({
        sourceTeam: '__test-cross-same__', sourceAgent: 'requester',
        requestId: req.request_id,
        fromTeam: '__test-cross-same__', fromAgent: 'specialist',
        responseText: 'same-team answer',
      })
    }

    const [result] = await Promise.all([
      invoke({
        sourceTeam: '__test-cross-same__', sourceAgent: 'requester',
        targetTeam: '__test-cross-same__', targetAgent: 'specialist',
        prompt: 'local question',
        timeoutMs: 3000, pollIntervalMs: 50,
      }),
      replyLater(),
    ])

    assert.equal(result.replied, true)
    assert.equal(result.response.text, 'same-team answer')
  })

  it('delivers request to target team and resolves on cross-reply', async () => {
    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const inbox = await readMailbox(TARGET_TEAM, 'specialist')
      const req = inbox.find(m => m.request_id)
      assert.ok(req, 'specialist should have received the cross-team request')
      assert.match(req.text, /<cross-team-request/)
      assert.match(req.text, new RegExp(`source-team="${SOURCE_TEAM}"`))

      await crossReply({
        sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
        requestId: req.request_id,
        fromTeam: TARGET_TEAM, fromAgent: 'specialist',
        responseText: 'here is the answer',
      })
    }

    const [result] = await Promise.all([
      invoke({
        sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
        targetTeam: TARGET_TEAM, targetAgent: 'specialist',
        prompt: 'what is X?',
        timeoutMs: 3000, pollIntervalMs: 50,
      }),
      replyLater(),
    ])

    assert.equal(result.replied, true)
    assert.equal(result.response.text, 'here is the answer')
    assert.equal(result.response.in_reply_to, result.request_id)
    assert.equal(result.response.from, `specialist@${TARGET_TEAM}`)
  })

  it('returns timed_out when no reply arrives', async () => {
    const result = await invoke({
      sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
      targetTeam: TARGET_TEAM, targetAgent: 'specialist',
      prompt: 'silent',
      timeoutMs: 200, pollIntervalMs: 50,
    })
    assert.equal(result.replied, false)
    assert.equal(result.timed_out, true)
  })

  it('fails fast when target team does not exist', async () => {
    const result = await invoke({
      sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
      targetTeam: 'no-such-team', targetAgent: 'x',
      prompt: 'x', timeoutMs: 200,
    })
    assert.equal(result.replied, false)
    assert.match(result.error, /target team/)
  })

  it('fails fast when target agent does not exist', async () => {
    const result = await invoke({
      sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
      targetTeam: TARGET_TEAM, targetAgent: 'ghost',
      prompt: 'x', timeoutMs: 200,
    })
    assert.equal(result.replied, false)
    assert.match(result.error, /target agent/)
  })
})

describe('crossReply', () => {
  it('writes reply to source team inbox with in_reply_to', async () => {
    const result = await crossReply({
      sourceTeam: SOURCE_TEAM, sourceAgent: 'requester',
      requestId: 'xreq_test123',
      fromTeam: TARGET_TEAM, fromAgent: 'specialist',
      responseText: 'standalone reply',
    })
    assert.equal(result.delivered, true)

    const inbox = await readMailbox(SOURCE_TEAM, 'requester')
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].in_reply_to, 'xreq_test123')
    assert.equal(inbox[0].from, `specialist@${TARGET_TEAM}`)
  })
})
