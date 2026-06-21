import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sendRequest, sendRequestAsync, sendReply, getRequest } from '../requests.js'
import { createTeam } from '../team.js'
import { readMailbox } from '../mailbox.js'
import { _clearGuardrailCache } from '../guardrails.js'
import { listApprovals } from '../approvals.js'
import { getTeamDir } from '../paths.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-requests__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-requests')

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

describe('sendRequest + sendReply (happy path)', () => {
  it('delivers request, accepts reply, returns response', async () => {
    // Schedule a reply after a short delay, simulating bob reading his inbox
    // and responding.
    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const bobInbox = await readMailbox(TEST_TEAM, 'bob')
      const req = bobInbox.find(m => m.request_id)
      assert.ok(req, 'bob should have received a request')
      await sendReply({
        teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
        responseText: 'done: 42',
      })
    }

    const [result] = await Promise.all([
      sendRequest({
        teamName: TEST_TEAM, from: 'alice', to: 'bob',
        prompt: 'what is the answer?',
        timeoutMs: 3000, pollIntervalMs: 50,
      }),
      replyLater(),
    ])

    assert.equal(result.replied, true)
    assert.equal(result.response.text, 'done: 42')
    assert.equal(result.response.from, 'bob')
    assert.equal(result.response.in_reply_to, result.request_id)
  })

  it('propagates orchestrator_session_id from sync request registry to reply inbox entry', async () => {
    const replyLater = async () => {
      await new Promise(r => setTimeout(r, 100))
      const bobInbox = await readMailbox(TEST_TEAM, 'bob')
      const req = bobInbox.find(m => m.request_id)
      assert.equal(req.orchestrator_session_id, 'orch_sync_001')
      await sendReply({
        teamName: TEST_TEAM, from: 'bob', requestId: req.request_id,
        responseText: 'ack sync orch',
      })
    }

    const [result] = await Promise.all([
      sendRequest({
        teamName: TEST_TEAM, from: 'alice', to: 'bob',
        prompt: 'reply with routing context',
        timeoutMs: 3000, pollIntervalMs: 50,
        orchestratorSessionId: 'orch_sync_001',
      }),
      replyLater(),
    ])

    assert.equal(result.replied, true)
    assert.equal(result.response.text, 'ack sync orch')
    assert.equal(result.response.orchestrator_session_id, 'orch_sync_001')
  })
})

describe('sendRequest timeout', () => {
  it('returns timed_out when no reply arrives', async () => {
    const result = await sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'silent test',
      timeoutMs: 200, pollIntervalMs: 50,
    })
    assert.equal(result.replied, false)
    assert.equal(result.timed_out, true)

    // Registry should be cleaned up after timeout
    const registered = await getRequest(TEST_TEAM, result.request_id)
    assert.equal(registered, null)
  })
})

