// MCP-level coverage for team_add_watch (2026-05-25 multi-watch incident).
// Channels unit tests live in channels.test.js; this file exercises the tool
// surface through an InMemoryTransport so callers see what their MCP client
// would actually receive (structuredContent envelope, dedupe semantics, list
// of active watches).

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { setProcessors } from '../tracing.js'
import { createTeam } from '../team.js'
import { closeAllChannelWatches } from '../channels.js'

const TMP = join(process.cwd(), '.test-tmp-team-add-watch')
const TEAM_PRIMARY = '__test-add-watch-primary__'
const TEAM_SECONDARY = '__test-add-watch-secondary__'
const origDir = process.env.CLAUDE_CONFIG_DIR

let server
let client

before(async () => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
  ;({ server } = await import('../index.js'))
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
  await Promise.all([
    server.connect(serverT),
    client.connect(clientT),
  ])
})

after(async () => {
  try { await client?.close() } catch {}
  try { await server?.close() } catch {}
  closeAllChannelWatches()
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})

beforeEach(async () => {
  closeAllChannelWatches()
  await rm(TMP, { recursive: true, force: true })
})

describe('team_add_watch tool — multi-identity proactive notify', () => {
  it('first call registers the (team, agent) and reports deduped=false', async () => {
    await createTeam(TEAM_SECONDARY, [{ name: 'shadow' }], 'secondary identity')
    const result = await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_SECONDARY, agent_name: 'shadow' },
    })
    assert.equal(result.structuredContent.deduped, false)
    assert.equal(result.structuredContent.team, TEAM_SECONDARY)
    assert.equal(result.structuredContent.agent, 'shadow')
    assert.ok(
      result.structuredContent.watches.some(w => w.team === TEAM_SECONDARY && w.agent === 'shadow'),
      'active watch list must include the new binding',
    )
    assert.match(result.content[0].text, /watch added/)
  })

  it('re-adding the same binding reports deduped=true and keeps the watcher count stable', async () => {
    await createTeam(TEAM_SECONDARY, [{ name: 'shadow' }], 'secondary identity')
    await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_SECONDARY, agent_name: 'shadow' },
    })
    const watchCountBefore = (await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_SECONDARY, agent_name: 'shadow' },
    })).structuredContent.watches.length

    // Hit it a third time, count must stay equal — guards against an off-by-
    // one or stale registry handle that would multiply watchers on every
    // call.
    const third = await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_SECONDARY, agent_name: 'shadow' },
    })
    assert.equal(third.structuredContent.deduped, true)
    assert.equal(third.structuredContent.watches.length, watchCountBefore)
    assert.match(third.content[0].text, /already watching/)
  })

  it('adding two different (team, agent) bindings exposes both in the watch list', async () => {
    await createTeam(TEAM_PRIMARY, [{ name: 'lead' }], 'primary identity')
    await createTeam(TEAM_SECONDARY, [{ name: 'shadow' }], 'secondary identity')

    await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_PRIMARY, agent_name: 'lead' },
    })
    const second = await client.callTool({
      name: 'team_add_watch',
      arguments: { team_name: TEAM_SECONDARY, agent_name: 'shadow' },
    })
    const pairs = second.structuredContent.watches.map(w => `${w.team}/${w.agent}`).sort()
    assert.ok(pairs.includes(`${TEAM_PRIMARY}/lead`), `expected primary in pairs, got ${pairs.join(',')}`)
    assert.ok(pairs.includes(`${TEAM_SECONDARY}/shadow`), `expected secondary in pairs, got ${pairs.join(',')}`)
  })
})
