/**
 * Bootstrap — registers permanent system tasks on first daemon start.
 *
 * For permanent tasks with a `promptFile`, the file content is the source of
 * truth: on every daemon start the in-disk task's `prompt` field is refreshed
 * from the file. This means edits to `prompts/distill.md` propagate on the
 * next daemon restart without requiring `scheduled_tasks.json` deletion.
 * Other state (id, lastFiredAt, createdAt, cron, recurring/permanent flags)
 * is preserved.
 */

import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { readCronTasks, addCronTask, writeCronTasks, type CronTask } from './tasks.js'

type PermanentTaskDef = {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  permanent: boolean
  promptFile?: string
  nativeHandler?: string
}

const STATIC_PERMANENT_TASKS: PermanentTaskDef[] = [
  {
    id: 'relvetia-dream',
    cron: '0 3 * * *',  // 3:00 AM daily
    prompt: '',  // Will be loaded from distill.md
    recurring: true,
    permanent: true,
    promptFile: 'distill.md',
  },
  {
    id: 'relvetia-verify',
    cron: '30 3 * * *',  // 3:30 AM daily (after distillation)
    prompt: '',  // Will be loaded from verify-prompt.md
    recurring: true,
    permanent: true,
    promptFile: 'verify-prompt.md',
    nativeHandler: process.env.RELVETIA_VERIFY_NATIVE === '1' ? 'verifyRunner' : undefined,
  },
  {
    id: 'relvetia-optimize',
    cron: '0 4 * * 0',  // 4:00 AM every Sunday (after daily distill+verify)
    prompt: '',  // Will be loaded from optimize-prompt.md
    recurring: true,
    permanent: true,
    promptFile: 'optimize-prompt.md',
  },
]

/**
 * Private memory zone distillation — opt-in.
 *
 * Registered only when `RELVETIA_DAEMON_TASKS` env includes `private-distill`.
 * The 2nd ecosystem entry `relvetia-daemon-private` sets this; the main
 * daemon does not, so the main daemon never adds private-distill to its
 * scheduled_tasks.json. This prevents the race where both daemons would
 * otherwise fire the same task at 3:15 AM.
 *
 * The prompt is a static fork of distill.md with `~/.claude/memory/` paths
 * rewritten to `~/.claude/memory/private/` — see prompts/distill-private.md
 * derived note for porting rules when main distill.md changes.
 *
 * Cron offset 3:15 AM (15 min after main relvetia-dream) reduces API
 * congestion: main daemon usually completes in a few minutes, so private
 * distill starts on a quiet API channel.
 */
const PRIVATE_DISTILL_TASK: PermanentTaskDef = {
  id: 'private-distill',
  cron: '15 3 * * *',
  prompt: '',  // Will be loaded from distill-private.md
  recurring: true,
  permanent: true,
  promptFile: 'distill-private.md',
}

// ---------------------------------------------------------------------------
// Walker schedule (W3-K/L/M, walker-schedule.md / walker-architecture.md)
// ---------------------------------------------------------------------------
//
// walker schedule は schedule.json (本人改変 surface) で管理。bootstrap 起動時に
// 1 度だけ HH:MM list → 5-field cron に変換して PERMANENT_TASKS に展開する
// (v1 restart-only、wave3-bring-forward.md §1.2 採用判断 #1-3)。
//
// 動的反映は v1 では諦める (scheduler.ts:144-162 の nextFireAt map が cron 不変
// 前提のため、runtime cron 書換えは double-fire リスク)。
// schedule.json の改変は pm2 restart で反映される。

const WALKER_SCHEDULE_PATH = join(
  homedir(), '.claude', 'relvetia', 'private', 'walkers', 'schedule.json',
)

type WalkerScheduleFile = {
  $schema?: string
  walkers?: Record<string, {
    enabled?: boolean
    schedule?: unknown[]
    note?: string
  }>
  _meta?: {
    default_fallback_schedule?: unknown[]
    [k: string]: unknown
  }
}

