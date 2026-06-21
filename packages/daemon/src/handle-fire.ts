/**
 * Pure decision helpers for handleFire side effects.
 * Kept separate from index.ts so the policy is unit-testable
 * without spinning up the full daemon entry point.
 */

const DISTILL_TASK_IDS = ['relvetia-dream', 'relvetia-verify', 'relvetia-optimize'] as const
const STAMP_DISTILL_TASK_IDS = ['relvetia-dream', 'private-distill'] as const
/** Task ids whose work writes only to daily logs. They never stamp
 *  distillation markers, never run git-sync, and are exempt from the
 *  failure-budget. The next distill cycle picks up their output.
 *
 *  Walker family (private-walker-*) shares this axis: walker は外世界に
 *  副作用を持つが、memory への書込は curiosity.md / daily log のみで、
 *  distill markers (.last-distill / .last-hiergen.json) は触らない。
 *  失敗判断は walker 内 private 本人 + walker-executor の 6 分 timeout で
 *  二段、daemon 側 failure-budget は distill family 専用に保つ
 *  (wave3-bring-forward.md §1.1 / walker-architecture.md §9.3)。 */
const LOG_ONLY_TASK_IDS = [
  'private-walker-x',
  'private-walker-discord',
] as const

/** True for any walker family task id. handle-fire / failure-budget の
 *  axis 判定で使う。基本 LOG_ONLY_TASK_IDS と同義だが、HH:MM 分散時に
 *  task id に suffix が付くケース (例: private-walker-x-09-00) を吸収する。 */
export function isWalkerTaskId(taskId: string): boolean {
  return taskId.startsWith('private-walker-')
}

export type FireOutcome =
  | { kind: 'failure'; exitCode: number }
  | {
      kind: 'success'
      stampDistill: boolean    // write .last-distill
      stampHiergen: boolean    // write .last-hiergen.json (hier mode only)
      gitSync: boolean         // commit-and-push memory repo
    }

/**
 * Classify a fire result into the side effects the daemon should perform.
 * Non-zero exit = failure: skip stamp + git sync (no memory delta produced).
 * Zero exit = success: stamp distillation tasks; git-sync the distill family.
 * Log-only tasks (walker family) never stamp or sync regardless of exit
 * code, since their output is consumed by the next distill cycle.
 */
export function classifyFireOutcome(
  taskId: string,
  exitCode: number,
  distillMode: 'hier' | 'rec',
): FireOutcome {
  if (exitCode !== 0) {
    return { kind: 'failure', exitCode }
  }
  // Walker tasks (private-walker-*) are log-only too, including the suffix
  // forms (e.g. private-walker-x-09-00) that bootstrap.ts may emit when the
  // schedule has minute-mismatched HH:MM entries.
  if ((LOG_ONLY_TASK_IDS as readonly string[]).includes(taskId) || isWalkerTaskId(taskId)) {
    return {
      kind: 'success',
      stampDistill: false,
      stampHiergen: false,
      gitSync: false,
    }
  }
  return {
    kind: 'success',
    stampDistill: (STAMP_DISTILL_TASK_IDS as readonly string[]).includes(taskId),
    stampHiergen: taskId === 'relvetia-dream' && distillMode === 'hier',
    gitSync: (DISTILL_TASK_IDS as readonly string[]).includes(taskId),
  }
}
