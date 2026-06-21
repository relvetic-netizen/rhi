import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { runGuardrails, _clearGuardrailCache } from '../guardrails.js'
import { writeToMailbox, readMailbox, readUnreadMessages } from '../mailbox.js'
import { getTeamDir } from '../paths.js'
import { setProcessors } from '../tracing.js'

const TEST_TEAM = '__test-guardrails__'
const origDir = process.env.CLAUDE_CONFIG_DIR
const TMP = join(process.cwd(), '.test-tmp-guardrails')

before(() => {
  process.env.CLAUDE_CONFIG_DIR = TMP
  setProcessors([]) // silence trace file writes during guardrail tests
})
after(async () => {
  if (origDir) process.env.CLAUDE_CONFIG_DIR = origDir
  else delete process.env.CLAUDE_CONFIG_DIR
  await rm(TMP, { recursive: true, force: true })
})
beforeEach(async () => {
  await rm(TMP, { recursive: true, force: true })
  // rm deletes the file on disk but the in-memory configCache (keyed by team
  // name, invalidated by mtimeMs) survives. On Windows, mtime granularity is
  // coarser than the gap between test writes, so the next writeConfig may
  // produce an identical mtimeMs → cache returns stale config from prior test.
  _clearGuardrailCache(TEST_TEAM)
})

async function writeConfig(config) {
  await mkdir(getTeamDir(TEST_TEAM), { recursive: true })
  await writeFile(
    join(getTeamDir(TEST_TEAM), 'guardrails.json'),
    JSON.stringify(config, null, 2)
  )
}

describe('runGuardrails', () => {
  it('passes through when no config exists', async () => {
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'hi' })
    assert.equal(result.tripwire, false)
    assert.equal(result.message.text, 'hi')
  })

  it('blocks on max_length with action=block', async () => {
    await writeConfig({ input: [{ type: 'max_length', limit: 5, action: 'block' }] })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'way too long' })
    assert.equal(result.tripwire, true)
    assert.match(result.reason, /exceeds 5 chars/)
  })

  it('truncates on max_length with action=truncate', async () => {
    await writeConfig({ input: [{ type: 'max_length', limit: 5, action: 'truncate' }] })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: '1234567890' })
    assert.equal(result.tripwire, false)
    assert.ok(result.message.text.startsWith('12345'))
    assert.match(result.message.text, /truncated/)
  })

  it('blocks on blocklist substring match', async () => {
    await writeConfig({
      input: [{ type: 'blocklist', patterns: ['secret'], mode: 'substring', action: 'block' }],
    })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'this is SECRET info' })
    assert.equal(result.tripwire, true)
  })

  it('redacts on blocklist with action=redact', async () => {
    await writeConfig({
      input: [{ type: 'blocklist', patterns: ['password'], mode: 'substring', action: 'redact' }],
    })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'my password is hunter2' })
    assert.equal(result.tripwire, false)
    assert.match(result.message.text, /\[REDACTED\]/)
  })

  it('enforces required_from allowlist', async () => {
    await writeConfig({
      input: [{ type: 'required_from', allowed: ['team-lead'], action: 'block' }],
    })
    const denied = await runGuardrails(TEST_TEAM, 'input', { from: 'stranger', text: 'hi' })
    assert.equal(denied.tripwire, true)
    const allowed = await runGuardrails(TEST_TEAM, 'input', { from: 'team-lead', text: 'hi' })
    assert.equal(allowed.tripwire, false)
  })

  it('short-circuits on first tripwire and skips later rules', async () => {
    await writeConfig({
      input: [
        { type: 'max_length', limit: 5, action: 'block' },
        { type: 'blocklist', patterns: ['never-checked'], mode: 'substring', action: 'block' },
      ],
    })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'too long text' })
    assert.equal(result.tripwire, true)
    assert.match(result.reason, /exceeds/)
  })

  it('skips rules with enabled=false', async () => {
    await writeConfig({
      input: [{ type: 'max_length', limit: 5, action: 'block', enabled: false }],
    })
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'a', text: 'long enough' })
    assert.equal(result.tripwire, false)
  })
})

