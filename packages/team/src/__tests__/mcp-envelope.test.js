import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { setProcessors } from '../tracing.js'
import { createTeam } from '../team.js'
import { addItem } from '../sessions.js'
import { writeToMailbox } from '../mailbox.js'

const TMP = join(process.cwd(), '.test-tmp-mcp-envelope')
const TEAM = '__test-mcp-envelope__'
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
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('MCP envelope: structuredContent surfaces on team_get_session', () => {
  it('truncated session call exposes structuredContent.truncated=true and leading NOTICE', async () => {
    await createTeam(TEAM, [{ name: 'alice' }, { name: 'bob' }], 'test team')
    const big = 'A'.repeat(40_000)
    for (let i = 0; i < 3; i++) {
      await addItem(TEAM, 'alice', { from: 'lead', text: big + ' item-' + i })
    }
    const result = await client.callTool({
      name: 'team_get_session',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.ok(result.structuredContent, 'CallToolResult should carry structuredContent')
    assert.equal(result.structuredContent.truncated, true)
    assert.ok(typeof result.structuredContent.omitted_count === 'number')
    assert.equal(result.structuredContent.total, 3, 'total should reflect the full item count, not the kept count')
    assert.ok(result.content[0].text.startsWith('[NOTICE:'), `text should start with NOTICE, got: ${result.content[0].text.slice(0, 60)}`)
  })

  it('non-truncated session call reports structuredContent.truncated=false', async () => {
    await createTeam(TEAM, [{ name: 'alice' }, { name: 'bob' }], 'test team')
    await addItem(TEAM, 'alice', { from: 'lead', text: 'hi' })
    const result = await client.callTool({
      name: 'team_get_session',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.ok(result.structuredContent)
    assert.equal(result.structuredContent.truncated, false)
    assert.equal(result.structuredContent.total, 1)
    assert.equal(result.structuredContent.omitted_count, 0)
    assert.ok(!result.content[0].text.startsWith('[NOTICE:'))
  })

  it('empty session reports structuredContent.total=0', async () => {
    await createTeam(TEAM, [{ name: 'alice' }, { name: 'bob' }], 'test team')
    const result = await client.callTool({
      name: 'team_get_session',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.ok(result.structuredContent)
    assert.equal(result.structuredContent.truncated, false)
    assert.equal(result.structuredContent.total, 0)
    assert.equal(result.structuredContent.omitted_count, 0)
  })

  it('PR-28 review fix: final returned text bytes never exceed budget (prefix/notice overhead included)', async () => {
    await createTeam(TEAM, [{ name: 'alice' }, { name: 'bob' }], 'test team')
    // Many items each near the budget boundary so prefix/notice overhead matters.
    for (let i = 0; i < 30; i++) {
      await addItem(TEAM, 'alice', { from: 'lead', text: 'x'.repeat(1100) })
    }
    const result = await client.callTool({
      name: 'team_get_session',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    const finalBytes = Buffer.byteLength(result.content[0].text, 'utf8')
    assert.ok(finalBytes <= 24_000, `final payload bytes ${finalBytes} must fit budget 24000 (overhead included)`)
    assert.equal(result.structuredContent.total, 30)
  })

  it('team_read_inbox per-item truncation surfaces in MCP envelope', async () => {
    await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'B'.repeat(20_000) })
    const result = await client.callTool({
      name: 'team_read_inbox',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.ok(result.structuredContent)
    assert.equal(result.structuredContent.truncated, true)
    assert.equal(result.structuredContent.omitted_count, 1)
    assert.equal(result.structuredContent.total, 1, 'total should reflect the unread count')
    assert.ok(result.content[0].text.startsWith('[NOTICE:'))
  })

  it('team_read_inbox non-truncated reports structuredContent.total', async () => {
    await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'small msg' })
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'another' })
    const result = await client.callTool({
      name: 'team_read_inbox',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.equal(result.structuredContent.truncated, false)
    assert.equal(result.structuredContent.omitted_count, 0)
    assert.equal(result.structuredContent.total, 2)
  })

  // Regression: 2026-05-25 incident where the harness elided content[] when
  // structuredContent existed, leaving the caller only the envelope and no
  // message body. Fix embeds full message data in structuredContent.messages
  // so it survives elision (see ../../docs/inbox-body-elision.md trail).
  it('team_read_inbox embeds full message bodies in structuredContent.messages (harness elision survival)', async () => {
    await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'first body', summary: 'first', color: 'blue' })
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'second body', summary: 'second' })
    const result = await client.callTool({
      name: 'team_read_inbox',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.ok(Array.isArray(result.structuredContent.messages), 'messages array must exist on structuredContent')
    assert.equal(result.structuredContent.messages.length, 2)
    assert.equal(result.structuredContent.messages[0].text, 'first body')
    assert.equal(result.structuredContent.messages[0].from, 'bob')
    assert.equal(result.structuredContent.messages[0].summary, 'first')
    assert.equal(result.structuredContent.messages[0].color, 'blue')
    assert.equal(result.structuredContent.messages[1].text, 'second body')
    // Color/summary fall back to null when absent rather than being omitted,
    // so callers can rely on a stable shape.
    assert.equal(result.structuredContent.messages[1].color, null)
  })

  it('team_read_inbox empty inbox exposes structuredContent.messages=[]', async () => {
    await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
    const result = await client.callTool({
      name: 'team_read_inbox',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.deepEqual(result.structuredContent.messages, [], 'empty inbox should still surface messages: []')
  })

  it('team_read_inbox truncated only embeds messages that survived the byte cap', async () => {
    await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'A'.repeat(20_000) })
    await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'tail-msg' })
    const result = await client.callTool({
      name: 'team_read_inbox',
      arguments: { team_name: TEAM, agent_name: 'alice' },
    })
    assert.equal(result.structuredContent.truncated, true)
    assert.ok(Array.isArray(result.structuredContent.messages))
    // The byte cap forces at least the giant first message to be omitted;
    // the embedded array must reflect the same omission so it never exceeds
    // the byte budget that the content[] cap was designed to enforce.
    assert.ok(
      result.structuredContent.messages.length < 2,
      `truncated reply must embed fewer than total (got ${result.structuredContent.messages.length})`,
    )
  })

  it('team_read_inbox respects RELVETIA_INBOX_EMBED=off opt-out', async () => {
    const prev = process.env.RELVETIA_INBOX_EMBED
    process.env.RELVETIA_INBOX_EMBED = 'off'
    try {
      await createTeam(TEAM, [{ name: 'alice', role: 'researcher' }, { name: 'bob' }], 'test team')
      await writeToMailbox(TEAM, 'alice', { from: 'bob', text: 'opt-out body' })
      const result = await client.callTool({
        name: 'team_read_inbox',
        arguments: { team_name: TEAM, agent_name: 'alice' },
      })
      assert.equal(result.structuredContent.messages, undefined, 'embed=off must omit messages field entirely')
      assert.equal(result.structuredContent.total, 1, 'envelope fields stay intact')
    } finally {
      if (prev === undefined) delete process.env.RELVETIA_INBOX_EMBED
      else process.env.RELVETIA_INBOX_EMBED = prev
    }
  })
})