/** "09:00" → "0 9 * * *" 等の 5-field cron に変換。
 *  不正値は null を返す (walker-schedule.md §3.4 graceful degrade)。 */
export function hhmmToCron(hhmm: unknown): string | null {
  if (typeof hhmm !== 'string') return null
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const hh = parseInt(m[1], 10)
  const mm = parseInt(m[2], 10)
  if (isNaN(hh) || isNaN(mm)) return null
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
  return `${mm} ${hh} * * *`
}

/** schedule.json の HH:MM list 群を PermanentTaskDef 群に変換する。
 *  HH:MM が複数あれば cron field の minute を `,` join で 1 タスクに集約。
 *  例: ["09:00", "21:00"] → "0 9,21 * * *"
 *  時刻が混在する場合 (例: "09:00", "13:30") は 1 タスクで表現できないので
 *  task id に suffix を付けて分割: private-walker-x → private-walker-x-09-00 等。
 *  v1 ではすべて time が異なる場合、それぞれを別 task として登録する方式を採用
 *  (walker-architecture.md §11.3 表現拡張余地、v1 は HH:MM list を素直に展開)。 */
export function walkerScheduleToTasks(
  walkerId: string,
  schedule: unknown[],
): PermanentTaskDef[] {
  const validHHMMs: Array<{ hh: number; mm: number; raw: string }> = []
  for (const item of schedule ?? []) {
    if (typeof item !== 'string') continue
    const m = item.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const hh = parseInt(m[1], 10)
    const mm = parseInt(m[2], 10)
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) continue
    validHHMMs.push({ hh, mm, raw: item })
  }
  if (validHHMMs.length === 0) return []

  // minute がすべて同じなら hour を `,` で集約して 1 task に。違うなら別 task。
  const allSameMinute = validHHMMs.every(v => v.mm === validHHMMs[0].mm)
  if (allSameMinute) {
    const hours = validHHMMs.map(v => v.hh).sort((a, b) => a - b).join(',')
    return [{
      id: walkerId,
      cron: `${validHHMMs[0].mm} ${hours} * * *`,
      prompt: `<native:runWalker:${walkerId}>`,
      recurring: true,
      permanent: true,
      nativeHandler: 'runWalker',
    }]
  }

  // 分が違う場合は時刻ごとに別 task に分割 (id に suffix)
  return validHHMMs.map((v) => ({
    id: `${walkerId}-${v.raw.replace(':', '-')}`,
    cron: `${v.mm} ${v.hh} * * *`,
    prompt: `<native:runWalker:${walkerId}>`,
    recurring: true,
    permanent: true,
    nativeHandler: 'runWalker',
  }))
}

/** schedule.json を読んで PermanentTaskDef[] に展開。
 *  読めない / 壊れた / 全 walker disabled の場合は空配列。 */
export async function loadWalkerPermanentTasks(
  schedulePath: string = WALKER_SCHEDULE_PATH,
): Promise<PermanentTaskDef[]> {
  let parsed: WalkerScheduleFile
  try {
    const raw = await readFile(schedulePath, 'utf-8')
    parsed = JSON.parse(raw) as WalkerScheduleFile
  } catch (e) {
    console.warn(
      `[relvetia-bootstrap] walker schedule.json read failed (no walker tasks): ${e}`,
    )
    return []
  }

  const tasks: PermanentTaskDef[] = []
  for (const [id, cfg] of Object.entries(parsed.walkers ?? {})) {
    if (!cfg) continue
    if (cfg.enabled === false) continue
    if (!Array.isArray(cfg.schedule) || cfg.schedule.length === 0) continue
    tasks.push(...walkerScheduleToTasks(id, cfg.schedule))
  }
  return tasks
}