describe('sendReply', () => {
  it('returns error for unknown request_id', async () => {
    const result = await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: 'req_unknown',
      responseText: 'x',
    })
    assert.equal(result.delivered, false)
    assert.match(result.reason, /no pending request/)
  })

  it('returns pending_approval when sendRequest is captured by auto_require_approval', async () => {
    await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
    await writeFile(
      join(getTeamDir(TEST_TEAM), 'guardrails.json'),
      JSON.stringify({
        input: [{
          type: 'auto_require_approval',
          match: { mode: 'substring', patterns: ['DROP TABLE'] },
          approval_kind: 'sensitive_command',
        }],
      })
    )
    _clearGuardrailCache(TEST_TEAM)

    const start = Date.now()
    const result = await sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'please run DROP TABLE users',
      timeoutMs: 5000, pollIntervalMs: 50,
    })
    const elapsed = Date.now() - start

    assert.equal(result.replied, false)
    assert.equal(result.pending_approval, true)
    assert.ok(result.pending_approval_id)
    assert.match(result.reason, /DROP TABLE|approval/i)
    // Must NOT have polled until timeout — held requests return fast.
    assert.ok(elapsed < 1000, `held request must return quickly (got ${elapsed}ms)`)

    // Registry must be cleaned up: deferred replies for this request_id
    // would otherwise leak.
    const registered = await getRequest(TEST_TEAM, result.request_id)
    assert.equal(registered, null)

    // Bob's inbox is empty (the request never landed).
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    assert.equal(bobInbox.find(m => m.request_id), undefined)

    // The held message lives in the approval queue with sensitive_command kind.
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.ok(pending.find(a => a.id === result.pending_approval_id))
    assert.equal(pending[0].kind, 'sensitive_command')
  })

  it('returns pending_approval when sendReply is captured by auto_require_approval', async () => {
    // Step 1: alice → bob normal request, bob receives.
    let capturedId
    const requestRun = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'innocent prompt', timeoutMs: 2000, pollIntervalMs: 50,
    })
    await new Promise(r => setTimeout(r, 100))
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    capturedId = bobInbox.find(m => m.request_id)?.request_id
    assert.ok(capturedId)

    // Step 2: install rule that captures alice's inbox (so bob's reply is held).
    await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
    await writeFile(
      join(getTeamDir(TEST_TEAM), 'guardrails.json'),
      JSON.stringify({
        input: [{
          type: 'auto_require_approval',
          match: { mode: 'substring', patterns: ['rm -rf'] },
        }],
      })
    )
    _clearGuardrailCache(TEST_TEAM)

    // Step 3: bob replies with the trigger phrase — the reply must NOT
    // claim delivery.
    const reply = await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: capturedId,
      responseText: 'sure, just run rm -rf /tmp/cache',
    })
    assert.equal(reply.delivered, false)
    assert.equal(reply.pending_approval, true)
    assert.ok(reply.pending_approval_id)

    // Step 4: alice times out (her inbox never received the reply).
    const result = await requestRun
    assert.equal(result.replied, false)
    assert.equal(result.timed_out, true)
  })

  it('request_id is cleaned up after reply arrives', async () => {
    let capturedId
    const run = sendRequest({
      teamName: TEST_TEAM, from: 'alice', to: 'bob',
      prompt: 'ping', timeoutMs: 3000, pollIntervalMs: 50,
    })
    // Give the request a moment to register
    await new Promise(r => setTimeout(r, 80))
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    capturedId = bobInbox.find(m => m.request_id)?.request_id
    assert.ok(capturedId)

    await sendReply({
      teamName: TEST_TEAM, from: 'bob', requestId: capturedId,
      responseText: 'pong',
    })
    await run
    const after = await getRequest(TEST_TEAM, capturedId)
    assert.equal(after, null)
  })
})

