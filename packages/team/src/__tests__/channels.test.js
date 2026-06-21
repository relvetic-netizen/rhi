import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  initChannels,
  addChannelWatch,
  listChannelWatches,
  closeAllChannelWatches,
  parseAgentAliases,
  dedupeKey,
  buildMeta,
} from '../channels.js'
import { writeToMailbox } from '../mailbox.js'
import { getInboxPath, getInboxDir, ensureDir } from '../paths.js'

const TEST_TEAM = '__test-channels__'
const TEST_AGENT = 'agent-recv'
const TEST_INSTANCE = 'test-instance-1'

const TMP = join(process.cwd(), '.test-tmp-channels')
const origDir = process.env.CLAUDE_CONFIG_DIR

function makeMockServer() {
  const calls = []
  return {
    calls,
    notification: async n => { calls.push(n) },
  }
}

function makeFailOnceServer() {
  const calls = []
  let attempts = 0
  let failed = false
  return {
    calls,
    get attempts() { return attempts },
    notification: async n => {
      attempts += 1
      if (!failed) {
        failed = true
        throw new Error('transient notification failure')
      }
      calls.push(n)
    },
  }
}

function makeAlwaysFailServer() {
  let attempts = 0
  return {
    get attempts() { return attempts },
    notification: async () => {
      attempts += 1
      throw new Error('persistent notification failure')
    },
  }
}

function channelErrorsPath() {
  return join(getInboxDir(TEST_TEAM), `${TEST_AGENT}.channel-errors.jsonl`)
}

function lastEmittedPath() {
  return join(getInboxDir(TEST_TEAM), `${TEST_AGENT}.last-emitted.json`)
}

async function readJsonLines(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return raw.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
}

before(() => { process.env.CLAUDE_CONFIG_DIR = TMP })
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
})

// ============================================================
// dedupeKey unit tests (T2 / T3 / T4)
// ============================================================

describe('dedupeKey', () => {
  it('uses request_id branch when present', () => {
    assert.equal(
      dedupeKey({ request_id: 'areq_xyz', from: 'a', text: 't', timestamp: '2026-05-06T10:00:00Z' }),
      'req:areq_xyz',
    )
  })

  it('uses in_reply_to + timestamp when no request_id', () => {
    assert.equal(
      dedupeKey({ in_reply_to: 'r1', timestamp: '2026-05-06T10:00:00Z' }),
      'rep:r1:2026-05-06T10:00:00Z',
    )
  })

  it('falls back to timestamp+from+sha8(text) when no ids', () => {
    const key = dedupeKey({ from: 'a', text: 'hello', timestamp: '2026-05-06T10:00:00Z' })
    assert.match(key, /^gen:2026-05-06T10:00:00Z\|a\|[0-9a-f]{8}$/)
  })

  it('produces a stable hash for identical text+from+timestamp', () => {
    const e = { from: 'a', text: 'hello', timestamp: '2026-05-06T10:00:00Z' }
    assert.equal(dedupeKey(e), dedupeKey({ ...e }))
  })

  it('differs when text differs', () => {
    const e1 = { from: 'a', text: 'hello', timestamp: 't' }
    const e2 = { from: 'a', text: 'world', timestamp: 't' }
    assert.notEqual(dedupeKey(e1), dedupeKey(e2))
  })
})

// ============================================================
// buildMeta unit tests (T10)
// ============================================================

describe('buildMeta', () => {
  it('omits undefined / empty optional fields', () => {
    const meta = buildMeta({
      team: 'tA', agent: 'agA', instanceId: 'i1',
      entry: { from: 'sender', text: 'hi', timestamp: 'ts' },
    })
    assert.equal(meta.team, 'tA')
    assert.equal(meta.agent, 'agA')
    assert.equal(meta.instance_id, 'i1')
    assert.equal(meta.from, 'sender')
    assert.equal(meta.timestamp, 'ts')
    assert.equal(meta.kind, 'message')
    assert.ok(!('request_id' in meta))
    assert.ok(!('in_reply_to' in meta))
    assert.ok(!('summary' in meta))
  })

  it('sets kind=request when request_id is present', () => {
    const meta = buildMeta({
      team: 'tA', agent: 'agA', instanceId: 'i1',
      entry: { from: 's', text: 'x', request_id: 'req_1' },
    })
    assert.equal(meta.kind, 'request')
    assert.equal(meta.request_id, 'req_1')
  })

  it('sets kind=reply when in_reply_to is present (no request_id)', () => {
    const meta = buildMeta({
      team: 'tA', agent: 'agA', instanceId: 'i1',
      entry: { from: 's', text: 'x', in_reply_to: 'req_1' },
    })
    assert.equal(meta.kind, 'reply')
    assert.equal(meta.in_reply_to, 'req_1')
  })

  it('coerces non-string optional fields to string', () => {
    const meta = buildMeta({
      team: 'tA', agent: 'agA', instanceId: 'i1',
      entry: { from: 's', text: 'x', request_id: 12345 },
    })
    assert.equal(meta.request_id, '12345')
  })

  it('includes orchestrator_session_id when present', () => {
    const meta = buildMeta({
      team: 'tA', agent: 'agA', instanceId: 'i1',
      entry: { from: 's', text: 'x', orchestrator_session_id: 'orch_meta_001' },
    })
    assert.equal(meta.orchestrator_session_id, 'orch_meta_001')
  })
})

