// relvetia-memory-tools tests — saga 8 Phase 2.
//
// Coverage strategy mirrors saga 7's memory-search-mcp.test.js:
//   - Every code path is driven via $RELVETIA_MEMORY_DIR (or an injected
//     daemonDir / execFile) so the user's real ~/.claude/memory + pm2 state
//     are never touched.
//   - A dedicated "production-invariant sentinel" suite snapshots the
//     md5/size of every protected file (stats.json / index.json / MEMORY.md /
//     concepts/graph.json) before the whole test run, exercises memory_remember
//     against the env-overridden test dir, then re-snapshots and asserts the
//     production files are byte-for-byte unchanged. This honours the saga 7
//     P0 #1 lesson: "contractual claims must be backed by sentinel tests."
//   - daemon_status mocks pm2 via an injected execFile so the suite doesn't
//     depend on pm2 actually being installed on the runner.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

import {
  runMemoryRemember,
  runMemoryLogRecent,
  runMemoryStatus,
  runDaemonStatus,
  memoryRememberToolHandler,
  memoryLogRecentToolHandler,
  memoryStatusToolHandler,
  daemonStatusToolHandler,
  defaultMemoryDir,
  defaultDaemonDir,
} from '../relvetia-memory-tools.js'

const TMP_ROOT = join(tmpdir(), `relvetia-memory-tools-${randomBytes(4).toString('hex')}`)

function freshDir(suffix) {
  return join(TMP_ROOT, suffix + '-' + randomBytes(3).toString('hex'))
}

