// relvetia-admin-tools tests — saga 9 Phase 3.
//
// Coverage strategy mirrors saga 7 + saga 8:
//   - Every code path drives via $RELVETIA_DIR override (and
//     $RELVETIA_WALKER_SCHEDULE_PATH for walker_status) so the user's real
//     ~/.claude/relvetia/.claude/scheduled_tasks.json and persona walker
//     schedule are never touched. The user's production memory dir
//     (~/.claude/memory) is also never read or written by any of the six
//     admin tools — verified by the production-invariant sentinel below.
//   - The production-invariant sentinel (md5 + size + mtime) snapshots the
//     four protected files before exercising every admin tool against
//     env-overridden state, then re-snapshots and asserts byte+timestamp
//     identity. This honours the saga 8 §16 lesson ("production filesystem
//     invariant evidence is benchmark/test harness auto-capture, mtime+
//     size+md5 3 軸 mandate").
//   - Contract-claim sentinels at the MCP boundary pin every "read-only" /
//     "only mutates scheduled_tasks.json" / "refuses permanent task" /
//     "does NOT spawn subprocess" claim made in the tool descriptions. This
//     honours the saga 7 §14 + saga 8 §17 lesson ("contract claims must be
//     backed by sentinel tests; existing call graph must be grep-verified
//     before authoring contractual language").

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import {
  runDistillMarkFired,
  runDistillStatus,
  runWalkerStatus,
  runScheduledTaskList,
  runScheduledTaskCreate,
  runScheduledTaskCancel,
  distillMarkFiredToolHandler,
  distillStatusToolHandler,
  walkerStatusToolHandler,
  scheduledTaskListToolHandler,
  scheduledTaskCreateToolHandler,
  scheduledTaskCancelToolHandler,
  defaultDaemonDir,
  defaultWalkerSchedulePath,
  STATIC_PERMANENT_TASK_IDS,
  isValidCronExpression,
} from '../relvetia-admin-tools.js'
// Saga 10 Phase 4-2 P2 #1 dedup sentinel: verify defaultDaemonDir is the
// same function reference whether imported from admin-tools, memory-tools,
// or the underlying fs-utils source.
import { defaultDaemonDir as defaultDaemonDirFromFsUtils } from '../fs-utils.js'
import { defaultDaemonDir as defaultDaemonDirFromMemoryTools } from '../relvetia-memory-tools.js'

const TMP_ROOT = join(tmpdir(), `relvetia-admin-tools-${randomBytes(4).toString('hex')}`)

function freshDir(suffix) {
  return join(TMP_ROOT, suffix + '-' + randomBytes(3).toString('hex'))
}

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

// Build a daemon dir with a scheduled_tasks.json populated by the supplied
// task list. The caller controls every field; permanent flag must be set
// explicitly when needed.
async function buildDaemonDir(suffix, tasks) {
  const dir = freshDir(suffix)
  await mkdir(join(dir, '.claude'), { recursive: true })
  await writeFile(
    join(dir, '.claude', 'scheduled_tasks.json'),
    JSON.stringify({ tasks }, null, 2) + '\n',
    'utf-8',
  )
  return dir
}

async function readDaemonTasks(daemonDir) {
  const raw = await readFile(join(daemonDir, '.claude', 'scheduled_tasks.json'), 'utf-8')
  return JSON.parse(raw).tasks
}

before(async () => {
  await mkdir(TMP_ROOT, { recursive: true })
})

after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
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

  it('defaultDaemonDir falls back to ~/.claude/relvetia when env unset', () => {
    const orig = process.env.RELVETIA_DIR
    delete process.env.RELVETIA_DIR
    try {
      assert.equal(defaultDaemonDir(), join(homedir(), '.claude', 'relvetia'))
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
    }
  })

  it('defaultWalkerSchedulePath honors $RELVETIA_WALKER_SCHEDULE_PATH', () => {
    const orig = process.env.RELVETIA_WALKER_SCHEDULE_PATH
    process.env.RELVETIA_WALKER_SCHEDULE_PATH = '/explicit/walkers/schedule.json'
    try {
      assert.equal(defaultWalkerSchedulePath(), '/explicit/walkers/schedule.json')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_WALKER_SCHEDULE_PATH = orig
      else delete process.env.RELVETIA_WALKER_SCHEDULE_PATH
    }
  })

  it('STATIC_PERMANENT_TASK_IDS mirrors bootstrap.ts STATIC_PERMANENT_TASKS', () => {
    // This is the literal pin from relvetia-daemon/src/bootstrap.ts L27-53.
    // If bootstrap.ts changes (new permanent task added, one removed), this
    // assertion must update in lock-step — otherwise distill_status would
    // drop or fabricate an entry.
    assert.deepEqual(STATIC_PERMANENT_TASK_IDS, [
      'relvetia-dream',
      'relvetia-verify',
      'relvetia-optimize',
    ])
  })

  // Saga 10 Phase 4-2 P2 #1: prior to dedup, both admin-tools.js and
  // memory-tools.js defined their own `defaultDaemonDir` body. Identical
  // today, but a future RELVETIA_DIR rename or default path tweak could
  // be applied to one and silently miss the other — internal API drift.
  // Re-routing both through fs-utils.js makes drift impossible; this
  // sentinel pins that arrangement so a regression that re-introduces a
  // local body fails loud.
  it('defaultDaemonDir is a single shared impl across admin-tools, memory-tools, fs-utils (P2 #1 dedup)', () => {
    assert.strictEqual(
      defaultDaemonDir,
      defaultDaemonDirFromFsUtils,
      'admin-tools must re-export the fs-utils impl, not redefine it',
    )
    assert.strictEqual(
      defaultDaemonDir,
      defaultDaemonDirFromMemoryTools,
      'memory-tools must re-export the fs-utils impl, not redefine it',
    )
  })
})

// ---------------------------------------------------------------------------
// distill_mark_fired
// ---------------------------------------------------------------------------