// ============================================================
// initChannels — env unset, teardown (T11 / T12)
// ============================================================

describe('initChannels — no-op paths', () => {
  it('returns no-op when team / agent env not set', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, {})
    assert.equal(typeof ch.close, 'function')
    assert.equal(typeof ch.rescan, 'function')
    await ch.rescan()
    assert.equal(srv.calls.length, 0)
    ch.close()
  })

  it('returns no-op when only team is set', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM })
    await ch.rescan()
    assert.equal(srv.calls.length, 0)
    ch.close()
  })

  it('uses CLAUDE_SWARM_* env fallback when RELVETIA_* env is absent', async () => {
    const oldRelvetiaTeam = process.env.RELVETIA_TEAM
    const oldRelvetiaAgent = process.env.RELVETIA_AGENT
    const oldSwarmTeam = process.env.CLAUDE_SWARM_TEAM
    const oldSwarmAgent = process.env.CLAUDE_SWARM_AGENT
    delete process.env.RELVETIA_TEAM
    delete process.env.RELVETIA_AGENT
    process.env.CLAUDE_SWARM_TEAM = TEST_TEAM
    process.env.CLAUDE_SWARM_AGENT = TEST_AGENT

    const srv = makeMockServer()
    const ch = await initChannels(srv, { instanceId: TEST_INSTANCE })
    try {
      await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'team-lead', text: 'fallback env' })
      await ch.rescan()
      assert.equal(srv.calls.length, 1)
      assert.equal(srv.calls[0].params.meta.team, TEST_TEAM)
      assert.equal(srv.calls[0].params.meta.agent, TEST_AGENT)
    } finally {
      ch.close()
      if (oldRelvetiaTeam) process.env.RELVETIA_TEAM = oldRelvetiaTeam
      else delete process.env.RELVETIA_TEAM
      if (oldRelvetiaAgent) process.env.RELVETIA_AGENT = oldRelvetiaAgent
      else delete process.env.RELVETIA_AGENT
      if (oldSwarmTeam) process.env.CLAUDE_SWARM_TEAM = oldSwarmTeam
      else delete process.env.CLAUDE_SWARM_TEAM
      if (oldSwarmAgent) process.env.CLAUDE_SWARM_AGENT = oldSwarmAgent
      else delete process.env.CLAUDE_SWARM_AGENT
    }
  })

  it('teardown is idempotent', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    ch.close()
    ch.close() // second close must not throw
    assert.ok(true)
  })
})

// ============================================================
// initChannels — baseline + new entry detection (T1 / T5 / T7 / T8 / T9)
// ============================================================

