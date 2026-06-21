/**
 * walker-executor.ts — Agent SDK invoker for private walker family.
 *
 * daemon の handleFire (index.ts) から呼ばれて walker child process を spawn
 * する。distill family の executePrompt (executor.ts) とは別経路:
 *
 *   - distill family: claude --print -p (single shot, mcp 不可、turn 観測不可)
 *   - walker family : tsx walker.ts → Agent SDK query() (turn 観測 / mcp 動的)
 *
 * 両者は共存。walker-executor.ts は walker.ts を spawn するだけで、Agent SDK
 * 自体は walker.ts (private 側) が呼び出す。daemon 自身は SDK に依存しない
 * (依存は walker.ts に閉じる、wave3-bring-forward.md 整合判断 §1.1)。
 *
 * walker.ts は ~/.claude/relvetia/private/walkers/{x,discord}-walker.ts に
 * 配置されており、tsx が直接 .ts を実行する (build 不要)。
 */

import { spawn } from 'child_process'
import { join } from 'path'
import { getRelvetiaDir } from './dirs.js'
import type { CronTask } from './tasks.js'

/** Base dir holding the persona walker .ts sources. Defaults to
 *  `<RELVETIA_DIR>/private/walkers` (so overriding RELVETIA_DIR relocates the
 *  whole layout), with an explicit `RELVETIA_WALKERS_DIR` override for
 *  deployments that keep walker sources elsewhere. */
const WALKERS_DIR =
  process.env.RELVETIA_WALKERS_DIR ?? join(getRelvetiaDir(), 'private', 'walkers')

/** Map task.id → walker .ts source path. relvetic 領域: 新 walker 種別を
 *  追加する時はここに 1 行足す。 */
export const WALKER_PATHS: Record<string, string> = {
  'private-walker-x': join(WALKERS_DIR, 'x-walker.ts'),
  'private-walker-discord': join(WALKERS_DIR, 'discord-walker.ts'),
}

/** walker family の hard timeout。walker prompt 内の MAX_WALL_MS (300s) よりも
 *  少し長く取り、SDK の cleanup 余裕を含めて 6 分。これを超えたら SIGTERM で
 *  kill する (walker-architecture §9.3 失敗判断の最後の砦)。 */
export const DEFAULT_WALKER_TIMEOUT_MS = 6 * 60 * 1000

/** walker child を spawn するときの env builder。test から差し替え可能に
 *  export しておく。RELVETIA_DAEMON_CHILD=1 は memory-load.sh の Axis B
 *  gate を通すため必須。 */
export function buildWalkerEnv(taskId: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RELVETIA_DAEMON_CHILD: '1',
    WALKER_TASK_ID: taskId,
  }
}

export type RunWalkerOptions = {
  /** Override walker .ts path. test 用 (default は WALKER_PATHS[task.id])。 */
  walkerPath?: string
  /** Hard timeout ms。default DEFAULT_WALKER_TIMEOUT_MS。 */
  timeoutMs?: number
  /** spawn に使う command。default 'tsx'。test では 'node' 等に置換可。 */
  command?: string
  /** spawn に渡す追加引数 (walkerPath は自動で末尾追加)。 */
  extraArgs?: string[]
  /** spawn の cwd。default ~/.claude/relvetia/private。 */
  cwd?: string
  /** env 追加 / override。default は buildWalkerEnv(task.id) のみ。 */
  extraEnv?: Record<string, string>
}

export type RunWalkerResult = {
  exitCode: number
  /** true when timeout fired and SIGTERM was sent. */
  timedOut: boolean
  /** wall clock ms */
  elapsedMs: number
}

/**
 * Spawn the walker child process for `task.id`. Returns when the child exits
 * (either naturally or via SIGTERM after timeout). Never throws on non-zero
 * exit — exitCode is propagated to the caller (handleFire) which classifies
 * walker outcomes via handle-fire.ts (LOG_ONLY_TASK_IDS).
 */
export async function runWalker(
  task: CronTask,
  opts: RunWalkerOptions = {},
): Promise<RunWalkerResult> {
  const walkerPath = opts.walkerPath ?? WALKER_PATHS[task.id]
  if (!walkerPath) {
    throw new Error(`[walker-executor] no walker mapping for task ${task.id}`)
  }

  const command = opts.command ?? 'tsx'
  const extraArgs = opts.extraArgs ?? []
  const cwd =
    opts.cwd ?? process.env.RELVETIA_WALKER_CWD ?? join(getRelvetiaDir(), 'private')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WALKER_TIMEOUT_MS
  const env = { ...buildWalkerEnv(task.id), ...(opts.extraEnv ?? {}) }

  const start = Date.now()

  return new Promise<RunWalkerResult>((resolve) => {
    // Production callers leave extraArgs empty, so this resolves to
    // [walkerPath] — the .ts file tsx executes. Test callers override
    // with `extraArgs: ['-e', 'process.exit(0)']` and pass a sentinel
    // walkerPath, expecting walkerPath to be ignored when extraArgs is
    // supplied (per the test's own comment). Appending walkerPath
    // unconditionally was a Windows-only happy accident: Linux node
    // treats trailing positional args after `-e SCRIPT` strictly enough
    // to fail the spawned process, which surfaced on PR #27 CI as three
    // walker-executor.test.ts failures.
    const args = extraArgs.length > 0 ? extraArgs : [walkerPath]
    // Windows で .cmd ラッパー (tsx 等) を起動するため、既存の executor.ts と
    // 同じパターンで shell を使う。ただし shell:true だと SIGTERM が shell
    // にしか届かず child node が生き残るので、shell: false で .cmd を直接
    // resolve させる方が確実。ここでは command が node や 絶対パスの場合は
    // shell 不要、tsx 等 PATH 依存コマンドの場合のみ shell を要求する。
    const needsShell = process.platform === 'win32'
      && !command.includes('/')
      && !command.includes('\\')
      && command !== 'node'
    const child = spawn(command, args, {
      cwd,
      env,
      // walker は外世界に副作用を持つので stdio は inherit して daemon log に流す
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: needsShell,
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      console.warn(
        `[walker-executor] task=${task.id} timed out after ${timeoutMs}ms, sending SIGTERM`,
      )
      child.kill('SIGTERM')
      // SIGTERM を無視する場合の保険として 5s 後に SIGKILL
      setTimeout(() => {
        if (!child.killed) {
          console.warn(`[walker-executor] task=${task.id} did not exit after SIGTERM, SIGKILL`)
          child.kill('SIGKILL')
        }
      }, 5_000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      clearTimeout(timer)
      console.error(`[walker-executor] task=${task.id} spawn error:`, err)
      resolve({ exitCode: 1, timedOut, elapsedMs: Date.now() - start })
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - start
      const exitCode = typeof code === 'number' ? code : (signal ? 143 : 1)
      console.log(
        `[walker-executor] task=${task.id} status=exited code=${exitCode} elapsed_ms=${elapsedMs}${
          timedOut ? ' (timed-out)' : ''
        }`,
      )
      resolve({ exitCode, timedOut, elapsedMs })
    })
  })
}
