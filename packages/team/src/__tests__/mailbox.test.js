import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  writeToMailbox, readMailbox, readUnreadMessages,
  markMessagesAsRead, broadcastMessage, clearMailbox,
} from '../mailbox.js'
import { listApprovals } from '../approvals.js'
import { capInboxMessages, INBOX_PER_ITEM_BUDGET_BYTES } from '../index.js'
import { setProcessors, emitEvent } from '../tracing.js'

const TEST_TEAM = '__test-mailbox__'

// Unique dir per test file so parallel `node --test *.test.js` runs don't
// collide (Windows + slow FS surfaces the race most reliably).
const TMP = join(process.cwd(), '.test-tmp-mailbox')
const origDir = process.env.CLAUDE_CONFIG_DIR
before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('writeToMailbox', () => {
  it('creates inbox file and writes message', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'team-lead',
      text: 'Hello agent',
      summary: 'Greeting',
    })

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].from, 'team-lead')
    assert.equal(messages[0].text, 'Hello agent')
    assert.equal(messages[0].read, false)
    assert.equal(messages[0].summary, 'Greeting')
  })

  it('appends to existing inbox', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'First' })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Second' })

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 2)
    assert.equal(messages[0].text, 'First')
    assert.equal(messages[1].text, 'Second')
  })

  it('preserves all messages under concurrent writes', async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeToMailbox(TEST_TEAM, 'agent-a', { from: `sender-${i}`, text: `msg ${i}` })
    )
    await Promise.all(writes)

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 10, `Expected 10 messages, got ${messages.length}`)
  })

  it('persists orchestrator_session_id when supplied', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'team-lead',
      text: 'orchestrator-driven',
      orchestrator_session_id: 'orch_mbx_001',
    })

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].orchestrator_session_id, 'orch_mbx_001')
  })

  it('omits orchestrator_session_id field when not supplied', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'team-lead',
      text: 'no orch',
    })

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 1)
    assert.equal(Object.prototype.hasOwnProperty.call(messages[0], 'orchestrator_session_id'), false)
  })
})

describe('readUnreadMessages', () => {
  it('returns only unread messages', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg 1' })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg 2' })
    await markMessagesAsRead(TEST_TEAM, 'agent-a')
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg 3' })

    const unread = await readUnreadMessages(TEST_TEAM, 'agent-a')
    assert.equal(unread.length, 1)
    assert.equal(unread[0].text, 'Msg 3')
  })

  it('returns empty for nonexistent inbox', async () => {
    const unread = await readUnreadMessages(TEST_TEAM, 'no-such-agent')
    assert.deepEqual(unread, [])
  })
})

describe('markMessagesAsRead', () => {
  it('marks all messages as read', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg 1' })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg 2' })

    await markMessagesAsRead(TEST_TEAM, 'agent-a')

    const unread = await readUnreadMessages(TEST_TEAM, 'agent-a')
    assert.equal(unread.length, 0)

    const all = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(all.length, 2)
    assert.ok(all.every(m => m.read === true))
  })

  it('is idempotent', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg' })
    await markMessagesAsRead(TEST_TEAM, 'agent-a')
    await markMessagesAsRead(TEST_TEAM, 'agent-a') // second call should not fail

    const all = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(all.length, 1)
    assert.equal(all[0].read, true)
  })

  it('handles nonexistent inbox gracefully', async () => {
    // Should not throw
    await markMessagesAsRead(TEST_TEAM, 'no-such-agent')
  })
})

describe('broadcastMessage', () => {
  it('sends to all members except sender', async () => {
    const members = [
      { name: 'team-lead', color: 'white' },
      { name: 'agent-a', color: 'red' },
      { name: 'agent-b', color: 'blue' },
    ]

    const { delivered, pending, failed } = await broadcastMessage(
      TEST_TEAM, 'team-lead', 'Broadcast msg', 'Broadcast', members
    )

    assert.deepEqual(delivered.sort(), ['agent-a', 'agent-b'])
    assert.deepEqual(pending, [])
    assert.deepEqual(failed, [])

    const msgsA = await readMailbox(TEST_TEAM, 'agent-a')
    const msgsB = await readMailbox(TEST_TEAM, 'agent-b')
    const msgsLead = await readMailbox(TEST_TEAM, 'team-lead')

    assert.equal(msgsA.length, 1)
    assert.equal(msgsB.length, 1)
    assert.equal(msgsLead.length, 0, 'Sender should not receive own broadcast')
  })

  it('enqueues every recipient instead of delivering when requires_approval=true', async () => {
    const members = [
      { name: 'team-lead', color: 'white' },
      { name: 'agent-a', color: 'red' },
      { name: 'agent-b', color: 'blue' },
    ]

    const { delivered, pending, failed } = await broadcastMessage(
      TEST_TEAM,
      'team-lead',
      'Needs approval',
      'approval broadcast',
      members,
      { requires_approval: true, orchestrator_session_id: 'orch_broadcast_001' },
    )

    assert.deepEqual(delivered, [])
    assert.deepEqual(failed, [])
    assert.equal(pending.length, 2)
    assert.deepEqual(pending.map(p => p.to).sort(), ['agent-a', 'agent-b'])

    const msgsA = await readMailbox(TEST_TEAM, 'agent-a')
    const msgsB = await readMailbox(TEST_TEAM, 'agent-b')
    assert.equal(msgsA.length, 0, 'agent-a must not receive unapproved broadcast')
    assert.equal(msgsB.length, 0, 'agent-b must not receive unapproved broadcast')

    const approvals = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(approvals.length, 2)
    assert.ok(approvals.every(a => a.message.orchestrator_session_id === 'orch_broadcast_001'))
  })
})