describe('initChannels — runtime push', () => {
  it('seeds baseline from existing inbox without firing notifications (T1)', async () => {
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'team-lead', text: 'pre-init message' })
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    await ch.rescan()
    assert.equal(srv.calls.length, 0, 'baseline entries must not fire')
    ch.close()
  })

  it('starts on a missing inbox file and picks up the first message (T7)', async () => {
    const srv = makeMockServer()
    // No prior writeToMailbox → inbox file does not exist yet.
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    assert.equal(srv.calls.length, 0)

    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'team-lead', text: 'first ever' })
    await ch.rescan()

    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0].method, 'notifications/claude/channel')
    assert.equal(srv.calls[0].params.content, 'first ever')
    assert.equal(srv.calls[0].params.meta.team, TEST_TEAM)
    assert.equal(srv.calls[0].params.meta.agent, TEST_AGENT)
    assert.equal(srv.calls[0].params.meta.instance_id, TEST_INSTANCE)
    assert.equal(srv.calls[0].params.meta.from, 'team-lead')
    ch.close()
  })

  it('emits one notification per new entry through the JSONL append hot path (T5)', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    await writeToMailbox(TEST_TEAM, TEST_AGENT, {
      from: 'sender-a', text: 'task one', summary: 'one', request_id: 'req_1',
    })
    await ch.rescan()

    await writeToMailbox(TEST_TEAM, TEST_AGENT, {
      from: 'sender-a', text: 'task two', request_id: 'req_2',
    })
    await ch.rescan()

    assert.equal(srv.calls.length, 2)
    assert.equal(srv.calls[0].params.content, 'task one')
    assert.equal(srv.calls[0].params.meta.request_id, 'req_1')
    assert.equal(srv.calls[0].params.meta.summary, 'one')
    assert.equal(srv.calls[0].params.meta.kind, 'request')
    assert.equal(srv.calls[1].params.content, 'task two')
    assert.equal(srv.calls[1].params.meta.request_id, 'req_2')
    ch.close()
  })

  it('emits all entries when several arrive between rescans (T8)', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'a', text: 'm1' })
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'a', text: 'm2' })
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'a', text: 'm3' })
    await ch.rescan()

    assert.equal(srv.calls.length, 3)
    assert.deepEqual(srv.calls.map(c => c.params.content), ['m1', 'm2', 'm3'])
    ch.close()
  })

  it('suppresses duplicates across multiple rescans (T9)', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'a', text: 'one', request_id: 'req_dup' })
    await ch.rescan()
    await ch.rescan()
    await ch.rescan()

    assert.equal(srv.calls.length, 1)
    ch.close()
  })

  it('retries an entry after transient notification failure instead of marking it seen', async () => {
    const srv = makeFailOnceServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    await writeToMailbox(TEST_TEAM, TEST_AGENT, {
      from: 'sender-a', text: 'retry me', request_id: 'req_retry',
    })
    await ch.rescan()
    await ch.rescan()
    assert.ok(srv.attempts >= 2, 'entry must be attempted again after the transient failure')
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0].params.content, 'retry me')
    assert.equal(srv.calls[0].params.meta.request_id, 'req_retry')
    ch.close()
  })

  it('writes structured channel error logs and increments retry_count on repeated emit failure', async () => {
    const srv = makeAlwaysFailServer()
    const ch = await initChannels(srv, {
      team: TEST_TEAM,
      agent: TEST_AGENT,
      instanceId: TEST_INSTANCE,
      enableFsWatch: false,
      enableInitialRescan: false,
    })

    try {
      await writeToMailbox(TEST_TEAM, TEST_AGENT, {
        from: 'sender-a', text: 'retry log me', request_id: 'req_retry_log',
      })
      await ch.rescan()
      await ch.rescan()

      const lines = await readJsonLines(channelErrorsPath())
      assert.equal(lines.length, 2)
      assert.equal(lines[0].team, TEST_TEAM)
      assert.equal(lines[0].agent, TEST_AGENT)
      assert.equal(lines[0].instanceId, TEST_INSTANCE)
      assert.equal(lines[0].dedupeKey, 'req:req_retry_log')
      assert.equal(lines[0].error_message, 'persistent notification failure')
      assert.equal(lines[0].retry_count, 1)
      assert.equal(lines[1].retry_count, 2)
      assert.equal(srv.attempts, 2)
    } finally {
      ch.close()
    }
  })

  it('does not mark an entry seen when the post-notification transport probe fails', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, {
      team: TEST_TEAM,
      agent: TEST_AGENT,
      instanceId: TEST_INSTANCE,
      isTransportAlive: () => false,
      enableFsWatch: false,
      enableInitialRescan: false,
    })

    try {
      await writeToMailbox(TEST_TEAM, TEST_AGENT, {
        from: 'sender-a', text: 'probe fail', request_id: 'req_probe_fail',
      })
      await ch.rescan()
      await ch.rescan()

      const lines = await readJsonLines(channelErrorsPath())
      assert.equal(srv.calls.length, 2, 'same entry must be retried while probe fails')
      assert.equal(lines.length, 2)
      assert.equal(lines[1].retry_count, 2)
      assert.match(lines[0].error_message, /liveness probe failed/)
    } finally {
      ch.close()
    }
  })

  it('does not include empty optional meta fields in the wire format', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    // No summary, no request_id — must be absent from meta (not '' string)
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'sender', text: 'plain' })
    await ch.rescan()

    assert.equal(srv.calls.length, 1)
    const meta = srv.calls[0].params.meta
    assert.ok(!('request_id' in meta), 'request_id must be omitted')
    assert.ok(!('in_reply_to' in meta), 'in_reply_to must be omitted')
    assert.ok(!('summary' in meta), 'summary must be omitted')
    assert.equal(meta.kind, 'message')
    ch.close()
  })

  it('forwards orchestrator_session_id from inbox entry into channel meta', async () => {
    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })

    await writeToMailbox(TEST_TEAM, TEST_AGENT, {
      from: 'sender', text: 'orch routed', orchestrator_session_id: 'orch_chan_001',
    })
    await ch.rescan()

    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0].params.meta.orchestrator_session_id, 'orch_chan_001')
    ch.close()
  })

  it('migrates legacy JSON-array inbox and emits notifications for new entries only (T6)', async () => {
    // Pre-seed a legacy [...] inbox with two existing entries
    const teamDir = getInboxDir(TEST_TEAM)
    await ensureDir(teamDir)
    const inboxPath = getInboxPath(TEST_TEAM, TEST_AGENT)
    const legacy = [
      { from: 'pre', text: 'legacy-1', timestamp: '2026-05-06T09:00:00Z', read: false },
      { from: 'pre', text: 'legacy-2', timestamp: '2026-05-06T09:01:00Z', read: false },
    ]
    await writeFile(inboxPath, JSON.stringify(legacy))

    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    await ch.rescan()
    assert.equal(srv.calls.length, 0, 'legacy-baseline must not fire')

    // First write triggers JSONL migration in mailbox.js
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'sender', text: 'after-migration' })
    await ch.rescan()

    assert.equal(srv.calls.length, 1, 'only the post-migration entry must fire')
    assert.equal(srv.calls[0].params.content, 'after-migration')
    ch.close()
  })

  it('replays entries after the previous subprocess last-emitted key on startup', async () => {
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'w', text: 'already delivered', request_id: 'req_delivered' })
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'w', text: 'missed one', request_id: 'req_missed_1' })
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'w', text: 'missed two', request_id: 'req_missed_2' })
    await writeFile(lastEmittedPath(), `${JSON.stringify({
      team: TEST_TEAM,
      agent: TEST_AGENT,
      lastEmittedKey: 'req:req_delivered',
      ts: '2026-05-22T03:00:00.000Z',
      instanceId: 'prev-instance',
    }, null, 2)}\n`, 'utf8')

    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    await ch.rescan()

    assert.deepEqual(srv.calls.map(call => call.params.content), ['missed one', 'missed two'])
    const state = JSON.parse(await readFile(lastEmittedPath(), 'utf8'))
    assert.equal(state.lastEmittedKey, 'req:req_missed_2')
    assert.equal(state.instanceId, TEST_INSTANCE)
    ch.close()
  })

  it('keeps baseline compatibility when last-emitted state is absent', async () => {
    await writeToMailbox(TEST_TEAM, TEST_AGENT, { from: 'w', text: 'existing baseline', request_id: 'req_baseline_compat' })

    const srv = makeMockServer()
    const ch = await initChannels(srv, { team: TEST_TEAM, agent: TEST_AGENT, instanceId: TEST_INSTANCE })
    await ch.rescan()

    assert.equal(srv.calls.length, 0)
    await assert.rejects(readFile(lastEmittedPath(), 'utf8'), /ENOENT/)
    ch.close()
  })
})