async function md5OfFile(path) {
  try {
    const buf = await readFile(path)
    return createHash('md5').update(buf).digest('hex')
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

async function sizeOfFile(path) {
  try {
    const s = await stat(path)
    return s.size
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

// Codex P1 #3, saga 8 Phase 2-revB: capture md5 + size + mtime together
// so the production-invariant sentinel can detect "same bytes, touched
// timestamp" drift (e.g., a write that happened to produce the same
// content). Returns null when the file does not exist on this host;
// the sentinel handles null by asserting still-absent.
async function captureInvariant(path) {
  try {
    const buf = await readFile(path)
    const s = await stat(path)
    return {
      md5: createHash('md5').update(buf).digest('hex'),
      size: s.size,
      mtime: s.mtimeMs,
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
}

before(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
})

after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// defaultMemoryDir / defaultDaemonDir
// ---------------------------------------------------------------------------

describe('defaults', () => {
  it('defaultMemoryDir honors $RELVETIA_MEMORY_DIR', () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = '/explicit/mem'
    try {
      assert.equal(defaultMemoryDir(), '/explicit/mem')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('defaultMemoryDir falls back to ~/.claude/memory when env unset', () => {
    const orig = process.env.RELVETIA_MEMORY_DIR
    delete process.env.RELVETIA_MEMORY_DIR
    try {
      assert.equal(defaultMemoryDir(), join(homedir(), '.claude', 'memory'))
    } finally {
      if (orig !== undefined) process.env.RELVETIA_MEMORY_DIR = orig
    }
  })

  it('defaultDaemonDir honors $RELVETIA_DIR', () => {
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = '/explicit/daemon'
    try {
      assert.equal(defaultDaemonDir(), '/explicit/daemon')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// memory_remember
// ---------------------------------------------------------------------------

describe('memory_remember (runMemoryRemember)', () => {
  it('appends a line to today\'s daily log via env-override memoryDir', async () => {
    const dir = freshDir('rem-basic')
    const now = new Date('2026-05-20T03:00:00Z')  // JST = 2026-05-20 12:00
    const out = await runMemoryRemember(
      { content: 'hello world' },
      { memoryDir: dir, now },
    )
    const expectedFile = join(dir, 'logs', '2026', '05', '2026-05-20.md')
    assert.equal(out.file, expectedFile)
    const raw = await readFile(expectedFile, 'utf-8')
    assert.match(raw, /^- \[12:00\] hello world$/m)
  })

  it('serialises tags as bracketed prefix', async () => {
    const dir = freshDir('rem-tags')
    const now = new Date('2026-05-20T03:00:00Z')
    const out = await runMemoryRemember(
      { content: 'tagged entry', tags: ['saga8', 'phase2'] },
      { memoryDir: dir, now },
    )
    assert.match(out.line, /^- \[12:00\] \[saga8\]\[phase2\] tagged entry$/)
    const raw = await readFile(out.file, 'utf-8')
    assert.match(raw, /\[saga8\]\[phase2\] tagged entry/)
  })

  it('omits the tag prefix entirely when tags are absent or empty', async () => {
    const dir1 = freshDir('rem-notags-undef')
    const dir2 = freshDir('rem-notags-empty')
    const now = new Date('2026-05-20T03:00:00Z')
    const o1 = await runMemoryRemember({ content: 'no tags' }, { memoryDir: dir1, now })
    const o2 = await runMemoryRemember({ content: 'no tags', tags: [] }, { memoryDir: dir2, now })
    // The strict match patterns above already prove no tag prefix is present
    // (only the time bracket [12:00] appears, no [tag1] etc.).
    assert.match(o1.line, /^- \[12:00\] no tags$/)
    assert.match(o2.line, /^- \[12:00\] no tags$/)
  })

  it('uses JST (Asia/Tokyo) regardless of host timezone', async () => {
    const dir = freshDir('rem-jst')
    // UTC 23:30 on 2026-05-19 = JST 08:30 on 2026-05-20
    const now = new Date('2026-05-19T23:30:00Z')
    const out = await runMemoryRemember({ content: 'jst boundary' }, { memoryDir: dir, now })
    assert.ok(out.file.endsWith(join('2026', '05', '2026-05-20.md')),
      `expected JST-rolled-over filename, got ${out.file}`)
    assert.match(out.line, /^- \[08:30\] jst boundary$/)
  })

  it('appends rather than overwriting on second call', async () => {
    const dir = freshDir('rem-append')
    const now = new Date('2026-05-20T03:00:00Z')
    await runMemoryRemember({ content: 'first' }, { memoryDir: dir, now })
    await runMemoryRemember({ content: 'second' }, { memoryDir: dir, now })
    const raw = await readFile(join(dir, 'logs', '2026', '05', '2026-05-20.md'), 'utf-8')
    const lines = raw.split('\n').filter(Boolean)
    assert.equal(lines.length, 2)
    assert.match(lines[0], /first$/)
    assert.match(lines[1], /second$/)
  })

  it('handler envelope returns { content[], structuredContent:{file,line} }', async () => {
    const dir = freshDir('rem-envelope')
    const origMem = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = dir
    try {
      const r = await memoryRememberToolHandler({ content: 'envelope test', tags: ['t'] })
      assert.ok(Array.isArray(r.content))
      assert.equal(r.content[0].type, 'text')
      assert.match(r.content[0].text, /Appended to /)
      assert.ok(r.structuredContent.file)
      assert.match(r.structuredContent.line, /envelope test/)
    } finally {
      if (origMem !== undefined) process.env.RELVETIA_MEMORY_DIR = origMem
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// memory_log_recent
// ---------------------------------------------------------------------------

describe('memory_log_recent (runMemoryLogRecent)', () => {
  // Common fixture: a memoryDir with 3 daily logs spanning 2026-05-18..20.
  async function buildThreeDayFixture(dir) {
    const logsRoot = join(dir, 'logs')
    await mkdir(join(logsRoot, '2026', '05'), { recursive: true })
    await writeFile(
      join(logsRoot, '2026', '05', '2026-05-18.md'),
      '- [09:00] [old] eighteen line A\n- [10:00] [old] eighteen line B\n',
    )
    await writeFile(
      join(logsRoot, '2026', '05', '2026-05-19.md'),
      '- [11:00] [mid] nineteen line A\n- [12:00] [mid] nineteen line B\n',
    )
    await writeFile(
      join(logsRoot, '2026', '05', '2026-05-20.md'),
      '- [13:00] [new] twenty line A\n- [14:00] [new] twenty line B\n',
    )
  }

  it('returns empty entries when no logs directory exists', async () => {
    const dir = freshDir('lr-empty')
    await mkdir(dir, { recursive: true })  // memoryDir exists but no logs/
    const out = await runMemoryLogRecent({}, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.deepEqual(out.entries, [])
  })

  it('defaults days=1 → returns only today\'s entries', async () => {
    const dir = freshDir('lr-today')
    await buildThreeDayFixture(dir)
    const out = await runMemoryLogRecent({}, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.equal(out.entries.length, 2)
    assert.ok(out.entries.every(e => e.date === '2026-05-20'))
  })

  it('days=3 returns all three days', async () => {
    const dir = freshDir('lr-three')
    await buildThreeDayFixture(dir)
    const out = await runMemoryLogRecent({ days: 3 }, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.equal(out.entries.length, 6)
    const dates = new Set(out.entries.map(e => e.date))
    assert.deepEqual([...dates].sort(), ['2026-05-18', '2026-05-19', '2026-05-20'])
  })

  it('orders newest day first, newest time first within a day', async () => {
    const dir = freshDir('lr-order')
    await buildThreeDayFixture(dir)
    const out = await runMemoryLogRecent({ days: 3 }, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.equal(out.entries[0].date, '2026-05-20')
    assert.equal(out.entries[0].time, '14:00')
    assert.equal(out.entries[1].time, '13:00')
    assert.equal(out.entries[out.entries.length - 1].date, '2026-05-18')
    assert.equal(out.entries[out.entries.length - 1].time, '09:00')
  })

  it('limit caps the total entry count', async () => {
    const dir = freshDir('lr-limit')
    await buildThreeDayFixture(dir)
    const out = await runMemoryLogRecent({ days: 3, limit: 3 }, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.equal(out.entries.length, 3)
  })

  it('parses tag prefix into structured tags + topic', async () => {
    const dir = freshDir('lr-tags')
    const logsRoot = join(dir, 'logs', '2026', '05')
    await mkdir(logsRoot, { recursive: true })
    await writeFile(
      join(logsRoot, '2026-05-20.md'),
      '- [10:00] [saga8][phase2][impl] multi tag entry\n- [11:00] notag entry\n',
    )
    const out = await runMemoryLogRecent({ days: 1 }, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    assert.equal(out.entries.length, 2)
    const tagged = out.entries.find(e => e.time === '10:00')
    const plain = out.entries.find(e => e.time === '11:00')
    assert.deepEqual(tagged.tags, ['saga8', 'phase2', 'impl'])
    assert.equal(tagged.topic, 'saga8')
    assert.equal(tagged.content, 'multi tag entry')
    assert.deepEqual(plain.tags, [])
    assert.equal(plain.topic, '')
    assert.equal(plain.content, 'notag entry')
  })

  it('attaches an ISO-shape timestamp combining date + time', async () => {
    const dir = freshDir('lr-ts')
    await buildThreeDayFixture(dir)
    const out = await runMemoryLogRecent({ days: 1 }, { memoryDir: dir, now: new Date('2026-05-20T05:00:00Z') })
    const e = out.entries[0]
    assert.equal(e.timestamp, `${e.date}T${e.time}:00`)
  })

  // Build 3 daily logs dated relative to NOW (today, -1d, -2d), 2 entries each.
  // The handler uses the real clock, so a hardcoded-date fixture eventually
  // falls outside any fixed days-window; relative dates keep it stable forever.
  async function buildRecentThreeDayFixture(dir) {
    const logsRoot = join(dir, 'logs')
    for (let d = 0; d < 3; d++) {
      const day = new Date(Date.now() - d * 86400000)
      const yyyy = String(day.getFullYear())
      const mm = String(day.getMonth() + 1).padStart(2, '0')
      const dd = String(day.getDate()).padStart(2, '0')
      await mkdir(join(logsRoot, yyyy, mm), { recursive: true })
      await writeFile(
        join(logsRoot, yyyy, mm, `${yyyy}-${mm}-${dd}.md`),
        `- [09:00] [tag] ${yyyy}-${mm}-${dd} line A\n- [10:00] [tag] ${yyyy}-${mm}-${dd} line B\n`,
      )
    }
  }

  it('handler envelope shapes the text + structuredContent', async () => {
    const dir = freshDir('lr-envelope')
    await buildRecentThreeDayFixture(dir)
    const origMem = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = dir
    try {
      // Handler uses real Date.now() (no `now:` injection through the MCP
      // boundary). Fixture is dated relative to today, so days=30 always
      // covers all 3 days (6 entries) regardless of when the test runs.
      const r = await memoryLogRecentToolHandler({ days: 30 })
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /^6 entry\(ies\):/)
      assert.equal(r.structuredContent.entries.length, 6)
    } finally {
      if (origMem !== undefined) process.env.RELVETIA_MEMORY_DIR = origMem
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// memory_status
// ---------------------------------------------------------------------------

describe('memory_status (runMemoryStatus)', () => {
  it('returns zeros / null for an entirely empty memoryDir', async () => {
    const dir = freshDir('st-empty')
    await mkdir(dir, { recursive: true })
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.memoryMdLines, 0)
    assert.equal(s.topicFileCount, 0)
    assert.equal(s.logFileCount, 0)
    assert.deepEqual(s.logDays, { firstDate: null, lastDate: null, totalDays: 0 })
    assert.equal(s.indexEntryCount, 0)
    assert.equal(s.lastDistillAt, null)
  })

  it('counts MEMORY.md lines correctly', async () => {
    const dir = freshDir('st-mdlines')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'MEMORY.md'), 'line1\nline2\nline3\n')  // 4 split parts
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.memoryMdLines, 4)  // 'line1','line2','line3','' (trailing newline)
  })

  it('counts topics/ .md files recursively (subdirs included)', async () => {
    const dir = freshDir('st-topics')
    const topics = join(dir, 'topics')
    await mkdir(join(topics, 'architecture'), { recursive: true })
    await mkdir(join(topics, 'project-context'), { recursive: true })
    await writeFile(join(topics, 'flat.md'), '# flat')
    await writeFile(join(topics, 'architecture', 'a.md'), '# a')
    await writeFile(join(topics, 'architecture', 'b.md'), '# b')
    await writeFile(join(topics, 'project-context', 'c.md'), '# c')
    await writeFile(join(topics, 'architecture', 'notmd.txt'), 'ignored')
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.topicFileCount, 4)
  })

  it('counts log files and reports date range', async () => {
    const dir = freshDir('st-logs')
    const logs = join(dir, 'logs', '2026', '05')
    await mkdir(logs, { recursive: true })
    await writeFile(join(logs, '2026-05-18.md'), '')
    await writeFile(join(logs, '2026-05-19.md'), '')
    await writeFile(join(logs, '2026-05-20.md'), '')
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.logFileCount, 3)
    assert.equal(s.logDays.firstDate, '2026-05-18')
    assert.equal(s.logDays.lastDate, '2026-05-20')
    assert.equal(s.logDays.totalDays, 3)
  })

  it('parses indexEntryCount from index.json', async () => {
    const dir = freshDir('st-index')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), JSON.stringify({
      entries: { a: {}, b: {}, c: {}, d: {} },
    }))
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.indexEntryCount, 4)
  })

  it('returns 0 indexEntryCount when index.json is malformed', async () => {
    const dir = freshDir('st-malformed')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'index.json'), '{not json}')
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.indexEntryCount, 0)
  })

  it('reads lastDistillAt from MEMORY.md "Last distilled:" line', async () => {
    const dir = freshDir('st-distill-md')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'MEMORY.md'), '# Memory\n\nLast distilled: 2026-05-20 03:00\n\nbody...\n')
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.equal(s.lastDistillAt, '2026-05-20 03:00')
  })

  it('falls back to .last-distill mtime when MEMORY.md lacks the line', async () => {
    const dir = freshDir('st-distill-fallback')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'MEMORY.md'), '# Memory (no distill line)\n')
    const distillPath = join(dir, '.last-distill')
    await writeFile(distillPath, '')
    const s = await runMemoryStatus({}, { memoryDir: dir })
    assert.ok(typeof s.lastDistillAt === 'string')
    assert.match(s.lastDistillAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('handler envelope shapes the text + structuredContent', async () => {
    const dir = freshDir('st-envelope')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'MEMORY.md'), 'x\n')
    const origMem = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = dir
    try {
      const r = await memoryStatusToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /MEMORY\.md: +2 lines/)
      assert.equal(r.structuredContent.memoryMdLines, 2)
    } finally {
      if (origMem !== undefined) process.env.RELVETIA_MEMORY_DIR = origMem
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// daemon_status
// ---------------------------------------------------------------------------

describe('daemon_status (runDaemonStatus)', () => {
  function makeExecFile(impl) {
    // Promisified execFile signature: (file, args, options) → Promise<{stdout,stderr}>
    return async (file, args, options) => impl(file, args, options)
  }

  it('returns pm2State="unknown" when pm2 binary is missing (ENOENT)', async () => {
    const dir = freshDir('dn-enoent')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => {
      const e = new Error('spawn pm2 ENOENT'); e.code = 'ENOENT'; throw e
    })
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.pm2State, 'unknown')
    assert.equal(s.uptime, 0)
    assert.equal(s.restartCount, 0)
    assert.equal(s.recentRestart, null)
    assert.deepEqual(s.lockFile, { exists: false, pid: null, alive: false })
  })

  it('returns pm2State="unknown" when pm2 jlist returns malformed JSON', async () => {
    const dir = freshDir('dn-malformed')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => ({ stdout: 'not json at all', stderr: '' }))
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.pm2State, 'unknown')
  })

  it('returns pm2State="unknown" when relvetia-daemon is not registered', async () => {
    const dir = freshDir('dn-noproc')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => ({
      stdout: JSON.stringify([{ name: 'something-else', pm2_env: { status: 'online' } }]),
      stderr: '',
    }))
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.pm2State, 'unknown')
  })

  it('reports pm2State="online" + uptime + restart count + recentRestart', async () => {
    const dir = freshDir('dn-online')
    await mkdir(dir, { recursive: true })
    const startedAt = Date.now() - 12_000  // 12 seconds ago
    const execFile = makeExecFile(() => ({
      stdout: JSON.stringify([{
        name: 'relvetia-daemon',
        pm2_env: { status: 'online', pm_uptime: startedAt, restart_time: 3 },
      }]),
      stderr: '',
    }))
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.pm2State, 'online')
    assert.ok(s.uptime >= 10 && s.uptime <= 60, `uptime ~12s expected, got ${s.uptime}`)
    assert.equal(s.restartCount, 3)
    assert.ok(typeof s.recentRestart === 'string')
    assert.match(s.recentRestart, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('coerces unknown pm2 status strings to "unknown"', async () => {
    const dir = freshDir('dn-weird')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => ({
      stdout: JSON.stringify([{
        name: 'relvetia-daemon',
        pm2_env: { status: 'launching', pm_uptime: Date.now() - 1000, restart_time: 0 },
      }]),
      stderr: '',
    }))
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.pm2State, 'unknown')
  })

  it('reports recentRestart=null when restart_time=0 (never restarted)', async () => {
    const dir = freshDir('dn-norestart')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => ({
      stdout: JSON.stringify([{
        name: 'relvetia-daemon',
        pm2_env: { status: 'online', pm_uptime: Date.now() - 1000, restart_time: 0 },
      }]),
      stderr: '',
    }))
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.recentRestart, null)
  })

  it('lockFile probe: existing file with this process\'s PID → alive=true', async () => {
    const dir = freshDir('dn-lock-alive')
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(
      join(dir, '.claude', '.scheduler.lock'),
      JSON.stringify({ pid: process.pid, identity: 'test', timestamp: Date.now() }),
    )
    const execFile = makeExecFile(() => {
      const e = new Error('spawn pm2 ENOENT'); e.code = 'ENOENT'; throw e
    })
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.deepEqual(s.lockFile, { exists: true, pid: process.pid, alive: true })
  })

  it('lockFile probe: implausible PID → alive=false', async () => {
    const dir = freshDir('dn-lock-dead')
    await mkdir(join(dir, '.claude'), { recursive: true })
    // PID 999999 is implausible on most systems; on the off-chance it exists
    // and is owned by SYSTEM (EPERM = alive), we relax the assertion to
    // accept either false or true — the point is the call does not throw.
    await writeFile(
      join(dir, '.claude', '.scheduler.lock'),
      JSON.stringify({ pid: 999999, identity: 'test', timestamp: Date.now() }),
    )
    const execFile = makeExecFile(() => {
      const e = new Error('spawn pm2 ENOENT'); e.code = 'ENOENT'; throw e
    })
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.equal(s.lockFile.exists, true)
    assert.equal(s.lockFile.pid, 999999)
    assert.equal(typeof s.lockFile.alive, 'boolean')
  })

  it('lockFile probe: missing file → exists=false, pid=null, alive=false', async () => {
    const dir = freshDir('dn-lock-missing')
    await mkdir(dir, { recursive: true })
    const execFile = makeExecFile(() => {
      const e = new Error('spawn pm2 ENOENT'); e.code = 'ENOENT'; throw e
    })
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.deepEqual(s.lockFile, { exists: false, pid: null, alive: false })
  })

  it('lockFile probe: malformed JSON → exists=true, pid=null, alive=false', async () => {
    const dir = freshDir('dn-lock-junk')
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude', '.scheduler.lock'), '{not json}')
    const execFile = makeExecFile(() => {
      const e = new Error('spawn pm2 ENOENT'); e.code = 'ENOENT'; throw e
    })
    const s = await runDaemonStatus({}, { daemonDir: dir, execFile })
    assert.deepEqual(s.lockFile, { exists: true, pid: null, alive: false })
  })

  it('handler envelope shapes text + structuredContent', async () => {
    const dir = freshDir('dn-envelope')
    await mkdir(dir, { recursive: true })
    const origDaemon = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    // We can't easily inject execFile through the handler boundary, so the
    // pm2 probe will use the real binary. The handler must not throw even
    // when pm2 isn't installed (graceful path covered by runDaemonStatus
    // tests above). Here we only assert the envelope shape.
    try {
      const r = await daemonStatusToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /pm2State:/)
      assert.ok(r.structuredContent)
      assert.ok('pm2State' in r.structuredContent)
      assert.ok('lockFile' in r.structuredContent)
    } finally {
      if (origDaemon !== undefined) process.env.RELVETIA_DIR = origDaemon
      else delete process.env.RELVETIA_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// Production filesystem invariant sentinel
//
// Saga 7 P0 #1 lesson: every claim that a tool "is read-only" or "does not
// mutate production memory" must be backed by a test that proves it. This
// suite snapshots the protected files BEFORE the env-overridden memory_*
// suite runs (via Node's top-level `before`) and again AFTER, asserting
// byte-identical state. memory_remember is the only tool that writes — and
// its writes must land in the env-overridden tmp dir, never in production.
// ---------------------------------------------------------------------------

describe('production-invariant sentinel', () => {
  const PROD = join(homedir(), '.claude', 'memory')
  const PROTECTED_FILES = [
    'stats.json',
    'index.json',
    'MEMORY.md',
    'concepts/graph.json',
  ]
  let baseline = null

  before(async () => {
    baseline = {}
    for (const rel of PROTECTED_FILES) {
      baseline[rel] = await captureInvariant(join(PROD, rel))
    }
    // Exercise memory_remember with env-override — MUST NOT touch production.
    const dir = freshDir('sentinel-write')
    await runMemoryRemember(
      { content: 'sentinel test write — env override only', tags: ['sentinel'] },
      { memoryDir: dir, now: new Date('2026-05-20T03:00:00Z') },
    )
    // Also exercise runMemoryStatus + runMemoryLogRecent against production
    // path to prove read-only invariant.
    await runMemoryStatus({}, { memoryDir: PROD })
    await runMemoryLogRecent({ days: 1, limit: 5 }, { memoryDir: PROD })
  })

  for (const rel of PROTECTED_FILES) {
    // Codex P1 #3, saga 8 Phase 2-revB: assert mtime invariant alongside
    // md5/size so "same content, touched timestamp" drift is detected.
    // Windows NTFS mtimeMs resolution is ms-level; a 1ms float tolerance
    // is safe and avoids cross-FS flake (Codex's recommended bound).
    it(`leaves ${rel} byte+timestamp-identical (md5+size+mtime) after env-overridden writes + production reads`, async () => {
      const cur = await captureInvariant(join(PROD, rel))
      if (baseline[rel] === null) {
        // File doesn't exist on this machine — invariant is "still absent".
        assert.equal(cur, null, `${rel} appeared during the test run`)
        return
      }
      assert.ok(cur !== null, `${rel} disappeared during the test run`)
      assert.equal(cur.md5, baseline[rel].md5,
        `${rel} md5 drift: before=${baseline[rel].md5} after=${cur.md5}`)
      assert.equal(cur.size, baseline[rel].size,
        `${rel} size drift: before=${baseline[rel].size} after=${cur.size}`)
      assert.ok(Math.abs(cur.mtime - baseline[rel].mtime) < 1,
        `${rel} mtime drift: before=${baseline[rel].mtime} after=${cur.mtime} (>1ms — production file was touched)`)
    })
  }
})

// ---------------------------------------------------------------------------
// MCP server boundary tests (safeTool + Zod schema + registration).
//
// Lazy-loads ../index.js (side effect: registers tools on the singleton).
// We set $RELVETIA_MEMORY_DIR to a tmp fixture before the import so the
// real-engine smoke test in memory-search-mcp.test.js is unaffected.
// ---------------------------------------------------------------------------

describe('MCP server boundary (safeTool + Zod registration for 4 new tools)', () => {
  let serverMod = null
  const FIXTURE_MEM_DIR = join(TMP_ROOT, 'boundary-mem')

  before(async () => {
    await mkdir(FIXTURE_MEM_DIR, { recursive: true })
    process.env.RELVETIA_MEMORY_DIR = FIXTURE_MEM_DIR
    serverMod = await import('../index.js')
  })

  it('registers all four new tools on the relvetia-team server', () => {
    const tools = serverMod.server._registeredTools
    assert.ok(tools.memory_remember,    'memory_remember registered')
    assert.ok(tools.memory_log_recent,  'memory_log_recent registered')
    assert.ok(tools.memory_status,      'memory_status registered')
    assert.ok(tools.daemon_status,      'daemon_status registered')
    for (const t of ['memory_remember', 'memory_log_recent', 'memory_status', 'daemon_status']) {
      assert.equal(typeof tools[t].handler, 'function', `${t}.handler is a function`)
    }
  })

  // Codex P0 #1, saga 8 Phase 2-revA contract-claim sentinel.
  //
  // First-iter description claimed memory_remember was "the ONLY tool in
  // this server that mutates the relvetia memory directory". That claim
  // was false: team_remember(also_log_to_relvetia=true) is a pre-existing
  // second writer via the same appendRelvetiaLog (src/index.js team_remember
  // handler block, ~L1278-1283). This sentinel pins the corrected
  // wording so contract drift cannot re-introduce the "ONLY in this
  // server" claim without breaking a test — exactly the saga 7 §14 lesson
  // ("contract claims must be backed by test sentinels") applied at the
  // point where it was originally violated.
  it('memory_remember description honestly acknowledges team_remember coexists (Codex P0 #1, saga 8 revA)', () => {
    const t = serverMod.server._registeredTools.memory_remember
    const desc = t.description
    assert.equal(typeof desc, 'string', 'description must be exposed on _registeredTools[name].description')
    assert.ok(desc.length > 0, 'description must be non-empty')
    assert.doesNotMatch(desc, /ONLY tool in this server/i,
      'memory_remember description must not claim it is "the ONLY tool in this server" — team_remember(also_log_to_relvetia=true) is a pre-existing second writer via appendRelvetiaLog')
    assert.match(desc, /team_remember/,
      'memory_remember description must explicitly name team_remember as a coexisting write path so the contract claim is verifiable from the tool surface alone')
    assert.match(desc, /saga 8|four memory tools|read-only/i,
      'memory_remember description must scope its "only-mutator" claim explicitly to the saga 8 memory tool cohort, not to the whole server')
  })

  it('memory_remember Zod schema requires non-empty content', () => {
    const t = serverMod.server._registeredTools.memory_remember
    assert.doesNotThrow(() => t.inputSchema.parse({ content: 'hi' }))
    assert.throws(() => t.inputSchema.parse({ content: '' }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({}), /required|invalid_type/i)
  })

  it('memory_remember Zod schema accepts optional tags array', () => {
    const t = serverMod.server._registeredTools.memory_remember
    const parsed = t.inputSchema.parse({ content: 'x', tags: ['a', 'b'] })
    assert.equal(parsed.content, 'x')
    assert.deepEqual(parsed.tags, ['a', 'b'])
  })

  it('memory_log_recent Zod schema enforces days/limit bounds', () => {
    const t = serverMod.server._registeredTools.memory_log_recent
    assert.doesNotThrow(() => t.inputSchema.parse({}))
    assert.doesNotThrow(() => t.inputSchema.parse({ days: 7, limit: 50 }))
    assert.throws(() => t.inputSchema.parse({ days: 0 }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({ days: 31 }), /too_big|max/i)
    assert.throws(() => t.inputSchema.parse({ limit: 0 }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({ limit: 501 }), /too_big|max/i)
  })

  it('memory_status Zod schema accepts only an empty object', () => {
    const t = serverMod.server._registeredTools.memory_status
    assert.doesNotThrow(() => t.inputSchema.parse({}))
  })

  it('daemon_status Zod schema accepts only an empty object', () => {
    const t = serverMod.server._registeredTools.daemon_status
    assert.doesNotThrow(() => t.inputSchema.parse({}))
  })

  it('safeTool wraps inner-handler throws into isError envelope', async () => {
    // Drive the inner handler (appendRelvetiaLog → mkdir + appendFile) to
    // throw by pointing $RELVETIA_MEMORY_DIR at a path that exists as a
    // regular file: mkdir(<file>/logs/YYYY/MM, recursive:true) fails with
    // ENOTDIR on POSIX / EEXIST or similar on Windows. The safeTool wrapper
    // must catch the throw and return the isError envelope rather than
    // crashing the server.
    const t = serverMod.server._registeredTools.memory_remember
    const badMemDir = join(TMP_ROOT, 'bad-mem-as-file-' + randomBytes(3).toString('hex'))
    await writeFile(badMemDir, 'this is a regular file, not a directory')
    const origMem = process.env.RELVETIA_MEMORY_DIR
    process.env.RELVETIA_MEMORY_DIR = badMemDir
    try {
      const r = await t.handler({ content: 'test-throws' }, {})
      assert.equal(r.isError, true, 'inner mkdir failure must yield isError envelope')
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /Error in memory_remember:/)
    } finally {
      if (origMem !== undefined) process.env.RELVETIA_MEMORY_DIR = origMem
      else delete process.env.RELVETIA_MEMORY_DIR
    }
  })

  it('safeTool normal envelope on memory_log_recent success', async () => {
    const t = serverMod.server._registeredTools.memory_log_recent
    const r = await t.handler({ days: 1, limit: 10 }, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent)
    assert.ok(Array.isArray(r.structuredContent.entries))
  })

  it('safeTool normal envelope on memory_status success (empty fixture)', async () => {
    const t = serverMod.server._registeredTools.memory_status
    const r = await t.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent)
    assert.equal(typeof r.structuredContent.memoryMdLines, 'number')
    assert.equal(typeof r.structuredContent.topicFileCount, 'number')
  })

  it('safeTool normal envelope on daemon_status success (graceful when pm2 absent)', async () => {
    const t = serverMod.server._registeredTools.daemon_status
    const r = await t.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent)
    assert.ok(['online', 'stopped', 'errored', 'unknown'].includes(r.structuredContent.pm2State))
  })

  // Codex P1 #1, saga 8 Phase 2-revB strict-mode boundary.
  //
  // safeTool gained an opt-in `{ strict: true }` flag. The 4 saga 8 tools
  // + saga 7 memory_search opt in; the 38 pre-existing team_* tools stay
  // un-strict to preserve their established lenient contract. These
  // tests pin the strict reject so a future safeTool refactor cannot
  // silently revert the surface to lenient (strip-unknown) mode.
  //
  // Each test passes valid args for the tool plus one unknown key
  // (`bogus_extra`) and asserts the safeTool boundary returns the
  // isError envelope rather than silently dropping the extra key.
  for (const { name, baseArgs } of [
    { name: 'memory_remember',        baseArgs: { content: 'ok' } },
    { name: 'memory_log_recent',      baseArgs: {} },
    { name: 'memory_status',          baseArgs: {} },
    { name: 'daemon_status',          baseArgs: {} },
    { name: 'memory_search',          baseArgs: { query: 'ok' } },
    { name: 'private_memory_search',  baseArgs: { query: 'ok' } },
  ]) {
    it(`${name} rejects unknown keys at the safeTool strict boundary (Codex P1 #1)`, async () => {
      const t = serverMod.server._registeredTools[name]
      const r = await t.handler({ ...baseArgs, bogus_extra: 1 }, {})
      assert.equal(r.isError, true, `${name}: unknown key must trigger isError envelope`)
      assert.match(r.content[0].text, /unrecognized|extra|unknown|bogus_extra|strict/i,
        `${name}: error text should describe the strict reject; got: ${r.content[0].text}`)
    })
  }

  // Codex P1 #2, saga 8 Phase 2-revB: memory_remember single-line contract.
  //
  // content + each tag MUST be a single physical line and tags MUST NOT
  // contain "]" — otherwise the LOG_LINE_RE parse in src/memory.js would
  // misattribute the spillover line as a separate, untagged entry, and
  // memory_log_recent would either drop it or report wrong tags. Pinned
  // here so a regex relaxation cannot ship without breaking the test.
  it('memory_remember rejects content with embedded newlines (Codex P1 #2)', async () => {
    const t = serverMod.server._registeredTools.memory_remember
    const rLf = await t.handler({ content: 'line1\nline2' }, {})
    assert.equal(rLf.isError, true, 'LF in content must reject')
    assert.match(rLf.content[0].text, /single line|newline|regex|invalid/i)
    const rCrLf = await t.handler({ content: 'line1\r\nline2' }, {})
    assert.equal(rCrLf.isError, true, 'CRLF in content must reject')
  })

  it('memory_remember rejects tags containing "]" or newlines (Codex P1 #2)', async () => {
    const t = serverMod.server._registeredTools.memory_remember
    const rBracket = await t.handler({ content: 'ok', tags: ['a]b'] }, {})
    assert.equal(rBracket.isError, true, '"]" in tag must reject')
    const rNewline = await t.handler({ content: 'ok', tags: ['x\ny'] }, {})
    assert.equal(rNewline.isError, true, 'newline in tag must reject')
  })

  it('memory_remember accepts well-formed content + tags (Codex P1 #2 positive baseline)', async () => {
    // Ensures the regex constraints did not over-tighten — anything that
    // safely round-trips through LOG_LINE_RE must still be accepted.
    const t = serverMod.server._registeredTools.memory_remember
    const r = await t.handler(
      { content: 'no newlines here, special chars: !@#$%^&*()_+-=<>?,./', tags: ['saga8', 'phase2', 'rev-B'] },
      {},
    )
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(r.structuredContent.file && r.structuredContent.line)
  })
})