async function fileSha256(path) {
  try {
    const data = await readFile(path)
    return createHash('sha256').update(data).digest('hex')
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
}

describe('sendRequestAsync', () => {
  it('delivers an async request with areq id and envelope', async () => {
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'please inspect this',
    })

    assert.equal(result.delivered, true)
    assert.match(result.request_id, /^areq_/)

    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    const msg = bobInbox.find(m => m.request_id === result.request_id)
    assert.ok(msg)
    assert.equal(msg.from, 'alice')
    assert.match(msg.text, new RegExp(`<async-request id="${result.request_id}" from="alice">`))
    assert.match(msg.text, /please inspect this/)
    assert.match(msg.text, /<\/async-request>/)
  })

  it('returns quickly without polling for a reply', async () => {
    const start = Date.now()
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'no reply needed',
    })
    const elapsed = Date.now() - start

    assert.equal(result.delivered, true)
    assert.ok(elapsed < 100, `async request should return quickly (got ${elapsed}ms)`)
  })

  it('does not touch the pending request registry', async () => {
    const registryPath = join(getTeamDir(TEST_TEAM), 'pending-requests.json')
    await writeFile(registryPath, JSON.stringify({ req_existing: { from: 'alice', to: 'bob' } }, null, 2))
    const beforeHash = await fileSha256(registryPath)

    await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'registry must not change',
    })

    assert.equal(await fileSha256(registryPath), beforeHash)
  })

  it('throws for an invalid team', async () => {
    await assert.rejects(
      sendRequestAsync({
        teamName: '__missing-team__',
        from: 'alice',
        to: 'bob',
        prompt: 'hello',
      }),
      /Team "__missing-team__" not found/
    )
  })

  it('throws for an invalid recipient', async () => {
    await assert.rejects(
      sendRequestAsync({
        teamName: TEST_TEAM,
        from: 'alice',
        to: 'carol',
        prompt: 'hello',
      }),
      /Member "carol" not found/
    )
  })

  it('rejects broadcast recipients in v1', async () => {
    await assert.rejects(
      sendRequestAsync({
        teamName: TEST_TEAM,
        from: 'alice',
        to: '*',
        prompt: 'hello all',
      }),
      /Async broadcast not supported in v1/
    )
  })

  it('reflects urgency_hint_ms in the async envelope', async () => {
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'please prioritize',
      urgencyHintMs: 2500,
    })

    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    const msg = bobInbox.find(m => m.request_id === result.request_id)
    assert.match(msg.text, /urgency-hint-ms="2500"/)
  })

  it('forwards summary into the inbox message', async () => {
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'summarized work',
      summary: 'short preview',
    })

    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    const msg = bobInbox.find(m => m.request_id === result.request_id)
    assert.equal(msg.summary, 'short preview')
  })

  it('returns pending_approval_id when captured by auto_require_approval', async () => {
    await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
    await writeFile(
      join(getTeamDir(TEST_TEAM), 'guardrails.json'),
      JSON.stringify({
        input: [{
          type: 'auto_require_approval',
          match: { mode: 'substring', patterns: ['DROP TABLE'] },
          approval_kind: 'sensitive_command',
        }],
      })
    )
    _clearGuardrailCache(TEST_TEAM)

    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'please run DROP TABLE users',
    })

    assert.match(result.request_id, /^areq_/)
    assert.ok(result.pending_approval_id)
    assert.equal(result.delivered, undefined)

    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    assert.equal(bobInbox.find(m => m.request_id === result.request_id), undefined)

    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    const approval = pending.find(a => a.id === result.pending_approval_id)
    assert.ok(approval)
    assert.equal(approval.message.request_id, result.request_id)
    assert.equal(approval.kind, 'sensitive_command')
  })

  it('uses the areq_ prefix for every async request id', async () => {
    for (let i = 0; i < 3; i++) {
      const result = await sendRequestAsync({
        teamName: TEST_TEAM,
        from: 'alice',
        to: 'bob',
        prompt: `prefix ${i}`,
      })
      assert.match(result.request_id, /^areq_/)
    }
  })

  it('forwards orchestrator_session_id into the inbox message', async () => {
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'orchestrator-driven dispatch',
      orchestratorSessionId: 'orch_test_001',
    })

    assert.equal(result.delivered, true)
    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    const msg = bobInbox.find(m => m.request_id === result.request_id)
    assert.ok(msg, 'request should be delivered')
    assert.equal(msg.orchestrator_session_id, 'orch_test_001')
  })

  it('omits orchestrator_session_id when not supplied', async () => {
    const result = await sendRequestAsync({
      teamName: TEST_TEAM,
      from: 'alice',
      to: 'bob',
      prompt: 'no orchestrator',
    })

    const bobInbox = await readMailbox(TEST_TEAM, 'bob')
    const msg = bobInbox.find(m => m.request_id === result.request_id)
    assert.ok(msg)
    assert.equal(Object.prototype.hasOwnProperty.call(msg, 'orchestrator_session_id'), false)
  })
})