// ============================================================
// addChannelWatch + multi-watch registry (2026-05-25 incident: Discord-
// launched session bound to primary env identity couldn't receive proactive
// notify on a team_clone_member virtual identity in a different team)
// ============================================================

describe('addChannelWatch — multi-binding registry', () => {
  // closeAllChannelWatches between cases guards against cross-test bleed
  // through the module-level registry.
  beforeEach(() => { closeAllChannelWatches() })
  after(() => { closeAllChannelWatches() })

  const TEAM_A = '__test-channels-A__'
  const AGENT_A = 'agent-A'
  const TEAM_B = '__test-channels-B__'
  const AGENT_B = 'agent-B'

  it('first add starts a new watcher and registers it under (team, agent)', async () => {
    const srv = makeMockServer()
    const handle = await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A' })
    assert.equal(handle.deduped, false, 'first add must not be deduped')
    assert.deepEqual(
      listChannelWatches(),
      [{ team: TEAM_A, agent: AGENT_A }],
      'registry must reflect the new watch',
    )
    handle.close()
  })

  it('second add of the same (team, agent) is deduped and shares the same close', async () => {
    const srv = makeMockServer()
    const first = await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A' })
    const second = await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A-other' })
    assert.equal(first.deduped, false)
    assert.equal(second.deduped, true, 'duplicate registration must report deduped:true')
    assert.equal(listChannelWatches().length, 1, 'registry must hold exactly one entry per (team,agent)')
    second.close()
    // first.close() now hits the inner closed guard; must not throw or
    // leave stale registry state.
    first.close()
    assert.equal(listChannelWatches().length, 0)
  })

  it('two distinct (team, agent) pairs run as independent watchers and emit only for their own inbox', async () => {
    const srv = makeMockServer()
    const watchA = await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A' })
    const watchB = await addChannelWatch(srv, { team: TEAM_B, agent: AGENT_B, instanceId: 'i-B' })

    await writeToMailbox(TEAM_A, AGENT_A, { from: 'someone', text: 'message into A' })
    await writeToMailbox(TEAM_B, AGENT_B, { from: 'someone', text: 'message into B' })
    await watchA.rescan()
    await watchB.rescan()

    assert.equal(srv.calls.length, 2, 'each watcher must emit exactly once')
    const metaTeams = srv.calls.map(c => c.params.meta.team).sort()
    assert.deepEqual(metaTeams, [TEAM_A, TEAM_B].sort(), 'each event must carry its own team binding')

    watchA.close()
    watchB.close()
  })

  it('closing one watch leaves the other running', async () => {
    const srv = makeMockServer()
    const watchA = await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A' })
    const watchB = await addChannelWatch(srv, { team: TEAM_B, agent: AGENT_B, instanceId: 'i-B' })
    watchA.close()
    assert.deepEqual(listChannelWatches(), [{ team: TEAM_B, agent: AGENT_B }])
    await writeToMailbox(TEAM_B, AGENT_B, { from: 'x', text: 'still alive' })
    await watchB.rescan()
    assert.equal(srv.calls.length, 1)
    watchB.close()
  })

  it('closeAllChannelWatches tears every binding down', async () => {
    const srv = makeMockServer()
    await addChannelWatch(srv, { team: TEAM_A, agent: AGENT_A, instanceId: 'i-A' })
    await addChannelWatch(srv, { team: TEAM_B, agent: AGENT_B, instanceId: 'i-B' })
    assert.equal(listChannelWatches().length, 2)
    closeAllChannelWatches()
    assert.equal(listChannelWatches().length, 0)
  })
})