describe('clearMailbox', () => {
  it('removes all messages', async () => {
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Msg' })
    await clearMailbox(TEST_TEAM, 'agent-a')

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 0)
  })

  it('handles nonexistent inbox gracefully', async () => {
    await clearMailbox(TEST_TEAM, 'no-such-agent') // should not throw
  })
})

describe('capInboxMessages (per-item byte cap, handler layer)', () => {
  it('truncates oversized message body, keeps disk content unchanged', async () => {
    const big = 'X'.repeat(INBOX_PER_ITEM_BUDGET_BYTES * 2)
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: big })

    const unread = await readUnreadMessages(TEST_TEAM, 'agent-a')
    const cap = capInboxMessages(unread)
    assert.equal(cap.truncated, true)
    assert.equal(cap.truncatedCount, 1)
    assert.ok(cap.text.startsWith('[NOTICE:'), 'capped output must start with NOTICE')
    assert.ok(cap.afterBytes < cap.beforeBytes)

    const onDisk = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(onDisk[0].text, big, 'disk content must NOT be mutated by handler-layer truncate')
  })

  it('markMessagesAsRead is invoked normally even when per-item truncation fires (mark path unchanged)', async () => {
    const big = 'Y'.repeat(INBOX_PER_ITEM_BUDGET_BYTES * 2)
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: big })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'short' })

    const unread = await readUnreadMessages(TEST_TEAM, 'agent-a')
    capInboxMessages(unread)
    await markMessagesAsRead(TEST_TEAM, 'agent-a')

    const all = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(all.length, 2)
    assert.ok(all.every(m => m.read === true), 'all messages must be marked read regardless of truncation')
  })

  it('emitEvent("memory.capped", { layer: "inbox" }) fires when truncation happens', async () => {
    const events = []
    setProcessors([(span) => { if (span.name === 'memory.capped') events.push(span) }])
    try {
      const messages = [
        { from: 'bob', text: 'Z'.repeat(INBOX_PER_ITEM_BUDGET_BYTES * 3), timestamp: '2026-05-16T01:00:00Z', read: false },
      ]
      const cap = capInboxMessages(messages)
      assert.equal(cap.truncated, true)
      if (cap.truncated) {
        await emitEvent('memory.capped', {
          layer: 'inbox',
          items_truncated: cap.truncatedCount,
        })
      }
      assert.equal(events.length, 1)
      assert.equal(events[0].attrs.layer, 'inbox')
      assert.equal(events[0].attrs.items_truncated, 1)
    } finally {
      setProcessors([])
    }
  })
})

describe('corrupt inbox recovery', () => {
  it('recovers from corrupt JSON on read', async () => {
    const { getInboxPath, ensureDir, getInboxDir } = await import('../paths.js')
    await ensureDir(getInboxDir(TEST_TEAM))
    const inboxPath = getInboxPath(TEST_TEAM, 'agent-a')
    await writeFile(inboxPath, 'not json{{{')

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.deepEqual(messages, [], 'Should return empty on corrupt JSON')
  })

  it('recovers from corrupt JSON on write (overwrites with new message)', async () => {
    const { getInboxPath, ensureDir, getInboxDir } = await import('../paths.js')
    await ensureDir(getInboxDir(TEST_TEAM))
    const inboxPath = getInboxPath(TEST_TEAM, 'agent-a')
    await writeFile(inboxPath, 'corrupt data')

    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'Recovery msg' })

    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 1)
    assert.equal(messages[0].text, 'Recovery msg')
  })
})