/**
 * Ensure all permanent system tasks exist in scheduled_tasks.json.
 * Creates missing tasks; for existing ones, refreshes the `prompt` field
 * from `promptFile` (preserving lastFiredAt and other state) so prompt
 * source edits take effect on the next daemon start. (issue #7)
 *
 * Also expands walker tasks from schedule.json (W3-K/L/M). schedule.json の
 * HH:MM list を 5-field cron に変換して permanent tasks として登録する
 * (v1 restart-only、walker-schedule.md §4.2)。
 *
 * 既存の walker task で desired list に居ないものは削除する (本人が
 * `enabled: false` or `schedule: []` で suppress した場合の反映)。
 */
export async function bootstrapPermanentTasks(
  dir: string,
  promptsDir: string,
  walkerSchedulePath?: string,
): Promise<void> {
  const existing = await readCronTasks(dir)
  const byId = new Map(existing.map(t => [t.id, t]))

  // Registration-side gate for RELVETIA_DAEMON_TASKS.
  // When the env is set (CSV whitelist), only listed task ids are registered
  // in scheduled_tasks.json. The private daemon entry sets this to
  // `private-distill`. Main daemon leaves it unset → null → all tasks pass.
  // private-distill itself is opt-in: only added to the candidate list when
  // explicitly whitelisted (so main daemon never registers it).
  const allowedTaskIds = process.env.RELVETIA_DAEMON_TASKS
    ? new Set(
        process.env.RELVETIA_DAEMON_TASKS.split(',')
          .map(s => s.trim())
          .filter(Boolean),
      )
    : null
  const includePrivateDistill = allowedTaskIds?.has('private-distill') ?? false

  // walker tasks を schedule.json から展開
  const walkerTasks = await loadWalkerPermanentTasks(
    walkerSchedulePath ?? WALKER_SCHEDULE_PATH,
  )
  const candidate: PermanentTaskDef[] = [...STATIC_PERMANENT_TASKS, ...walkerTasks]
  if (includePrivateDistill) candidate.push(PRIVATE_DISTILL_TASK)
  const PERMANENT_TASKS: PermanentTaskDef[] = allowedTaskIds
    ? candidate.filter(t => allowedTaskIds.has(t.id))
    : candidate
  const desiredIds = new Set(PERMANENT_TASKS.map(t => t.id))

  // Pre-load all prompt-file contents in parallel.
  const promptContents = new Map<string, string>()
  await Promise.all(
    PERMANENT_TASKS.filter(d => d.promptFile).map(async (def) => {
      try {
        const content = await readFile(join(promptsDir, def.promptFile!), 'utf-8')
        promptContents.set(def.id, content)
      } catch (e) {
        console.error(`[relvetia-bootstrap] failed to read prompt file ${def.promptFile}:`, e)
      }
    }),
  )

  let updated = false
  let newTasks: CronTask[] = [...existing]

  // walker task 群: 既存にあって desired にない (本人 disable / schedule 削除)
  // ものは scheduled_tasks.json から削除する
  for (const t of existing) {
    const isWalker = t.nativeHandler === 'runWalker' ||
      t.id.startsWith('private-walker-')
    if (isWalker && !desiredIds.has(t.id)) {
      console.log(`[relvetia-bootstrap] removing stale walker task '${t.id}'`)
      newTasks = newTasks.filter(x => x.id !== t.id)
      byId.delete(t.id)
      updated = true
    }
  }

  // memory-hardening Phase 1 (2026-05-18, docs/recovery-fire-paths.md):
  // relvetia-recover task was deleted along with src/recovery.ts. Any stale
  // entry left in scheduled_tasks.json from earlier daemon versions would
  // fire with `unknown nativeHandler 'recoverMissedSessions'`. Drop it on
  // startup so the next cron tick passes through cleanly. The write happens
  // here (not via the end-of-function `updated` write) so a follow-on
  // addCronTask call for a missing distill task does not get clobbered by a
  // deferred writeCronTasks of the pre-add `newTasks` snapshot.
  const beforeCleanup = newTasks.length
  newTasks = newTasks.filter(t => t.id !== 'relvetia-recover')
  if (newTasks.length !== beforeCleanup) {
    console.log(`[relvetia-bootstrap] removing deprecated task 'relvetia-recover' (Phase 1 deletion)`)
    byId.delete('relvetia-recover')
    await writeCronTasks(newTasks, dir)
  }

  for (const def of PERMANENT_TASKS) {
    const desiredPrompt = def.promptFile ? promptContents.get(def.id) : def.prompt
    if (desiredPrompt === undefined) continue  // prompt-file read failed; leave task alone

    const existingTask = byId.get(def.id)
    if (existingTask) {
      // Refresh prompt content if it has drifted from the file (issue #7).
      // Preserve everything else (id, createdAt, lastFiredAt, cron, flags).
      let changed = false
      if (existingTask.prompt !== desiredPrompt) {
        existingTask.prompt = desiredPrompt
        changed = true
      }
      // Refresh nativeHandler in case the registry adds/removes one between
      // daemon versions.
      if (existingTask.nativeHandler !== def.nativeHandler) {
        if (def.nativeHandler) {
          existingTask.nativeHandler = def.nativeHandler
        } else {
          delete existingTask.nativeHandler
        }
        changed = true
      }
      // Walker tasks: schedule.json (本人改変 surface) は cron も source of
      // truth なので、HH:MM 改変が pm2 restart 時に反映されるよう cron も
      // refresh する。distill family の cron は STATIC で固定なので影響なし。
      const isWalker = def.nativeHandler === 'runWalker'
      if (isWalker && existingTask.cron !== def.cron) {
        existingTask.cron = def.cron
        changed = true
      }
      if (changed) {
        updated = true
        console.log(
          `[relvetia-bootstrap] refreshed task '${def.id}' (${desiredPrompt.length} chars${
            def.nativeHandler ? `, native:${def.nativeHandler}` : ''
          }${isWalker ? `, cron=${def.cron}` : ''})`,
        )
      } else {
        console.log(`[relvetia-bootstrap] permanent task '${def.id}' already up-to-date`)
      }
      continue
    }

    // New permanent task — register fresh.
    await addCronTask(
      dir,
      def.cron,
      desiredPrompt,
      def.recurring,
      def.permanent,
      def.id,
      def.nativeHandler,
    )
    console.log(`[relvetia-bootstrap] registered permanent task '${def.id}'`)
  }

  if (updated) {
    await writeCronTasks(newTasks, dir)
  }
}