describe('parseAgentAliases — env parsing', () => {
  let saved
  before(() => { saved = process.env.RELVETIA_AGENT_ALIASES })
  after(() => {
    if (saved === undefined) delete process.env.RELVETIA_AGENT_ALIASES
    else process.env.RELVETIA_AGENT_ALIASES = saved
  })

  it('returns [] when env unset', () => {
    delete process.env.RELVETIA_AGENT_ALIASES
    assert.deepEqual(parseAgentAliases(), [])
  })

  it('parses a JSON array of {team, agent}', () => {
    process.env.RELVETIA_AGENT_ALIASES = JSON.stringify([
      { team: 'T1', agent: 'A1' },
      { team: 'T2', agent: 'A2' },
    ])
    assert.deepEqual(parseAgentAliases(), [
      { team: 'T1', agent: 'A1' },
      { team: 'T2', agent: 'A2' },
    ])
  })

  it('drops malformed entries (missing team or agent)', () => {
    process.env.RELVETIA_AGENT_ALIASES = JSON.stringify([
      { team: 'T1', agent: 'A1' },
      { team: 'T2' },             // dropped (no agent)
      { agent: 'A3' },            // dropped (no team)
      { team: '', agent: 'A4' },  // dropped (empty team)
      null,                       // dropped
      { team: 'T5', agent: 'A5' },
    ])
    assert.deepEqual(parseAgentAliases(), [
      { team: 'T1', agent: 'A1' },
      { team: 'T5', agent: 'A5' },
    ])
  })

  it('returns [] on malformed JSON (does not throw)', () => {
    process.env.RELVETIA_AGENT_ALIASES = '{not-json'
    assert.deepEqual(parseAgentAliases(), [])
  })

  it('returns [] when JSON is not an array', () => {
    process.env.RELVETIA_AGENT_ALIASES = '{"team":"T1","agent":"A1"}'
    assert.deepEqual(parseAgentAliases(), [])
  })
})
