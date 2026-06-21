import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getItems, addItem, popItem, clearSession, countItems } from '../sessions.js'
import { markMessagesAsRead, readMailbox } from '../mailbox.js'
import { setProcessors } from '../tracing.js'
import { capSessionItems, SESSION_RETURN_BUDGET_BYTES } from '../index.js'

const TEST_TEAM = '__test-sessions__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-sessions')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([])
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => { await rm(TMP, { recursive: true, force: true }) })

describe('getItems', () => {
  it('returns full history including read messages', async () => {
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '1' })
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '2' })
    await markMessagesAsRead(TEST_TEAM, 'alice')
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '3' })

    const all = await getItems(TEST_TEAM, 'alice')
    assert.equal(all.length, 3)
    assert.equal(all[0].read, true)
    assert.equal(all[2].read, false)
  })

  it('respects limit option (returns last N)', async () => {
    for (let i = 0; i < 5; i++) await addItem(TEST_TEAM, 'alice', { from: 'lead', text: `msg-${i}` })
    const items = await getItems(TEST_TEAM, 'alice', { limit: 2 })
    assert.equal(items.length, 2)
    assert.equal(items[0].text, 'msg-3')
    assert.equal(items[1].text, 'msg-4')
  })

  it('filters unread_only', async () => {
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '1' })
    await markMessagesAsRead(TEST_TEAM, 'alice')
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '2' })
    const unread = await getItems(TEST_TEAM, 'alice', { unreadOnly: true })
    assert.equal(unread.length, 1)
    assert.equal(unread[0].text, '2')
  })

  it('filters by since timestamp', async () => {
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '1' })
    const mid = new Date(Date.now() + 1).toISOString()
    await new Promise(r => setTimeout(r, 5))
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '2' })
    const items = await getItems(TEST_TEAM, 'alice', { since: mid })
    assert.equal(items.length, 1)
    assert.equal(items[0].text, '2')
  })

  it('returns empty for nonexistent session', async () => {
    const items = await getItems(TEST_TEAM, 'ghost')
    assert.deepEqual(items, [])
  })
})

describe('popItem', () => {
  it('removes and returns the most recent item', async () => {
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: 'first' })
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: 'second' })

    const popped = await popItem(TEST_TEAM, 'alice')
    assert.equal(popped.text, 'second')
    const remaining = await getItems(TEST_TEAM, 'alice')
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0].text, 'first')
  })

  it('returns null on empty session', async () => {
    const popped = await popItem(TEST_TEAM, 'ghost')
    assert.equal(popped, null)
  })
})

describe('clearSession', () => {
  it('removes all items', async () => {
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '1' })
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '2' })
    await clearSession(TEST_TEAM, 'alice')
    const items = await getItems(TEST_TEAM, 'alice')
    assert.equal(items.length, 0)
  })
})

describe('countItems', () => {
  it('returns item count', async () => {
    assert.equal(await countItems(TEST_TEAM, 'alice'), 0)
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '1' })
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: '2' })
    assert.equal(await countItems(TEST_TEAM, 'alice'), 2)
  })
})

describe('capSessionItems (handler-layer byte cap)', () => {
  it('respects an explicit limit (no cap fire for small input)', async () => {
    for (let i = 0; i < 5; i++) await addItem(TEST_TEAM, 'alice', { from: 'lead', text: `m${i}` })
    const items = await getItems(TEST_TEAM, 'alice', { limit: 3 })
    const cap = capSessionItems(items)
    assert.equal(cap.truncated, false)
    assert.equal(cap.omittedCount, 0)
    assert.equal(cap.keptCount, 3)
  })

  it('drops oldest items when uncapped history exceeds the byte budget', async () => {
    const big = 'A'.repeat(8_000)
    for (let i = 0; i < 8; i++) {
      await addItem(TEST_TEAM, 'alice', { from: 'lead', text: big + ' #' + i })
    }
    const items = await getItems(TEST_TEAM, 'alice')
    const cap = capSessionItems(items)
    assert.equal(cap.truncated, true)
    assert.ok(cap.omittedCount > 0, `should drop at least one item, dropped ${cap.omittedCount}`)
    assert.ok(cap.afterBytes <= SESSION_RETURN_BUDGET_BYTES + 512, `after must fit budget (+notice), was ${cap.afterBytes}`)
    assert.ok(cap.text.startsWith('[NOTICE:'), 'capped output must lead with NOTICE')
  })

  it('truncates a single huge item without mutating disk content', async () => {
    const huge = 'B'.repeat(SESSION_RETURN_BUDGET_BYTES * 2)
    await addItem(TEST_TEAM, 'alice', { from: 'lead', text: huge })
    const items = await getItems(TEST_TEAM, 'alice')
    const cap = capSessionItems(items)
    assert.equal(cap.truncated, true)
    assert.ok(cap.afterBytes <= SESSION_RETURN_BUDGET_BYTES + 512)
    assert.ok(cap.text.startsWith('[NOTICE:'))

    const onDisk = await readMailbox(TEST_TEAM, 'alice')
    assert.equal(onDisk[0].text, huge, 'disk content must remain full-length after handler-layer truncate')
  })
})