// ---------------------------------------------------------------------------
// Ensure canonical residual-index format on daemon startup
// (memory-hardening-followup Phase D, 2026-05-19).
//
// Production drift observed: ~/.claude/memory/index.json was
//   { version: 1, entries: [ {id,...}, {id,...}, ... ] }
// instead of the canonical
//   { version: 1, entries: { "<id>": {...}, ... } }.
//
// readResidualIndex() silently re-keys the array shape on read so consumers
// don't notice, but the file on disk is never rewritten unless something
// happens to call writeResidualIndex() (today: only remediateMissingEntries
// when verify finds misses → 0 calls on a healthy run). On every daemon
// startup, normalize the file once so the canonical shape is the source of
// truth and any future drift is bounded to one cron cycle.
//
// Idempotent: a canonical-shape file is a no-op (read → shape check → return).
// ---------------------------------------------------------------------------

export async function ensureCanonicalIndexFormat(memoryDir: string): Promise<void> {
  const { readResidualIndex, writeResidualIndex } = await import(
    '../../extracted/memory/residualIndex.js'
  )
  const { readFile } = await import('fs/promises')
  const indexPath = join(memoryDir, 'index.json')

  let parsed: unknown
  try {
    const raw = await readFile(indexPath, 'utf8')
    parsed = JSON.parse(raw)
  } catch {
    // Missing or malformed file: leave alone. readResidualIndex returns an
    // empty index for both cases, so search keeps working; rewriting an
    // empty canonical here would also destroy any malformed file we might
    // want to recover by hand.
    return
  }

  if (isCanonicalShape(parsed)) return

  const index = await readResidualIndex(memoryDir)
  await writeResidualIndex(memoryDir, index)
  console.log(
    `[relvetia-bootstrap] normalized index.json to canonical shape (${
      Object.keys(index.entries).length
    } entries)`,
  )
}

function isCanonicalShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const entries = (parsed as { entries?: unknown }).entries
  return !!entries && typeof entries === 'object' && !Array.isArray(entries)
}

// ---------------------------------------------------------------------------
// Numeric → hierarchical entry id normalizer
// (memory-hardening-followup Phase A, 2026-05-19).
//
// On 2026-05-19 03:04 the distill pass wrote 8 new entries (110-117) with
// bare numeric ids — bypassing `generateEntryId()`'s slug-safe format. The
// distill prompt documented the format but had no enforcement path, and
// `generateEntryId` had zero production callers outside tests.
//
// This hook fires on every daemon startup. It detects any entry whose id
// matches /^\d+$/, rewrites it via `generateEntryId(topic, index)`, persists
// the old→new mapping under `~/.claude/memory/.migrations/`, and writes the
// index back. Idempotent: zero numeric ids → zero work, zero log noise.
// ---------------------------------------------------------------------------

export async function ensureHierarchicalEntryIds(memoryDir: string): Promise<void> {
  const { readResidualIndex, writeResidualIndex } = await import(
    '../../extracted/memory/residualIndex.js'
  )
  const { normalizeNumericIds, mergeMappings } = await import(
    '../../extracted/memory/normalizeNumericIds.js'
  )
  const { readFile, writeFile, mkdir } = await import('fs/promises')

  const index = await readResidualIndex(memoryDir)
  const { index: newIndex, mapping } = normalizeNumericIds(index)
  if (mapping.length === 0) return

  const today = new Date().toISOString().slice(0, 10)
  const migrationsDir = join(memoryDir, '.migrations')
  const migrationFile = join(migrationsDir, `${today}-numeric-to-hier.json`)
  await mkdir(migrationsDir, { recursive: true })

  let existing: Array<{ oldId: string; newId: string; topic: string; updated: string }> = []
  try {
    const raw = await readFile(migrationFile, 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed?.mappings)) existing = parsed.mappings
  } catch {
    // first run for today — file does not exist yet
  }

  const merged = mergeMappings(existing, mapping)
  await writeFile(
    migrationFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sprint: 'memory-hardening-followup-phase-A',
        mappings: merged,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  await writeResidualIndex(memoryDir, newIndex)
  console.log(
    `[relvetia-bootstrap] normalized ${mapping.length} numeric id(s) → hierarchical (mapping: ${migrationFile})`,
  )
}

// ---------------------------------------------------------------------------
// distillVerifier → evalStore wire (Memory Hardening Phase 5 T5-5).
// When the nightly verify pass cannot re-find a distilled entry via the
// search pipeline, append a missing-entry record to evalStore so the
// auto-eval-generator can seed a novel eval case from the gap.
//
// `evalDir` defaults to `~/.claude/relvetia-evals/` (same fallback as
// `evalCli.ts --eval-dir`); override via env `RELVETIA_EVAL_DIR`.
// ---------------------------------------------------------------------------

export async function wireDistillVerifierToEvalStore(
  evalDir?: string,
): Promise<void> {
  const { setOnMissingEntry } = await import(
    '../../extracted/memory/distillVerifier.js'
  )
  const { appendMissingEntryRecord } = await import(
    '../../extracted/evals/evalStore.js'
  )
  const targetDir = evalDir
    ?? process.env.RELVETIA_EVAL_DIR
    ?? join(homedir(), '.claude', 'relvetia-evals')

  setOnMissingEntry((entryId: string, summary: string, concepts: string[]) => {
    appendMissingEntryRecord(targetDir, {
      entryId,
      summary,
      concepts,
      observedAt: new Date().toISOString(),
    }).catch((e: unknown) => {
      console.error(
        `[relvetia-bootstrap] failed to record missing entry ${entryId}: ${e}`,
      )
    })
  })
  console.log(
    `[relvetia-bootstrap] wired distillVerifier.onMissingEntry → ${targetDir}/missing-entries/`,
  )
}