describe('writeToMailbox with guardrails', () => {
  it('blocks message that trips input guardrail', async () => {
    await writeConfig({ input: [{ type: 'max_length', limit: 3, action: 'block' }] })
    const result = await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'hello' })
    assert.equal(result.blocked, true)
    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 0)
  })

  it('redirects blocked message when redirect_to is set', async () => {
    await writeConfig({
      input: [{ type: 'max_length', limit: 3, action: 'block', redirect_to: 'team-lead' }],
    })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'stranger', text: 'hello' })

    const targetMsgs = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(targetMsgs.length, 0, 'Target should not receive blocked message')

    const leadMsgs = await readMailbox(TEST_TEAM, 'team-lead')
    assert.equal(leadMsgs.length, 1)
    assert.equal(leadMsgs[0].from, 'guardrail')
    assert.match(leadMsgs[0].text, /Blocked message from stranger/)
  })

  it('allows message with no guardrails', async () => {
    const result = await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'hello' })
    assert.equal(result.blocked, false)
    const messages = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(messages.length, 1)
  })
})

describe('readUnreadMessages with output guardrails', () => {
  it('replaces tripped messages with placeholder on read', async () => {
    // Write a benign message first (no guardrails yet)
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'lead', text: 'my secret info' })

    // Then install an output guardrail
    await writeConfig({
      output: [{ type: 'blocklist', patterns: ['secret'], mode: 'substring', action: 'block' }],
    })

    const unread = await readUnreadMessages(TEST_TEAM, 'agent-a')
    assert.equal(unread.length, 1)
    assert.match(unread[0].text, /blocked by output guardrail/)
  })
})