describe('distill_mark_fired (runDistillMarkFired, saga 9 Phase 3-revA P0 rename)', () => {
  const NOW = 1779_500_000_000  // arbitrary fixed epoch ms

  it('returns marked=false when target task is not in scheduled_tasks.json', async () => {
    const dir = await buildDaemonDir('dt-missing', [])
    const out = await runDistillMarkFired({}, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, false)
    assert.equal(out.taskId, 'relvetia-dream')
    assert.equal(out.lastFiredAt, null)
    assert.match(out.message, /not found/)
    // Codex P0 lived practice: error message must reinforce the bookkeeping-only contract.
    assert.match(out.message, /does NOT invoke distill/i,
      'not-found message should reinforce that this tool does not run distill')
  })

  it('blocks within cooldown when force=false (3h ago, default 6h cooldown)', async () => {
    const threeHoursAgo = NOW - 3 * 3600 * 1000
    const dir = await buildDaemonDir('dt-cooldown-block', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: threeHoursAgo, lastFiredAt: threeHoursAgo, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({}, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, false)
    assert.equal(out.lastFiredAt, threeHoursAgo)
    assert.match(out.message, /Cooldown active/)
    // File MUST NOT have been touched — verify lastFiredAt still == threeHoursAgo.
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks[0].lastFiredAt, threeHoursAgo)
  })

  it('proceeds past cooldown when last fire was > 6h ago', async () => {
    const sevenHoursAgo = NOW - 7 * 3600 * 1000
    const dir = await buildDaemonDir('dt-cooldown-pass', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: sevenHoursAgo, lastFiredAt: sevenHoursAgo, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({}, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    assert.equal(out.lastFiredAt, NOW)
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks[0].lastFiredAt, NOW)
  })

  it('force=true bypasses cooldown even when last fire was 1 minute ago', async () => {
    const oneMinAgo = NOW - 60_000
    const dir = await buildDaemonDir('dt-force', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: oneMinAgo, lastFiredAt: oneMinAgo, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({ force: true }, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    assert.equal(out.lastFiredAt, NOW)
  })

  it('proceeds when lastFiredAt is absent (fresh permanent task)', async () => {
    const dir = await buildDaemonDir('dt-fresh', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: NOW - 100, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({}, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    assert.equal(out.lastFiredAt, NOW)
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks[0].lastFiredAt, NOW)
  })

  it('targets a non-default permanent task by id (relvetia-verify)', async () => {
    const dir = await buildDaemonDir('dt-verify', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: NOW - 100, recurring: true, permanent: true },
      { id: 'relvetia-verify', cron: '30 3 * * *', prompt: '', createdAt: NOW - 100, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({ taskId: 'relvetia-verify' }, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    assert.equal(out.taskId, 'relvetia-verify')
    const tasks = await readDaemonTasks(dir)
    // dream untouched, verify updated
    assert.equal(tasks[0].lastFiredAt, undefined)
    assert.equal(tasks[1].lastFiredAt, NOW)
  })

  it('preserves all other fields of the target task (cron/prompt/recurring/permanent)', async () => {
    const dir = await buildDaemonDir('dt-preserve', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'distill body', createdAt: 12345, recurring: true, permanent: true, nativeHandler: undefined },
    ])
    const out = await runDistillMarkFired({ force: true }, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks[0].id, 'relvetia-dream')
    assert.equal(tasks[0].cron, '0 3 * * *')
    assert.equal(tasks[0].prompt, 'distill body')
    assert.equal(tasks[0].createdAt, 12345)
    assert.equal(tasks[0].recurring, true)
    assert.equal(tasks[0].permanent, true)
    assert.equal(tasks[0].lastFiredAt, NOW)
  })

  it('return message reinforces "does NOT invoke" + "does NOT affect daemon nextFireAt" (saga 9 §17 NEW Lesson D)', async () => {
    // Saga 9 Phase 3-revA P0 contract sentinel: the return message of every
    // successful mark MUST include the dual negation so any future
    // refactor that drifts the message back to "next tick observes ... and
    // skip" breaks this test. Codex P0 lived practice.
    const dir = await buildDaemonDir('dt-message-pin', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: NOW - 100, recurring: true, permanent: true },
    ])
    const out = await runDistillMarkFired({}, { daemonDir: dir, now: NOW })
    assert.equal(out.marked, true)
    assert.match(out.message, /does NOT invoke/i,
      'message must explicitly state "does NOT invoke" the distill subprocess')
    assert.match(out.message, /does NOT affect.*nextFireAt|nextFireAt.*not refreshed/i,
      'message must explicitly state the daemon nextFireAt cache is not affected')
    assert.match(out.message, /scheduler\.ts/,
      'message must cite the source file path (scheduler.ts) so the operator can verify the claim themselves')
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = await buildDaemonDir('dt-envelope', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: NOW - 100, recurring: true, permanent: true },
    ])
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await distillMarkFiredToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.equal(r.content[0].type, 'text')
      assert.match(r.content[0].text, /lastFiredAt/)
      assert.equal(r.structuredContent.marked, true)
      assert.equal(r.structuredContent.taskId, 'relvetia-dream')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// distill_status
// ---------------------------------------------------------------------------

describe('distill_status (runDistillStatus)', () => {
  it('returns all 3 permanent task ids even when scheduled_tasks.json is empty', async () => {
    const dir = await buildDaemonDir('ds-empty', [])
    const s = await runDistillStatus({}, { daemonDir: dir })
    assert.equal(s.tasks.length, 3)
    const ids = s.tasks.map(t => t.id)
    assert.deepEqual(ids, ['relvetia-dream', 'relvetia-verify', 'relvetia-optimize'])
  })

  it('marks registered=false + cron=STATIC fallback when task missing from file', async () => {
    const dir = await buildDaemonDir('ds-missing', [])
    const s = await runDistillStatus({}, { daemonDir: dir })
    const dream = s.tasks.find(t => t.id === 'relvetia-dream')
    assert.equal(dream.registered, false)
    assert.equal(dream.permanent, false)  // not in file → permanent flag absent
    assert.equal(dream.cron, '0 3 * * *')   // STATIC fallback
    assert.equal(dream.lastFiredAt, null)
    assert.equal(dream.nextFireAt, null)
  })

  it('marks registered=true + permanent=true when present', async () => {
    const ts = 1779_400_000_000
    const dir = await buildDaemonDir('ds-registered', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: ts - 100, lastFiredAt: ts, recurring: true, permanent: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    const dream = s.tasks.find(t => t.id === 'relvetia-dream')
    assert.equal(dream.registered, true)
    assert.equal(dream.permanent, true)
    assert.equal(dream.lastFiredAt, new Date(ts).toISOString())
  })

  it('prefers cron from file over STATIC fallback (file is source of truth at runtime)', async () => {
    // Bootstrap refreshes cron from STATIC at every daemon start, but at any
    // given read window the file IS the source. distill_status returns the
    // in-file cron so an operator can detect drift between code and disk.
    const dir = await buildDaemonDir('ds-cron-from-file', [
      { id: 'relvetia-dream', cron: '5 4 * * *', prompt: '', createdAt: 100, recurring: true, permanent: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    const dream = s.tasks.find(t => t.id === 'relvetia-dream')
    assert.equal(dream.cron, '5 4 * * *')  // file wins, not STATIC '0 3 * * *'
  })

  it('always returns nextFireAt=null (delegated to daemon nextFireAt cache)', async () => {
    const dir = await buildDaemonDir('ds-nofire', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: 100, lastFiredAt: 200, recurring: true, permanent: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    for (const t of s.tasks) assert.equal(t.nextFireAt, null)
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = await buildDaemonDir('ds-envelope', [])
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await distillStatusToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /relvetia-dream/)
      assert.ok(Array.isArray(r.structuredContent.tasks))
      assert.equal(r.structuredContent.tasks.length, 3)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })

  // Saga 10 Phase 4-2 P2 #3: distill_status now returns { tasks, static, dynamic }.
  // `tasks` keeps its prior shape (3 STATIC entries) for backward compat; `static`
  // aliases `tasks`; `dynamic` surfaces every non-STATIC entry from scheduled_tasks.json
  // (walkers, ad-hoc scheduled_task_create entries) so an operator reading
  // distill_status can see the full daemon picture without a separate
  // scheduled_task_list call. Codex saga 9 P2 #3 (~"fallback view やや紛らわしい")
  // root cause = dynamic entries were invisible from this surface.
  it('distill_status returns { tasks, static, dynamic } with non-STATIC entries surfaced (P2 #3)', async () => {
    const ts = 1779_700_000_000
    const dir = await buildDaemonDir('p2-3-split', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: ts - 100, lastFiredAt: ts, recurring: true, permanent: true },
      { id: 'walker-test',    cron: '0 9 * * *', prompt: 'walker fire', createdAt: ts - 50, recurring: true, permanent: true, nativeHandler: 'walker' },
      { id: 'ad-hoc-1',       cron: '*/30 * * * *', prompt: 'check stuff', createdAt: ts - 30, recurring: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    // backward compat: tasks = exactly the 3 STATIC entries (legacy shape)
    assert.equal(s.tasks.length, 3)
    const taskIds = s.tasks.map(t => t.id)
    assert.deepEqual(taskIds, STATIC_PERMANENT_TASK_IDS)
    // static aliases tasks
    assert.strictEqual(s.static, s.tasks, 'static is the same array reference as tasks')
    // dynamic = walker-test + ad-hoc-1 (non-STATIC entries from the file)
    assert.equal(s.dynamic.length, 2)
    const dynIds = s.dynamic.map(t => t.id).sort()
    assert.deepEqual(dynIds, ['ad-hoc-1', 'walker-test'])
    // dynamic preserves permanent/cron/lastFiredAt shape
    const walker = s.dynamic.find(t => t.id === 'walker-test')
    assert.equal(walker.cron, '0 9 * * *')
    assert.equal(walker.permanent, true)
    assert.equal(walker.registered, true)
    assert.equal(walker.nextFireAt, null)
  })

  it('distill_status dynamic is empty when scheduled_tasks.json holds only STATIC entries (P2 #3 backward compat)', async () => {
    const dir = await buildDaemonDir('p2-3-static-only', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: 100, recurring: true, permanent: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    assert.equal(s.static.length, 3)
    assert.equal(s.dynamic.length, 0)
    // handler text view splits sections correctly
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await distillStatusToolHandler({})
      assert.match(r.content[0].text, /STATIC distill tasks:/)
      // empty dynamic → no "Dynamic tasks" heading
      assert.doesNotMatch(r.content[0].text, /Dynamic tasks/)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })

  it('distill_status handler text view surfaces dynamic entries when present (P2 #3)', async () => {
    const dir = await buildDaemonDir('p2-3-handler-dyn', [
      { id: 'ad-hoc-x', cron: '*/15 * * * *', prompt: 'p', createdAt: 200, recurring: true },
    ])
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await distillStatusToolHandler({})
      assert.match(r.content[0].text, /STATIC distill tasks:/)
      assert.match(r.content[0].text, /Dynamic tasks/)
      assert.match(r.content[0].text, /ad-hoc-x/)
      assert.equal(r.structuredContent.dynamic.length, 1)
      assert.equal(r.structuredContent.dynamic[0].id, 'ad-hoc-x')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })

  // Saga 10 revB P1 #5 + revC P1 #1 (Codex 2nd round): dynamic entries carry
  // `cronAcceptedByLocalValidator: boolean` = isValidCronExpression(cron) — the
  // local validator mirroring daemon-side rejects, NOT a full mirror of the
  // daemon's croner-based read-time validation. The honest rename (was
  // `daemonAccepted`) acknowledges the gap: the daemon's croner library
  // accepts day-of-week aliases like `MON`/`TUE`/... and forms like `@daily`
  // that the local validator intentionally rejects; the daemon also requires
  // id/cron/prompt/createdAt all present, which this field does not look at.
  // Full daemon-side mirror is saga 11+ scope.
  it('distill_status dynamic[].cronAcceptedByLocalValidator reflects the LOCAL validator (revB P1 #5 + revC P1 #1)', async () => {
    const dir = await buildDaemonDir('p1-5-cron-accept', [
      // valid cron — local validator accepts, daemon would pick this up
      { id: 'good-1', cron: '0 9 * * *', prompt: 'p', createdAt: 100, recurring: true },
      // invalid cron — local validator rejects, daemon would drop too
      { id: 'bad-1', cron: 'not a cron at all', prompt: 'p', createdAt: 110, recurring: true },
      // also invalid: out-of-range minute field
      { id: 'bad-2', cron: '99 9 * * *', prompt: 'p', createdAt: 120, recurring: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    assert.equal(s.dynamic.length, 3, 'all 3 non-STATIC entries surface (incl. bad)')
    const good = s.dynamic.find(t => t.id === 'good-1')
    const bad1 = s.dynamic.find(t => t.id === 'bad-1')
    const bad2 = s.dynamic.find(t => t.id === 'bad-2')
    assert.equal(good.cronAcceptedByLocalValidator, true,  'valid cron → cronAcceptedByLocalValidator=true')
    assert.equal(bad1.cronAcceptedByLocalValidator, false, 'malformed cron → cronAcceptedByLocalValidator=false')
    assert.equal(bad2.cronAcceptedByLocalValidator, false, 'out-of-range cron → cronAcceptedByLocalValidator=false')

    // handler text view also tags cronAcceptedByLocalValidator=
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await distillStatusToolHandler({})
      assert.match(r.content[0].text, /good-1.*cronAcceptedByLocalValidator=true/)
      assert.match(r.content[0].text, /bad-1.*cronAcceptedByLocalValidator=false/)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })

  // Saga 10 revC P1 #1 — daemon-parity gap fixture set. cronAcceptedByLocalValidator
  // is honest about its local scope: forms the daemon accepts via croner
  // (`MON`, `@daily`) are rejected by the local validator, AND missing-field
  // entries (prompt/createdAt absent) get cronAcceptedByLocalValidator=true
  // since this field looks at cron only. These fixtures pin the gap so any
  // future change to either validator surfaces the asymmetry.
  it('cronAcceptedByLocalValidator rejects croner-only syntax the daemon would accept (revC P1 #1)', async () => {
    const dir = await buildDaemonDir('p1-1-croner-gap', [
      // `MON` day-of-week alias — daemon's croner library accepts, local validator rejects.
      { id: 'mon-alias', cron: '0 9 * * MON', prompt: 'p', createdAt: 200, recurring: true },
      // `@daily` shorthand — same story; daemon would accept, local validator rejects.
      { id: 'at-daily',  cron: '@daily', prompt: 'p', createdAt: 210, recurring: true },
      // 6-field cron (seconds) — local validator expects exactly 5 fields.
      { id: 'six-field', cron: '0 0 9 * * *', prompt: 'p', createdAt: 220, recurring: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    const mon = s.dynamic.find(t => t.id === 'mon-alias')
    const atd = s.dynamic.find(t => t.id === 'at-daily')
    const six = s.dynamic.find(t => t.id === 'six-field')
    assert.equal(mon.cronAcceptedByLocalValidator, false,
      'MON alias: local validator rejects (daemon croner would accept — known gap)')
    assert.equal(atd.cronAcceptedByLocalValidator, false,
      '@daily shorthand: local validator rejects (daemon croner would accept — known gap)')
    assert.equal(six.cronAcceptedByLocalValidator, false,
      '6-field cron: local validator rejects (only 5-field accepted)')
  })

  // Saga 10 revD (Codex 3rd-round P1) — wording-sentinel for the
  // `cronAcceptedByLocalValidator` field. revB introduced the field,
  // revC renamed it from `daemonAccepted`, but the surrounding
  // descriptions across 4 surfaces still claimed "daemon would actually
  // pick up the entry" — the very over-claim the rename was meant to
  // remove. This sentinel reads each of the 4 surfaces and rejects any
  // re-introduction of (a) the literal old field name `daemonAccepted`
  // (b) "daemon would actually pick up" / "would NOT pick" wording that
  // overpromises the local validator's scope. Treat as Lesson §14 atomic
  // sync invariant — text must not regress into the saga 7/8/9 contract-
  // on-intent shape. (Codex 3rd-round flagged this as a P1 because the
  // revC fixtures themselves disprove the over-claim: MON/@daily are
  // daemon-accepted but local-false, missing prompt/createdAt are local-
  // true but daemon-dropped.)
  // Saga 10 revD wording sentinel + revE granularity restructure
  // (Codex 4th-round P1 #2): the revD version read each FILE as one
  // surface, so an over-claim that survived in a single comment block
  // could be masked by the honest-scope wording present elsewhere in
  // the same file (Codex 4th-round caught exactly this in
  // admin-tools.js L429-431 — "what else the daemon picks up" survived
  // because the file-level check found the required wording in a
  // different block). revE restructures the admin-tools.js check into
  // three separately-extracted comment blocks so a regression in any
  // single block fails loud:
  //   1. module-header bullet (the high-level tool listing)
  //   2. runDistillStatus impl comment (introduces the dynamic field)
  //   3. distillStatusToolHandler text comment (explains the text view)
  // index.js + CLAUDE.md remain file-level checks because the relevant
  // text is contiguous in each. The banned set adds "what else the
  // daemon picks up" so the exact phrase that slipped past revD is
  // permanently locked out.
  it('cronAcceptedByLocalValidator description scope is honest across 5 surfaces / 3 admin-tools blocks (revD + revE granularity sentinel)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const srcDir = fileURLToPath(new URL('..', import.meta.url))
    const root = fileURLToPath(new URL('../..', import.meta.url))

    const adminText = await readFile(join(srcDir, 'relvetia-admin-tools.js'), 'utf-8')
    const indexText = await readFile(join(srcDir, 'index.js'),               'utf-8')
    const claudeText = await readFile(join(root,  'CLAUDE.md'),              'utf-8')

    // Extract a slice between two regex anchors (start inclusive, end
    // exclusive). Throws if the anchors don't both match — that is a
    // structural change to the file that means this sentinel itself
    // must be updated, fail loud rather than silently no-op.
    function slice(label, text, startRe, endRe) {
      const s = text.search(startRe)
      const e = text.search(endRe)
      assert.ok(s >= 0, `${label}: startRe ${startRe} did not match — block layout changed?`)
      assert.ok(e > s,  `${label}: endRe ${endRe} did not match after startRe — block layout changed?`)
      return text.slice(s, e)
    }

    const surfaces = [
      // admin-tools.js — three separately extracted comment blocks (revE)
      {
        label: 'admin-tools.js [block 1] module-header listing',
        text: slice('admin-tools module header', adminText, /^\/\/ Relvetia admin tools/m, /^import\s/m),
        requireScope: false, // module header is a high-level listing; banned-only check
      },
      {
        label: 'admin-tools.js [block 2] runDistillStatus impl comment',
        text: slice('admin-tools impl comment', adminText, /\/\/ Saga 10 Phase 4-2 P2 #3: separate STATIC/, /const staticIdSet = new Set/),
        requireScope: true,
      },
      {
        label: 'admin-tools.js [block 3] distillStatusToolHandler text comment',
        text: slice('admin-tools handler text comment', adminText, /\/\/ P2 #3 \+ revB P1 #5 \+ revD honest scope/, /const dynamicSection = s\.dynamic\.length === 0/),
        requireScope: true,
      },
      // index.js — single surface, contiguous text in distill_status safeTool description
      {
        label: 'src/index.js (safeTool description)',
        text: indexText,
        requireScope: true,
      },
      // CLAUDE.md — single surface, contiguous text in the distill_status bullet
      {
        label: 'CLAUDE.md (operator-facing docs L108 vicinity)',
        text: claudeText,
        requireScope: true,
      },
    ]

    // Wording that overpromises the field's scope and must NOT reappear
    // in ANY of the 5 surfaces (3 admin-tools blocks + index.js + CLAUDE.md).
    const banned = [
      /\bdaemonAccepted\b/,                            // pre-revC field name
      /the daemon would actually pick (?:the entry )?up/i,
      /\bdaemon would NOT pick\b/i,
      /so an operator can see which dynamic entries the daemon would actually pick up/i,
      /the full daemon picture/i,
      /what else the daemon picks up/i,                 // revE: exact phrase Codex 4th-round caught
    ]
    // For surfaces where `requireScope=true`, the honest scope claim must
    // be present (revE acceptance — text must say what the field IS, not
    // just not say what it isn't).
    const required = [
      /local 5-field cron validator only|local 5-field validator only/i,
      /croner-only|croner library/i,
    ]

    for (const { label, text, requireScope } of surfaces) {
      for (const re of banned) {
        assert.ok(
          !re.test(text),
          `${label}: banned wording matched ${re} — re-introduces the daemon-pickup over-claim the revD+revE wording invariant removes.`,
        )
      }
      if (requireScope) {
        for (const re of required) {
          assert.ok(
            re.test(text),
            `${label}: required honest-scope wording ${re} is missing — revD/revE acceptance regression.`,
          )
        }
      }
    }
  })

  it('cronAcceptedByLocalValidator looks at cron only, not at missing prompt/createdAt (revC P1 #1)', async () => {
    // The daemon (relvetia-daemon/src/tasks.ts L79) requires id+cron+prompt+
    // createdAt to ALL be present and would silently drop entries missing
    // any of them. cronAcceptedByLocalValidator deliberately ignores those
    // other fields; the rename + this sentinel pin that scope honestly.
    const dir = await buildDaemonDir('p1-1-missing-fields', [
      // valid cron but missing prompt — daemon would drop, local says true
      { id: 'no-prompt', cron: '0 9 * * *', createdAt: 300, recurring: true },
      // valid cron but missing createdAt — daemon would drop, local says true
      { id: 'no-created', cron: '0 9 * * *', prompt: 'p', recurring: true },
    ])
    const s = await runDistillStatus({}, { daemonDir: dir })
    const noP = s.dynamic.find(t => t.id === 'no-prompt')
    const noC = s.dynamic.find(t => t.id === 'no-created')
    assert.equal(noP.cronAcceptedByLocalValidator, true,
      'missing prompt: cron passes local validator, daemon would still drop (known gap)')
    assert.equal(noC.cronAcceptedByLocalValidator, true,
      'missing createdAt: cron passes local validator, daemon would still drop (known gap)')
  })
})

// ---------------------------------------------------------------------------
// walker_status
// ---------------------------------------------------------------------------

describe('walker_status (runWalkerStatus)', () => {
  async function writeSchedule(dir, content) {
    const p = join(dir, 'persona', 'walkers', 'schedule.json')
    await mkdir(join(dir, 'persona', 'walkers'), { recursive: true })
    await writeFile(p, content, 'utf-8')
    return p
  }

  it('returns walkers=[] when schedule.json is missing', async () => {
    const dir = freshDir('ws-missing')
    await mkdir(dir, { recursive: true })
    const schedulePath = join(dir, 'persona', 'walkers', 'schedule.json')
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    assert.deepEqual(s.walkers, [])
    assert.equal(s.schedulePath, schedulePath)
  })

  it('returns walkers=[] + error message when schedule.json is malformed JSON', async () => {
    const dir = freshDir('ws-malformed')
    const schedulePath = await writeSchedule(dir, '{not valid json')
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    assert.deepEqual(s.walkers, [])
    assert.match(s.error, /JSON parse failed/)
  })

  it('expands HH:MM list into 5-field cron strings', async () => {
    const dir = freshDir('ws-cron')
    const schedulePath = await writeSchedule(dir, JSON.stringify({
      walkers: {
        'persona-walker-x': { enabled: true, schedule: ['09:00', '21:30'] },
      },
    }))
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    assert.equal(s.walkers.length, 1)
    const w = s.walkers[0]
    assert.equal(w.id, 'persona-walker-x')
    assert.equal(w.enabled, true)
    assert.deepEqual(w.schedule, ['09:00', '21:30'])
    assert.deepEqual(w.cronExpanded, ['0 9 * * *', '30 21 * * *'])
  })

  it('marks enabled=false when schedule.json says so', async () => {
    const dir = freshDir('ws-disabled')
    const schedulePath = await writeSchedule(dir, JSON.stringify({
      walkers: {
        'persona-walker-discord': { enabled: false, schedule: ['12:00'] },
      },
    }))
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    assert.equal(s.walkers[0].enabled, false)
  })

  it('joins lastFiredAt from scheduled_tasks.json by walker id', async () => {
    const ts = 1779_300_000_000
    const dir = await buildDaemonDir('ws-lastfired', [
      { id: 'persona-walker-x', cron: '0 9 * * *', prompt: '<native:runWalker:persona-walker-x>', createdAt: ts - 100, lastFiredAt: ts, recurring: true, permanent: true, nativeHandler: 'runWalker' },
    ])
    const schedulePath = await writeSchedule(dir, JSON.stringify({
      walkers: {
        'persona-walker-x': { enabled: true, schedule: ['09:00'], note: 'curiosity loop' },
      },
    }))
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    const w = s.walkers[0]
    assert.equal(w.lastFiredAt, new Date(ts).toISOString())
    assert.equal(w.note, 'curiosity loop')
  })

  it('skips invalid HH:MM entries silently (mirror bootstrap.ts graceful degrade)', async () => {
    const dir = freshDir('ws-invalid')
    const schedulePath = await writeSchedule(dir, JSON.stringify({
      walkers: {
        'persona-walker-x': { enabled: true, schedule: ['09:00', 'not-time', '25:99', ''] },
      },
    }))
    const s = await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    assert.deepEqual(s.walkers[0].cronExpanded, ['0 9 * * *'])
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = freshDir('ws-envelope')
    const schedulePath = await writeSchedule(dir, JSON.stringify({
      walkers: { 'persona-walker-x': { enabled: true, schedule: ['09:00'] } },
    }))
    const origDir = process.env.RELVETIA_DIR
    const origPath = process.env.RELVETIA_WALKER_SCHEDULE_PATH
    process.env.RELVETIA_DIR = dir
    process.env.RELVETIA_WALKER_SCHEDULE_PATH = schedulePath
    try {
      const r = await walkerStatusToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /persona-walker-x/)
      assert.equal(r.structuredContent.walkers.length, 1)
    } finally {
      if (origDir !== undefined) process.env.RELVETIA_DIR = origDir
      else delete process.env.RELVETIA_DIR
      if (origPath !== undefined) process.env.RELVETIA_WALKER_SCHEDULE_PATH = origPath
      else delete process.env.RELVETIA_WALKER_SCHEDULE_PATH
    }
  })
})

// ---------------------------------------------------------------------------
// scheduled_task_list
// ---------------------------------------------------------------------------

describe('scheduled_task_list (runScheduledTaskList)', () => {
  it('returns empty list when scheduled_tasks.json is missing', async () => {
    const dir = freshDir('sl-missing')
    await mkdir(dir, { recursive: true })
    const s = await runScheduledTaskList({}, { daemonDir: dir })
    assert.deepEqual(s.tasks, [])
  })

  it('returns all tasks when includePermanent=true (default)', async () => {
    const dir = await buildDaemonDir('sl-all', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p1', createdAt: 100, recurring: true, permanent: true },
      { id: 'user-task', cron: '0 9 * * *', prompt: 'p2', createdAt: 200, recurring: true },
    ])
    const s = await runScheduledTaskList({}, { daemonDir: dir })
    assert.equal(s.tasks.length, 2)
  })

  it('filters out permanent tasks when includePermanent=false', async () => {
    const dir = await buildDaemonDir('sl-nonperm', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p1', createdAt: 100, recurring: true, permanent: true },
      { id: 'user-task', cron: '0 9 * * *', prompt: 'p2', createdAt: 200, recurring: true },
    ])
    const s = await runScheduledTaskList({ includePermanent: false }, { daemonDir: dir })
    assert.equal(s.tasks.length, 1)
    assert.equal(s.tasks[0].id, 'user-task')
  })

  it('normalises optional fields (lastFiredAt: number → number | null, recurring/permanent → bool)', async () => {
    const dir = await buildDaemonDir('sl-norm', [
      { id: 'a', cron: '* * * * *', prompt: 'p', createdAt: 1 },                                   // no lastFiredAt, no recurring, no permanent
      { id: 'b', cron: '* * * * *', prompt: 'p', createdAt: 1, lastFiredAt: 50, recurring: true }, // recurring
      { id: 'c', cron: '* * * * *', prompt: 'p', createdAt: 1, permanent: true, recurring: true }, // permanent
    ])
    const s = await runScheduledTaskList({}, { daemonDir: dir })
    assert.equal(s.tasks[0].lastFiredAt, null)
    assert.equal(s.tasks[0].recurring, false)
    assert.equal(s.tasks[0].permanent, false)
    assert.equal(s.tasks[1].lastFiredAt, 50)
    assert.equal(s.tasks[1].recurring, true)
    assert.equal(s.tasks[2].permanent, true)
  })

  it('preserves nativeHandler when present', async () => {
    const dir = await buildDaemonDir('sl-native', [
      { id: 'persona-walker-x', cron: '0 9 * * *', prompt: '<native>', createdAt: 1, recurring: true, permanent: true, nativeHandler: 'runWalker' },
    ])
    const s = await runScheduledTaskList({}, { daemonDir: dir })
    assert.equal(s.tasks[0].nativeHandler, 'runWalker')
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = await buildDaemonDir('sl-envelope', [
      { id: 'user-task', cron: '0 9 * * *', prompt: 'check PRs', createdAt: 100, recurring: true },
    ])
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await scheduledTaskListToolHandler({})
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /1 task\(s\)/)
      assert.match(r.content[0].text, /user-task/)
      assert.equal(r.structuredContent.tasks.length, 1)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// scheduled_task_create
// ---------------------------------------------------------------------------

describe('scheduled_task_create (runScheduledTaskCreate)', () => {
  it('creates a new task and round-trips through scheduled_task_list', async () => {
    const dir = freshDir('sc-rt')
    await mkdir(dir, { recursive: true })
    const created = await runScheduledTaskCreate(
      { cron: '0 9 * * *', prompt: 'morning check' },
      { daemonDir: dir, now: 1000, idGen: () => 'abc12345' },
    )
    assert.equal(created.id, 'abc12345')
    assert.equal(created.cron, '0 9 * * *')
    assert.equal(created.recurring, true)
    assert.equal(created.createdAt, 1000)

    const list = await runScheduledTaskList({}, { daemonDir: dir })
    assert.equal(list.tasks.length, 1)
    assert.equal(list.tasks[0].id, 'abc12345')
    assert.equal(list.tasks[0].prompt, 'morning check')
  })

  it('defaults recurring=true when omitted', async () => {
    const dir = freshDir('sc-recurring-default')
    await mkdir(dir, { recursive: true })
    const out = await runScheduledTaskCreate({ cron: '0 9 * * *', prompt: 'p' }, { daemonDir: dir })
    assert.equal(out.recurring, true)
  })

  it('honors recurring=false (one-shot)', async () => {
    const dir = freshDir('sc-oneshot')
    await mkdir(dir, { recursive: true })
    const out = await runScheduledTaskCreate(
      { cron: '0 9 * * *', prompt: 'p', recurring: false },
      { daemonDir: dir },
    )
    assert.equal(out.recurring, false)
    const tasks = await readDaemonTasks(dir)
    // one-shot: recurring field should be absent (mirror tasks.ts shape)
    assert.equal(tasks[0].recurring, undefined)
  })

  it('NEVER sets permanent=true even if caller tries (contract: permanent is bootstrap-only)', async () => {
    const dir = freshDir('sc-no-permanent')
    await mkdir(dir, { recursive: true })
    // Caller cannot inject `permanent` via the Zod schema (boundary test in
    // MCP server suite below), but the inner run function also refuses to
    // honor it even if passed.
    const out = await runScheduledTaskCreate(
      { cron: '0 9 * * *', prompt: 'p', permanent: true },
      { daemonDir: dir },
    )
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks[0].permanent, undefined)
    assert.notEqual(out.permanent, true)
  })

  it('appends rather than replacing on second call', async () => {
    const dir = freshDir('sc-append')
    await mkdir(dir, { recursive: true })
    await runScheduledTaskCreate({ cron: '* * * * *', prompt: 'first' }, { daemonDir: dir, idGen: () => 'id1' })
    await runScheduledTaskCreate({ cron: '* * * * *', prompt: 'second' }, { daemonDir: dir, idGen: () => 'id2' })
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].id, 'id1')
    assert.equal(tasks[1].id, 'id2')
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = freshDir('sc-envelope')
    await mkdir(dir, { recursive: true })
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await scheduledTaskCreateToolHandler({ cron: '0 9 * * *', prompt: 'p' })
      assert.ok(Array.isArray(r.content))
      assert.match(r.content[0].text, /Created task/)
      assert.ok(r.structuredContent.id)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })

  // Saga 10 Phase 4-2 P2 #2: $RELVETIA_SCHEDULED_TASKS_PATH lets a test or
  // benchmark aim at a specific file independent of the surrounding daemon
  // dir layout, mirroring $RELVETIA_WALKER_SCHEDULE_PATH. When set, every
  // read/write path inside admin-tools must route through that exact file
  // and leave the daemonDir default location untouched.
  it('scheduled_task_create writes to $RELVETIA_SCHEDULED_TASKS_PATH when set (P2 #2)', async () => {
    const daemonDir = freshDir('p2-2-daemon')
    await mkdir(join(daemonDir, '.claude'), { recursive: true })
    // Pre-seed the daemonDir default location with an empty file so we can
    // assert it was NOT touched after the override-routed create.
    const defaultPath = join(daemonDir, '.claude', 'scheduled_tasks.json')
    await writeFile(defaultPath, JSON.stringify({ tasks: [] }, null, 2) + '\n', 'utf-8')
    const beforeDefault = await captureInvariant(defaultPath)

    const customPath = join(TMP_ROOT, `p2-2-custom-${randomBytes(3).toString('hex')}.json`)
    await writeFile(customPath, JSON.stringify({ tasks: [] }, null, 2) + '\n', 'utf-8')

    const orig = process.env.RELVETIA_SCHEDULED_TASKS_PATH
    process.env.RELVETIA_SCHEDULED_TASKS_PATH = customPath
    try {
      const out = await runScheduledTaskCreate(
        { cron: '0 9 * * *', prompt: 'P2 #2 override sentinel' },
        { daemonDir, now: 1779_600_000_000, idGen: () => 'p2env001' },
      )
      assert.equal(out.id, 'p2env001')

      // custom path WAS written
      const customRaw = await readFile(customPath, 'utf-8')
      const customFile = JSON.parse(customRaw)
      assert.equal(customFile.tasks.length, 1)
      assert.equal(customFile.tasks[0].id, 'p2env001')

      // default daemonDir path was NOT touched (md5+size+mtime 3-axis invariant)
      // Saga 10 revB P2 #1: include mtime so Lesson §16 3-axis invariant is
      // honoured byte-for-byte; the prior assert checked only md5+size.
      const afterDefault = await captureInvariant(defaultPath)
      assert.deepEqual(
        { md5: afterDefault.md5, size: afterDefault.size, mtime: afterDefault.mtime },
        { md5: beforeDefault.md5, size: beforeDefault.size, mtime: beforeDefault.mtime },
        'daemonDir default path stays byte+mtime-invariant when env override is set',
      )
    } finally {
      if (orig !== undefined) process.env.RELVETIA_SCHEDULED_TASKS_PATH = orig
      else delete process.env.RELVETIA_SCHEDULED_TASKS_PATH
    }
  })

  it('test_isolation: $RELVETIA_SCHEDULED_TASKS_PATH does not create daemonDir/.claude (revB P1 #4)', async () => {
    // revB P1 #4: writeCronTasksFile previously always mkdir-ed
    // join(daemonDir, '.claude'), which leaked surrounding state into the
    // daemonDir even when the env override aimed writes at a fully
    // unrelated path. Fix uses dirname(scheduledTasksFilePath()) so only
    // the override's parent dir is created.
    const daemonDir = freshDir('p1-4-no-leak')
    // do NOT pre-create daemonDir/.claude. If the bug is back, the
    // create-side would touch it.
    await mkdir(daemonDir, { recursive: true })  // bare daemonDir exists; no .claude/ inside

    const customPath = join(TMP_ROOT, `p1-4-custom-${randomBytes(3).toString('hex')}.json`)
    await writeFile(customPath, JSON.stringify({ tasks: [] }, null, 2) + '\n', 'utf-8')

    const orig = process.env.RELVETIA_SCHEDULED_TASKS_PATH
    process.env.RELVETIA_SCHEDULED_TASKS_PATH = customPath
    try {
      await runScheduledTaskCreate(
        { cron: '0 9 * * *', prompt: 'P1 #4 no-leak sentinel' },
        { daemonDir, idGen: () => 'p14001' },
      )
      // override path was written
      const customRaw = await readFile(customPath, 'utf-8')
      const customFile = JSON.parse(customRaw)
      assert.equal(customFile.tasks.length, 1)

      // daemonDir/.claude/ must NOT have been created
      let claudeExists = false
      try {
        await stat(join(daemonDir, '.claude'))
        claudeExists = true
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      assert.equal(claudeExists, false,
        'daemonDir/.claude must not exist when env override aims writes elsewhere')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_SCHEDULED_TASKS_PATH = orig
      else delete process.env.RELVETIA_SCHEDULED_TASKS_PATH
    }
  })

  it('scheduled_task_create falls back to daemonDir path when $RELVETIA_SCHEDULED_TASKS_PATH unset (P2 #2 fallback)', async () => {
    const daemonDir = freshDir('p2-2-fallback')
    await mkdir(daemonDir, { recursive: true })
    const orig = process.env.RELVETIA_SCHEDULED_TASKS_PATH
    delete process.env.RELVETIA_SCHEDULED_TASKS_PATH
    try {
      const out = await runScheduledTaskCreate(
        { cron: '0 9 * * *', prompt: 'p' },
        { daemonDir, idGen: () => 'fallback1' },
      )
      assert.equal(out.id, 'fallback1')
      // wrote to daemonDir default
      const raw = await readFile(join(daemonDir, '.claude', 'scheduled_tasks.json'), 'utf-8')
      const file = JSON.parse(raw)
      assert.equal(file.tasks.length, 1)
      assert.equal(file.tasks[0].id, 'fallback1')
    } finally {
      if (orig !== undefined) process.env.RELVETIA_SCHEDULED_TASKS_PATH = orig
    }
  })
})

// ---------------------------------------------------------------------------
// scheduled_task_cancel
// ---------------------------------------------------------------------------

describe('scheduled_task_cancel (runScheduledTaskCancel)', () => {
  it('returns cancelled=false when id is not found', async () => {
    const dir = await buildDaemonDir('cc-missing', [
      { id: 'existing', cron: '* * * * *', prompt: 'p', createdAt: 1, recurring: true },
    ])
    const out = await runScheduledTaskCancel({ id: 'ghost' }, { daemonDir: dir })
    assert.equal(out.cancelled, false)
    assert.equal(out.removedTask, null)
    assert.match(out.message, /not found/)
  })

  it('refuses to remove permanent=true tasks', async () => {
    const dir = await buildDaemonDir('cc-perm', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p', createdAt: 1, recurring: true, permanent: true },
    ])
    const out = await runScheduledTaskCancel({ id: 'relvetia-dream' }, { daemonDir: dir })
    assert.equal(out.cancelled, false)
    assert.equal(out.removedTask, null)
    assert.match(out.message, /permanent/)
    // File MUST NOT have been mutated.
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0].id, 'relvetia-dream')
  })

  it('removes a non-permanent task and returns the removed entry', async () => {
    const dir = await buildDaemonDir('cc-success', [
      { id: 'user-task', cron: '0 9 * * *', prompt: 'p', createdAt: 100, recurring: true },
    ])
    const out = await runScheduledTaskCancel({ id: 'user-task' }, { daemonDir: dir })
    assert.equal(out.cancelled, true)
    assert.equal(out.removedTask.id, 'user-task')
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks.length, 0)
  })

  it('preserves other tasks in the file after removing one', async () => {
    const dir = await buildDaemonDir('cc-preserve', [
      { id: 'a', cron: '* * * * *', prompt: 'p', createdAt: 1, recurring: true },
      { id: 'b', cron: '* * * * *', prompt: 'p', createdAt: 2, recurring: true },
      { id: 'c', cron: '* * * * *', prompt: 'p', createdAt: 3, recurring: true },
    ])
    await runScheduledTaskCancel({ id: 'b' }, { daemonDir: dir })
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks.length, 2)
    assert.deepEqual(tasks.map(t => t.id), ['a', 'c'])
  })

  it('handler envelope returns { content[], structuredContent }', async () => {
    const dir = await buildDaemonDir('cc-envelope', [
      { id: 'gone', cron: '* * * * *', prompt: 'p', createdAt: 1, recurring: true },
    ])
    const orig = process.env.RELVETIA_DIR
    process.env.RELVETIA_DIR = dir
    try {
      const r = await scheduledTaskCancelToolHandler({ id: 'gone' })
      assert.equal(r.structuredContent.cancelled, true)
      assert.match(r.content[0].text, /Cancelled task 'gone'/)
    } finally {
      if (orig !== undefined) process.env.RELVETIA_DIR = orig
      else delete process.env.RELVETIA_DIR
    }
  })
})

// ---------------------------------------------------------------------------
// Production filesystem invariant sentinel
//
// Saga 8 §16 lesson: "production filesystem invariant evidence is benchmark/
// test harness auto-capture, mtime+size+md5 3 軸 mandate". This suite
// snapshots all four protected files BEFORE exercising every admin tool
// against env-overridden state, then re-snapshots and asserts byte+
// timestamp identity. If any admin tool ever touches stats.json /
// index.json / MEMORY.md / concepts/graph.json, this sentinel fails.
//
// Codex P1 #3, saga 8 Phase 2-revB: assert mtime invariant alongside
// md5/size so "same content, touched timestamp" drift is detected (e.g.,
// a write that happened to produce the same content). 1ms tolerance
// matches NTFS resolution.
// ---------------------------------------------------------------------------

describe('production-invariant sentinel (saga 9: 6 admin tools)', () => {
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

    // Exercise every admin tool with env-overridden state — production must
    // not be touched. We hit all 6 tools (incl. mutation paths) and we also
    // pass the production memory dir to a couple of read-only ones to prove
    // the read path is genuinely read-only.

    const dir = await buildDaemonDir('sentinel-write', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: '', createdAt: 100, lastFiredAt: 0, recurring: true, permanent: true },
      { id: 'user-task', cron: '* * * * *', prompt: 'p', createdAt: 200, recurring: true },
    ])
    const schedulePathDir = freshDir('sentinel-schedule')
    await mkdir(join(schedulePathDir, 'persona', 'walkers'), { recursive: true })
    const schedulePath = join(schedulePathDir, 'persona', 'walkers', 'schedule.json')
    await writeFile(schedulePath, JSON.stringify({
      walkers: { 'persona-walker-x': { enabled: true, schedule: ['09:00'] } },
    }))

    await runDistillMarkFired({ force: true }, { daemonDir: dir, now: 1000 })
    await runDistillStatus({}, { daemonDir: dir })
    await runWalkerStatus({}, { daemonDir: dir, schedulePath })
    await runScheduledTaskList({}, { daemonDir: dir })
    await runScheduledTaskCreate(
      { cron: '0 9 * * *', prompt: 'p' },
      { daemonDir: dir, idGen: () => 'sentinel' },
    )
    await runScheduledTaskCancel({ id: 'user-task' }, { daemonDir: dir })
  })

  for (const rel of PROTECTED_FILES) {
    it(`leaves ${rel} byte+timestamp-identical (md5+size+mtime) after all 6 admin tools exercise env-overridden state`, async () => {
      const cur = await captureInvariant(join(PROD, rel))
      if (baseline[rel] === null) {
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
// Phase 3-revB sentinels (Codex saga 9 P1 #1 + #2 + #3 lived practice)
// ---------------------------------------------------------------------------

describe('isValidCronExpression (saga 9 Phase 3-revB P1 #1: cron validation)', () => {
  it('accepts canonical 5-field cron strings', () => {
    assert.equal(isValidCronExpression('0 3 * * *'), true)            // daily 03:00
    assert.equal(isValidCronExpression('30 3 * * *'), true)           // daily 03:30
    assert.equal(isValidCronExpression('0 4 * * 0'), true)            // Sunday 04:00
    assert.equal(isValidCronExpression('*/15 * * * *'), true)         // every 15 min
    assert.equal(isValidCronExpression('0 9,12,15 * * 1-5'), true)    // weekdays at 9/12/15
    assert.equal(isValidCronExpression('0 0-23/4 * * *'), true)       // every 4h
    assert.equal(isValidCronExpression('59 23 31 12 7'), true)        // edge of every range
    assert.equal(isValidCronExpression('0 0 1 1 0'), true)            // min of every range
  })

  it('rejects wrong field count', () => {
    assert.equal(isValidCronExpression('* * *'), false)
    assert.equal(isValidCronExpression('* * * *'), false)
    assert.equal(isValidCronExpression('* * * * * *'), false)
    assert.equal(isValidCronExpression(''), false)
  })

  it('rejects out-of-range numbers per field', () => {
    assert.equal(isValidCronExpression('60 0 * * *'), false)   // minute > 59
    assert.equal(isValidCronExpression('0 24 * * *'), false)   // hour > 23
    assert.equal(isValidCronExpression('0 0 0 * *'), false)    // dayOfMonth < 1
    assert.equal(isValidCronExpression('0 0 32 * *'), false)   // dayOfMonth > 31
    assert.equal(isValidCronExpression('0 0 * 0 *'), false)    // month < 1
    assert.equal(isValidCronExpression('0 0 * 13 *'), false)   // month > 12
    assert.equal(isValidCronExpression('0 0 * * 8'), false)    // dayOfWeek > 7
  })

  it('rejects non-string, non-numeric, garbage', () => {
    assert.equal(isValidCronExpression(null), false)
    assert.equal(isValidCronExpression(undefined), false)
    assert.equal(isValidCronExpression(123), false)
    assert.equal(isValidCronExpression('hello world'), false)
    assert.equal(isValidCronExpression('a b c d e'), false)
    assert.equal(isValidCronExpression('0 9 * * Mon'), false)  // named weekday not supported
  })

  it('rejects malformed step / range syntax', () => {
    assert.equal(isValidCronExpression('0 0 * * */0'), false)  // step 0
    assert.equal(isValidCronExpression('0 0 * * 5-3'), false)  // range reverse
    assert.equal(isValidCronExpression('0 0 * * -'), false)    // empty range
  })
})

describe('scheduled_task_create cron validation boundary (saga 9 P1 #1)', () => {
  it('rejects invalid cron with INVALID_CRON error code (does NOT touch the file)', async () => {
    const dir = freshDir('sc-invalid-cron')
    await mkdir(dir, { recursive: true })
    await assert.rejects(
      runScheduledTaskCreate({ cron: 'not a cron', prompt: 'p' }, { daemonDir: dir }),
      err => err.code === 'INVALID_CRON',
    )
    // The file MUST NOT exist after a rejection.
    const exists = await readFile(join(dir, '.claude', 'scheduled_tasks.json'), 'utf-8')
      .then(() => true).catch(() => false)
    assert.equal(exists, false, 'scheduled_tasks.json must not be created when cron is invalid')
  })

  it('rejects out-of-range cron (hour=25) loudly', async () => {
    const dir = freshDir('sc-oor-hour')
    await mkdir(dir, { recursive: true })
    await assert.rejects(
      runScheduledTaskCreate({ cron: '0 25 * * *', prompt: 'p' }, { daemonDir: dir }),
      /Invalid cron expression/,
    )
  })

  it('rejects wrong field count (3 fields) loudly', async () => {
    const dir = freshDir('sc-3fields')
    await mkdir(dir, { recursive: true })
    await assert.rejects(
      runScheduledTaskCreate({ cron: '0 9 *', prompt: 'p' }, { daemonDir: dir }),
      /Invalid cron expression/,
    )
  })

  it('accepts valid cron after rejection (state stays consistent)', async () => {
    const dir = freshDir('sc-recover')
    await mkdir(dir, { recursive: true })
    await assert.rejects(
      runScheduledTaskCreate({ cron: 'bogus', prompt: 'p' }, { daemonDir: dir }),
      /Invalid cron expression/,
    )
    const out = await runScheduledTaskCreate(
      { cron: '0 9 * * *', prompt: 'p' },
      { daemonDir: dir, idGen: () => 'recover1' },
    )
    assert.equal(out.id, 'recover1')
    assert.equal(out.cron, '0 9 * * *')
  })
})

describe('withLock concurrent safety boundary (saga 9 P1 #2)', () => {
  it('two concurrent scheduled_task_create calls both succeed without lost update', async () => {
    const dir = freshDir('lock-concurrent')
    await mkdir(dir, { recursive: true })
    // Fire two creates concurrently. Without withLock the second's
    // read-modify-write could overwrite the first's append, leaving only
    // one entry in scheduled_tasks.json. With withLock both must serialise
    // and both ids must appear.
    const [a, b] = await Promise.all([
      runScheduledTaskCreate(
        { cron: '0 9 * * *', prompt: 'parallel-A' },
        { daemonDir: dir, idGen: () => 'concurA' },
      ),
      runScheduledTaskCreate(
        { cron: '0 10 * * *', prompt: 'parallel-B' },
        { daemonDir: dir, idGen: () => 'concurB' },
      ),
    ])
    assert.equal(a.id, 'concurA')
    assert.equal(b.id, 'concurB')
    const tasks = await readDaemonTasks(dir)
    const ids = tasks.map(t => t.id).sort()
    assert.deepEqual(ids, ['concurA', 'concurB'],
      'both concurrent creates must persist (no lost update under withLock)')
  })

  it('concurrent distill_mark_fired + scheduled_task_create serialise correctly', async () => {
    const dir = await buildDaemonDir('lock-mixed', [
      { id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p', createdAt: 1000, recurring: true, permanent: true },
    ])
    const NOW = 1779_700_000_000
    const [m, c] = await Promise.all([
      runDistillMarkFired({ force: true }, { daemonDir: dir, now: NOW }),
      runScheduledTaskCreate(
        { cron: '0 12 * * *', prompt: 'mixed' },
        { daemonDir: dir, idGen: () => 'mixedC' },
      ),
    ])
    assert.equal(m.marked, true)
    assert.equal(c.id, 'mixedC')
    const tasks = await readDaemonTasks(dir)
    assert.equal(tasks.length, 2)
    const dream = tasks.find(t => t.id === 'relvetia-dream')
    const mixedC = tasks.find(t => t.id === 'mixedC')
    assert.equal(dream.lastFiredAt, NOW, 'mark_fired update preserved')
    assert.ok(mixedC, 'create entry preserved')
  })
})

describe('malformed scheduled_tasks.json loud-failure boundary (saga 9 P1 #3)', () => {
  it('read-only paths (list/status/walker_status) tolerate malformed JSON via graceful fallback', async () => {
    const dir = freshDir('malformed-readonly')
    await mkdir(join(dir, '.claude'), { recursive: true })
    await writeFile(join(dir, '.claude', 'scheduled_tasks.json'), '{not json}')
    // list: graceful empty
    const l = await runScheduledTaskList({}, { daemonDir: dir })
    assert.deepEqual(l.tasks, [])
    // status: 3 permanent placeholders unregistered
    const s = await runDistillStatus({}, { daemonDir: dir })
    assert.equal(s.tasks.length, 3)
    assert.ok(s.tasks.every(t => t.registered === false))
  })

  it('mutation paths fail LOUD with MALFORMED_TASKS_FILE rather than overwriting', async () => {
    // Codex P1 #3 lived practice: a malformed file MUST NOT be silently
    // overwritten by mutation paths. We deliberately try the 3 mutation
    // paths in turn and assert each throws + the file content stays
    // exactly as it started.
    for (const fn of ['create', 'cancel', 'mark_fired']) {
      const dir = freshDir(`malformed-${fn}`)
      await mkdir(join(dir, '.claude'), { recursive: true })
      const tasksPath = join(dir, '.claude', 'scheduled_tasks.json')
      const original = '{not json}'
      await writeFile(tasksPath, original)
      await assert.rejects(
        fn === 'create'
          ? runScheduledTaskCreate({ cron: '0 9 * * *', prompt: 'p' }, { daemonDir: dir })
          : fn === 'cancel'
            ? runScheduledTaskCancel({ id: 'any' }, { daemonDir: dir })
            : runDistillMarkFired({ force: true }, { daemonDir: dir }),
        err => err.code === 'MALFORMED_TASKS_FILE',
        `${fn} must throw MALFORMED_TASKS_FILE on malformed file`,
      )
      // File MUST be byte-identical to what we wrote (mutation refused).
      const after = await readFile(tasksPath, 'utf-8')
      assert.equal(after, original,
        `${fn} must not overwrite a malformed scheduled_tasks.json`)
    }
  })

  it('mutation paths fail LOUD on non-object top-level too', async () => {
    const dir = freshDir('malformed-nonobj')
    await mkdir(join(dir, '.claude'), { recursive: true })
    const tasksPath = join(dir, '.claude', 'scheduled_tasks.json')
    await writeFile(tasksPath, '[1, 2, 3]')  // valid JSON but wrong shape
    await assert.rejects(
      runScheduledTaskCreate({ cron: '0 9 * * *', prompt: 'p' }, { daemonDir: dir }),
      err => err.code === 'MALFORMED_TASKS_FILE',
    )
    const after = await readFile(tasksPath, 'utf-8')
    assert.equal(after, '[1, 2, 3]')
  })

  it('mutation paths fail LOUD on missing tasks field', async () => {
    const dir = freshDir('malformed-notasks')
    await mkdir(join(dir, '.claude'), { recursive: true })
    const tasksPath = join(dir, '.claude', 'scheduled_tasks.json')
    await writeFile(tasksPath, JSON.stringify({ wrongShape: true }))
    await assert.rejects(
      runScheduledTaskCreate({ cron: '0 9 * * *', prompt: 'p' }, { daemonDir: dir }),
      err => err.code === 'MALFORMED_TASKS_FILE',
    )
  })
})

// ---------------------------------------------------------------------------
// MCP server boundary tests (safeTool + Zod schema + strict mode + contract
// claim sentinels).
//
// Saga 7 §14 + saga 8 §17 lesson: every contractual claim in the tool
// description ("read-only", "only mutates scheduled_tasks.json", "refuses
// permanent task", "does NOT spawn subprocess") MUST be backed by a test
// that pins the wording so the claim cannot silently drift.
// ---------------------------------------------------------------------------

describe('MCP server boundary (safeTool + Zod registration for 6 new admin tools)', () => {
  let serverMod = null
  const FIXTURE_DAEMON_DIR = join(TMP_ROOT, 'boundary-daemon')

  const TOOL_NAMES = [
    'distill_mark_fired',
    'distill_status',
    'walker_status',
    'scheduled_task_list',
    'scheduled_task_create',
    'scheduled_task_cancel',
  ]

  before(async () => {
    await mkdir(join(FIXTURE_DAEMON_DIR, '.claude'), { recursive: true })
    await writeFile(
      join(FIXTURE_DAEMON_DIR, '.claude', 'scheduled_tasks.json'),
      JSON.stringify({ tasks: [] }, null, 2) + '\n',
      'utf-8',
    )
    process.env.RELVETIA_DIR = FIXTURE_DAEMON_DIR
    // schedule.json: empty walkers so walker_status returns []
    const schedPath = join(FIXTURE_DAEMON_DIR, 'persona', 'walkers', 'schedule.json')
    await mkdir(join(FIXTURE_DAEMON_DIR, 'persona', 'walkers'), { recursive: true })
    await writeFile(schedPath, JSON.stringify({ walkers: {} }))
    process.env.RELVETIA_WALKER_SCHEDULE_PATH = schedPath
    serverMod = await import('../index.js')
  })

  it('registers all six new admin tools on the relvetia-team server', () => {
    const tools = serverMod.server._registeredTools
    for (const name of TOOL_NAMES) {
      assert.ok(tools[name], `${name} registered`)
      assert.equal(typeof tools[name].handler, 'function', `${name}.handler is a function`)
    }
  })

  // ----- Contract-claim sentinels (saga 8 §17 lived practice) -----

  it('distill_mark_fired description honestly says it does NOT invoke distill AND does NOT affect daemon nextFireAt (saga 9 P0 + Lesson D NEW)', () => {
    const desc = serverMod.server._registeredTools.distill_mark_fired.description
    assert.equal(typeof desc, 'string')
    assert.ok(desc.length > 0)
    // Codex P0 saga 9 lived practice: the description must NOT make a
    // POSITIVE claim that this tool spawns, executes, runs, invokes, or
    // triggers distill. Honest negation phrasing ("does NOT spawn") is
    // allowed and in fact required.
    assert.doesNotMatch(
      desc,
      /\b(this tool|distill_mark_fired)\s+(spawns?|executes?|runs|invokes?|triggers?)\b/i,
      'distill_mark_fired description must not POSITIVELY claim execution semantics — it only updates lastFiredAt bookkeeping',
    )
    // Codex P0 saga 9 lived practice: the description must NOT claim the
    // daemon's next cron tick will observe / skip / re-read this file
    // change. The daemon's nextFireAt is an in-memory cache that is NOT
    // invalidated by external file changes (relvetia-daemon/src/scheduler
    // .ts L142-162). Saga 7+8 lesson §17 NEW extension Lesson D = "call
    // graph + execution semantics 全 verify" not just writeFile-level grep.
    assert.doesNotMatch(
      desc,
      /next cron tick will (observe|skip|refresh|re-?read)|daemon will skip|cron will be suppressed/i,
      'distill_mark_fired description must not claim the daemon next cron tick observes/skips this file change — the nextFireAt cache is not invalidated by external writes (saga 9 P0)',
    )
    // Positive contract sentinel: description MUST scope the semantic to
    // lastFiredAt + name the mutated file (scheduled_tasks.json) AND
    // include explicit dual negation (subprocess + daemon schedule).
    assert.match(desc, /lastFiredAt/,
      'distill_mark_fired description must scope its semantic to lastFiredAt update')
    assert.match(desc, /scheduled_tasks\.json/,
      'distill_mark_fired description must name the file it mutates (scheduled_tasks.json)')
    assert.match(desc, /(does not|does NOT|never)\s+(spawn|invoke|run|trigger)/i,
      'distill_mark_fired description must explicitly state it does NOT spawn/invoke/run/trigger a subprocess')
    assert.match(desc, /(does not|does NOT|not invalidated|not refreshed).*nextFireAt|nextFireAt.*(in-memory|not (invalidated|refreshed))/i,
      'distill_mark_fired description must explicitly state the daemon nextFireAt cache is not invalidated/refreshed by this write')
    // The description MUST point the operator to the actual execution path
    // (/relvetia dream slash) so they can do real work if they wanted to.
    assert.match(desc, /\/relvetia dream/,
      'distill_mark_fired description must redirect to /relvetia dream slash command for actual distill invocation')
  })

  it('distill_status description claims read-only', () => {
    const desc = serverMod.server._registeredTools.distill_status.description
    assert.match(desc, /read-only|never mutates|read.only/i,
      'distill_status description must claim read-only')
  })

  it('walker_status description claims read-only', () => {
    const desc = serverMod.server._registeredTools.walker_status.description
    assert.match(desc, /read-only|never mutates|read.only/i,
      'walker_status description must claim read-only')
  })

  it('scheduled_task_list description claims read-only', () => {
    const desc = serverMod.server._registeredTools.scheduled_task_list.description
    assert.match(desc, /read-only|never mutates|read.only/i,
      'scheduled_task_list description must claim read-only')
  })

  it('scheduled_task_create description honestly says it ONLY writes scheduled_tasks.json (and never permanent)', () => {
    const desc = serverMod.server._registeredTools.scheduled_task_create.description
    // Must NOT claim to set permanent=true; permanent is bootstrap-owned.
    assert.doesNotMatch(desc, /sets? permanent=true|registers? permanent/i,
      'scheduled_task_create must not claim to set permanent=true (bootstrap-only)')
    assert.match(desc, /scheduled_tasks\.json/,
      'scheduled_task_create description must name the file it mutates (scheduled_tasks.json)')
  })

  it('scheduled_task_cancel description honestly says it refuses permanent tasks', () => {
    const desc = serverMod.server._registeredTools.scheduled_task_cancel.description
    assert.match(desc, /permanent/i,
      'scheduled_task_cancel description must acknowledge the permanent-refuse rule')
    assert.match(desc, /scheduled_tasks\.json/,
      'scheduled_task_cancel description must name the file it mutates (scheduled_tasks.json)')
  })

  // ----- Zod schema acceptance / rejection -----

  it('distill_mark_fired Zod schema accepts {} and {force,taskId}', () => {
    const t = serverMod.server._registeredTools.distill_mark_fired
    assert.doesNotThrow(() => t.inputSchema.parse({}))
    assert.doesNotThrow(() => t.inputSchema.parse({ force: true }))
    assert.doesNotThrow(() => t.inputSchema.parse({ taskId: 'relvetia-verify' }))
    assert.doesNotThrow(() => t.inputSchema.parse({ force: false, taskId: 'relvetia-dream' }))
  })

  it('distill_status Zod schema accepts only empty object', () => {
    const t = serverMod.server._registeredTools.distill_status
    assert.doesNotThrow(() => t.inputSchema.parse({}))
  })

  it('walker_status Zod schema accepts only empty object', () => {
    const t = serverMod.server._registeredTools.walker_status
    assert.doesNotThrow(() => t.inputSchema.parse({}))
  })

  it('scheduled_task_list Zod schema accepts includePermanent boolean', () => {
    const t = serverMod.server._registeredTools.scheduled_task_list
    assert.doesNotThrow(() => t.inputSchema.parse({}))
    assert.doesNotThrow(() => t.inputSchema.parse({ includePermanent: true }))
    assert.doesNotThrow(() => t.inputSchema.parse({ includePermanent: false }))
  })

  it('scheduled_task_create Zod schema requires non-empty cron + prompt', () => {
    const t = serverMod.server._registeredTools.scheduled_task_create
    assert.doesNotThrow(() => t.inputSchema.parse({ cron: '0 9 * * *', prompt: 'p' }))
    assert.throws(() => t.inputSchema.parse({ cron: '', prompt: 'p' }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({ cron: '0 9 * * *', prompt: '' }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({}), /required|invalid_type/i)
  })

  it('scheduled_task_cancel Zod schema requires non-empty id', () => {
    const t = serverMod.server._registeredTools.scheduled_task_cancel
    assert.doesNotThrow(() => t.inputSchema.parse({ id: 'abc' }))
    assert.throws(() => t.inputSchema.parse({ id: '' }), /too_small|min/i)
    assert.throws(() => t.inputSchema.parse({}), /required|invalid_type/i)
  })

  // ----- safeTool strict-mode unknown-key reject (saga 8 §17 lived practice) -----

  for (const { name, baseArgs } of [
    { name: 'distill_mark_fired',       baseArgs: {} },
    { name: 'distill_status',        baseArgs: {} },
    { name: 'walker_status',         baseArgs: {} },
    { name: 'scheduled_task_list',   baseArgs: {} },
    { name: 'scheduled_task_create', baseArgs: { cron: '0 9 * * *', prompt: 'ok' } },
    { name: 'scheduled_task_cancel', baseArgs: { id: 'gone' } },
  ]) {
    it(`${name} rejects unknown keys at the safeTool strict boundary (saga 8 P1 #1 lived practice)`, async () => {
      const t = serverMod.server._registeredTools[name]
      const r = await t.handler({ ...baseArgs, bogus_extra: 1 }, {})
      assert.equal(r.isError, true, `${name}: unknown key must trigger isError envelope`)
      assert.match(r.content[0].text, /unrecognized|extra|unknown|bogus_extra|strict/i,
        `${name}: error text should describe the strict reject; got: ${r.content[0].text}`)
    })
  }

  // ----- safeTool normal-envelope smoke (each tool returns text + structuredContent) -----

  it('safeTool normal envelope on distill_status', async () => {
    const r = await serverMod.server._registeredTools.distill_status.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(Array.isArray(r.structuredContent.tasks))
    assert.equal(r.structuredContent.tasks.length, 3)
  })

  it('safeTool normal envelope on walker_status (graceful when schedule.json absent)', async () => {
    const r = await serverMod.server._registeredTools.walker_status.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(Array.isArray(r.structuredContent.walkers))
  })

  it('safeTool normal envelope on scheduled_task_list (empty fixture)', async () => {
    const r = await serverMod.server._registeredTools.scheduled_task_list.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.ok(Array.isArray(r.content))
    assert.ok(Array.isArray(r.structuredContent.tasks))
  })

  // ----- Permanent-task refuse boundary sentinel -----

  it('scheduled_task_cancel boundary refuses permanent task even when handler is called directly', async () => {
    // Prime the fixture with a permanent task.
    const permTasksPath = join(FIXTURE_DAEMON_DIR, '.claude', 'scheduled_tasks.json')
    await writeFile(permTasksPath, JSON.stringify({
      tasks: [{ id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p', createdAt: 1, recurring: true, permanent: true }],
    }, null, 2))
    const r = await serverMod.server._registeredTools.scheduled_task_cancel.handler({ id: 'relvetia-dream' }, {})
    assert.notEqual(r.isError, true)  // graceful, not an error
    assert.equal(r.structuredContent.cancelled, false)
    assert.match(r.content[0].text, /permanent/i)
    // File must NOT have been mutated.
    const raw = await readFile(permTasksPath, 'utf-8')
    const file = JSON.parse(raw)
    assert.equal(file.tasks.length, 1)
    assert.equal(file.tasks[0].id, 'relvetia-dream')
    // Reset for subsequent tests
    await writeFile(permTasksPath, JSON.stringify({ tasks: [] }, null, 2))
  })

  // ----- Cooldown gate boundary sentinel -----

  it('distill_mark_fired boundary blocks within 6h cooldown when force=false', async () => {
    const tasksPath = join(FIXTURE_DAEMON_DIR, '.claude', 'scheduled_tasks.json')
    const lastFired = Date.now() - 60_000  // 1 minute ago
    await writeFile(tasksPath, JSON.stringify({
      tasks: [{ id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p', createdAt: 1, lastFiredAt: lastFired, recurring: true, permanent: true }],
    }, null, 2))
    const r = await serverMod.server._registeredTools.distill_mark_fired.handler({}, {})
    assert.notEqual(r.isError, true)
    assert.equal(r.structuredContent.marked, false)
    assert.match(r.content[0].text, /Cooldown active/)
    // Reset
    await writeFile(tasksPath, JSON.stringify({ tasks: [] }, null, 2))
  })

  it('distill_mark_fired boundary bypasses cooldown when force=true', async () => {
    const tasksPath = join(FIXTURE_DAEMON_DIR, '.claude', 'scheduled_tasks.json')
    const lastFired = Date.now() - 60_000
    await writeFile(tasksPath, JSON.stringify({
      tasks: [{ id: 'relvetia-dream', cron: '0 3 * * *', prompt: 'p', createdAt: 1, lastFiredAt: lastFired, recurring: true, permanent: true }],
    }, null, 2))
    const r = await serverMod.server._registeredTools.distill_mark_fired.handler({ force: true }, {})
    assert.notEqual(r.isError, true)
    assert.equal(r.structuredContent.marked, true)
    // Reset
    await writeFile(tasksPath, JSON.stringify({ tasks: [] }, null, 2))
  })
})