describe('auto_require_approval guardrail', () => {
  it('routes substring-matching messages to approval queue instead of inbox', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'substring', patterns: ['rm -rf', 'DROP TABLE'] },
        approval_kind: 'sensitive_command',
      }],
    })
    const { listApprovals } = await import('../approvals.js')

    const result = await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'researcher',
      text: 'Please run: rm -rf /tmp/cache to clean up',
    })

    assert.equal(result.blocked, false)
    assert.equal(result.auto_approval, true)
    assert.ok(result.pending_approval_id)
    assert.match(result.reason, /rm -rf/)

    const inbox = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(inbox.length, 0, 'recipient should not see the message yet')

    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].kind, 'sensitive_command')
    assert.equal(pending[0].to, 'agent-a')
    assert.match(pending[0].metadata?.auto_approval_reason || '', /rm -rf/)
  })

  it('does not stack with explicit requires_approval=true on the same message', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'substring', patterns: ['secret'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')

    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'researcher',
      text: 'has the secret token',
      requires_approval: true,
    })

    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1, 'exactly one approval queued')
  })

  it('passes through when match does not fire', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'substring', patterns: ['DELETE FROM'] },
      }],
    })
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'researcher',
      text: 'looks good to me',
    })
    const inbox = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].text, 'looks good to me')
  })

  it('regex mode supports compiled patterns', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns: ['eval\\s*\\(', 'exec\\s*\\('] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'r', text: 'consider using eval(input) here',
    })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
  })

  it('min_length matcher fires for long messages', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { min_length: 100 },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'r', text: 'x'.repeat(200),
    })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
  })

  it('from_not_in matcher fires when sender not on trusted list', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { from_not_in: ['team-lead', 'trusted-agent'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'unknown-agent', text: 'hi',
    })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)

    // trusted sender — passes through
    await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'team-lead', text: 'hi',
    })
    const stillOne = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(stillOne.length, 1)
  })

  it('rejects empty substring patterns (would silent-match every message)', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'substring', patterns: ['', 'real-pattern'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    // Message that does NOT contain "real-pattern" must NOT match the empty
    // pattern (which would otherwise be matched by `''.includes('')`).
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'hello world' })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'empty substring pattern must not act as match-all')

    // Message containing the real pattern still matches.
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'has real-pattern here' })
    const stillFires = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(stillFires.length, 1)
  })

  it('rejects empty regex patterns at compile time', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns: ['', 'eval\\s*\\('] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'innocent text' })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'empty regex pattern must not act as match-all')
  })

  it('treats min_length:0 / negative as disabled (no silent match-all)', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { min_length: 0 },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: '' })
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'short msg' })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'min_length:0 must not match every message')
  })

  it('from_not_in flags messages whose sender is missing entirely', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { from_not_in: ['team-lead', 'trusted'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    // Sender-missing message must NOT bypass the allowlist.
    await writeToMailbox(TEST_TEAM, 'agent-a', { text: 'no sender field' })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 1)
    assert.match(
      pending[0].metadata?.auto_approval_reason || '',
      /sender missing|not in trusted/
    )
  })

  it('regex matcher is RE2-backed: catastrophic-backtracking pattern returns quickly', async () => {
    // ^(a+)+$ on a near-match input is a classic ReDoS — JS RegExp would
    // hang for tens of seconds on a 50K char input. RE2 is linear-time
    // and must return in well under a second even with a 1s ceiling.
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns: ['^(a+)+$'] },
      }],
    })
    const evilInput = 'a'.repeat(50000) + '!'
    const start = Date.now()
    const result = await runGuardrails(TEST_TEAM, 'input', { from: 'r', text: evilInput })
    const elapsed = Date.now() - start
    assert.equal(result.tripwire, false)
    // Pattern must NOT have matched (the trailing '!' breaks the anchor).
    assert.equal(result.message.requires_approval, undefined)
    assert.ok(elapsed < 1000, `RE2 path must stay under 1s on ReDoS input (got ${elapsed}ms)`)
  })

  it('regex pattern array length is capped', async () => {
    const { MAX_AUTO_APPROVAL_PATTERNS } = await import('../guardrails.js')
    // Use anchored patterns so e.g. `^uniq-5$` is NOT a prefix of `^uniq-51$`
    // (otherwise the substring containment would mask the cap behavior).
    const patterns = Array.from(
      { length: MAX_AUTO_APPROVAL_PATTERNS + 5 },
      (_, i) => `^uniq-${i}$`
    )
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    // Index beyond cap — body is exactly the anchored target so only the
    // beyond-cap pattern would match if it were compiled.
    const beyondIdx = MAX_AUTO_APPROVAL_PATTERNS + 1
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: `uniq-${beyondIdx}` })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'pattern beyond the cap must not have been compiled')

    // First pattern still works.
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'uniq-0' })
    const stillFires = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(stillFires.length, 1, 'patterns within the cap must still match')
  })

  it('individual regex pattern length is capped', async () => {
    const { MAX_AUTO_APPROVAL_PATTERN_LENGTH } = await import('../guardrails.js')
    const tooLong = 'a'.repeat(MAX_AUTO_APPROVAL_PATTERN_LENGTH + 1)
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns: [tooLong, 'short-pat'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    // Build a message that the over-length pattern WOULD have matched if compiled.
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: tooLong })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'over-length pattern must have been skipped')

    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: 'has short-pat' })
    const stillFires = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(stillFires.length, 1)
  })

  it('regex matcher skips inputs longer than the text cap', async () => {
    const { MAX_AUTO_APPROVAL_TEXT_LENGTH } = await import('../guardrails.js')
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'regex', patterns: ['boom'] },
      }],
    })
    const { listApprovals } = await import('../approvals.js')
    // Input includes the trigger but exceeds the text cap.
    const oversized = 'x'.repeat(MAX_AUTO_APPROVAL_TEXT_LENGTH + 1) + 'boom'
    await writeToMailbox(TEST_TEAM, 'agent-a', { from: 'r', text: oversized })
    const pending = await listApprovals(TEST_TEAM, { status: 'pending' })
    assert.equal(pending.length, 0, 'oversized inputs must skip regex matching')
  })

  it('approving the auto-flagged message delivers it to the recipient', async () => {
    await writeConfig({
      input: [{
        type: 'auto_require_approval',
        match: { mode: 'substring', patterns: ['production'] },
      }],
    })
    const { listApprovals, decide } = await import('../approvals.js')
    const result = await writeToMailbox(TEST_TEAM, 'agent-a', {
      from: 'r', text: 'deploy to production cluster',
    })
    assert.ok(result.pending_approval_id)

    // Simulate team-lead approving and re-delivering with skipApproval.
    const ap = (await listApprovals(TEST_TEAM, { status: 'pending' }))[0]
    await decide(TEST_TEAM, ap.id, 'approved', { approver: 'team-lead' })
    await writeToMailbox(TEST_TEAM, ap.to, ap.message, {
      skipApproval: true, skipGuardrails: true,
    })

    const inbox = await readMailbox(TEST_TEAM, 'agent-a')
    assert.equal(inbox.length, 1)
    assert.match(inbox[0].text, /production/)
  })
})
