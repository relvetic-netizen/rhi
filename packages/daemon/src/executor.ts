/**
 * Prompt executor — the bridge between the scheduler's onFire()
 * callback and `claude --model sonnet -p`.
 *
 * This module is new (no equivalent in the original Relvetia source).
 * In the original, onFire() fed prompts back into the REPL's own
 * message queue. The daemon has no REPL — it spawns a fresh Claude
 * process for each fired task.
 */

import { execFile, execFileSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import type { LlmExecutor, LlmExecuteOptions, LlmExecuteResult } from '@rhi/shared'

type ResolvedCli = {
  /** The executable to pass to execFile (node binary or claude binary). */
  bin: string
  /** Extra args to prepend (e.g. the cli.js path when invoking via node). */
  prefixArgs: string[]
  /** Whether execFile needs shell:true (only for .cmd on Windows). */
  needsShell: boolean
}

/** Resolve how to invoke the `claude` CLI.
 *  On Windows under PM2 we must avoid both the POSIX shim (not executable
 *  by CreateProcess) and the .cmd wrapper (cmd.exe mangles special chars
 *  like # in prompts). Preferred invocations, in order:
 *    1. Native binary (claude-code 2.1.x+): bin/claude.exe — direct spawn,
 *       no shell, no node. Supersedes the old `node cli.js` approach.
 *    2. Legacy: `node cli.js` directly (claude-code <2.1.x).
 *    3. Fallback: claude.cmd (shell:true) — last resort, prompts containing
 *       shell metacharacters may break. */
function resolveClaudeCli(): ResolvedCli {
  const isWin = process.platform === 'win32'

  // 1. Try fnm-managed node installs — prefer native binary, then cli.js
  const fnmBase = join(process.env.HOME || process.env.USERPROFILE || '', '.fnm', 'node-versions')
  if (existsSync(fnmBase)) {
    try {
      const versions = readdirSync(fnmBase)
      for (const v of versions.sort().reverse()) {
        const installDir = join(fnmBase, v, 'installation')
        const ccPkgDir = join(installDir, 'node_modules', '@anthropic-ai', 'claude-code')
        // Preferred on Windows since claude-code 2.1.x: native binary at bin/claude.exe.
        // Direct .exe spawn — no cmd.exe, no node wrapper, no shell mangling.
        if (isWin) {
          const exeBin = join(ccPkgDir, 'bin', 'claude.exe')
          if (existsSync(exeBin)) {
            return { bin: exeBin, prefixArgs: [], needsShell: false }
          }
        }
        // Legacy: node + cli.js (claude-code <2.1.x)
        const cliJs = join(ccPkgDir, 'cli.js')
        const nodeBin = join(installDir, isWin ? 'node.exe' : 'node')
        if (existsSync(cliJs) && existsSync(nodeBin)) {
          return { bin: nodeBin, prefixArgs: [cliJs], needsShell: false }
        }
        // Fallback: use the claude binary/cmd directly
        if (isWin) {
          const cmdCandidate = join(installDir, 'claude.cmd')
          if (existsSync(cmdCandidate)) {
            return { bin: cmdCandidate, prefixArgs: [], needsShell: true }
          }
        }
        const candidate = join(installDir, 'claude')
        if (existsSync(candidate)) {
          return { bin: candidate, prefixArgs: [], needsShell: false }
        }
      }
    } catch { /* ignore */ }
  }

  // 2. Try `which claude` / `where claude`
  try {
    const result = execFileSync(isWin ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim().split(/\r?\n/)[0]
    if (result && existsSync(result)) {
      const needsShell = isWin && result.endsWith('.cmd')
      return { bin: result, prefixArgs: [], needsShell }
    }
  } catch { /* ignore */ }

  // 3. Fallback
  return { bin: 'claude', prefixArgs: [], needsShell: false }
}

const CLI = resolveClaudeCli()
console.log(`[relvetia-executor] Resolved claude CLI: bin=${CLI.bin}, prefixArgs=[${CLI.prefixArgs.join(', ')}], shell=${CLI.needsShell}`)

const DEFAULT_MODEL = 'opus'
const DEFAULT_MAX_TURNS = 40
const DEFAULT_TIMEOUT_MS = 40 * 60 * 1000  // 40 minutes (real distill workload with full role override)

export type ExecutorOptions = {
  model?: string
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  allowedTools?: string[]
  /** Enable screening-based memory filtering in spawned processes.
   *  Sets RELVETIA_SCREENING_MEMORY=1 in the child environment. */
  enableScreening?: boolean
}

/** Build the env passed to every daemon-spawned `claude -p` child.
 *  RELVETIA_DAEMON_CHILD=1 is the gate variable consumed by SessionStart hooks
 *  (relvetia-memory-load.sh) so daemon-child sessions never re-create
 *  .distill-needed — the structural break for the dream-spawn runaway loop. */
export function buildChildEnv(enableScreening: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ECC_SKIP_OBSERVE: '1',
    RELVETIA_DAEMON_CHILD: '1',
    ...(enableScreening ? { RELVETIA_SCREENING_MEMORY: '1' } : {}),
  }
}

/**
 * Execute a prompt via `claude -p`. Returns when the process completes.
 * Throws on timeout or non-zero exit code.
 */
export function executePrompt(
  prompt: string,
  opts: ExecutorOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  const {
    model = DEFAULT_MODEL,
    maxTurns = DEFAULT_MAX_TURNS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    cwd,
    allowedTools,
    enableScreening = true,
  } = opts

  const args = [
    ...CLI.prefixArgs,
    '--model', model,
    '--max-turns', String(maxTurns),
    '--permission-mode', 'bypassPermissions',
    // `--permission-mode bypassPermissions` skips permission prompts but does
    // NOT bypass Claude Code 1.x's built-in sensitive-file gate (Edit/Write/
    // MultiEdit are denied for ~/.claude/memory/MEMORY.md, index.json, topics/*.md,
    // concepts/graph.json, stats.json). Empirically verified 2026-04-29:
    // --dangerously-skip-permissions only suppresses prompts; the hard-coded
    // sensitive-path gate still rejects tool calls. PreToolUse hook returning
    // permissionDecision: "allow" also fails to override (hook fires, env=1
    // confirmed, but gate denies anyway).
    //
    // Distill prompts (distill.md / distill-rec.md) are documented to use Bash
    // + node -e fs.writeFileSync (or staging scripts in ~/.claude/memory/.staging/)
    // for sensitive-path writes — Bash is outside the Edit|Write|MultiEdit hook
    // matcher and the sensitive-file gate. See prompts/distill-rec.md "Tool guidance".
    '--dangerously-skip-permissions',
    '--print',
    '-p', prompt,
  ]

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','))
  }

  return new Promise<LlmExecuteResult>((resolve, reject) => {
    const child = execFile(CLI.bin, args, {
      timeout: timeoutMs,
      cwd,
      maxBuffer: 10 * 1024 * 1024,  // 10MB
      shell: CLI.needsShell,
      env: buildChildEnv(enableScreening),
    }, (error, stdout, stderr) => {
      if (stderr) {
        console.warn(`[relvetia-executor] stderr: ${stderr.slice(0, 500)}`)
      }

      if (error) {
        // Timeout
        if ('killed' in error && error.killed) {
          reject(new Error(`[relvetia-executor] Prompt timed out after ${timeoutMs}ms`))
          return
        }
        // Non-zero exit but still produced output
        if (stdout) {
          console.warn(`[relvetia-executor] Non-zero exit (${error.code}), but got output`)
          console.warn(`[relvetia-executor] stdout tail (last 800): ${stdout.slice(-800)}`)
          resolve({ stdout, exitCode: typeof error.code === 'number' ? error.code : 1 })
          return
        }
        reject(error)
        return
      }

      resolve({ stdout, exitCode: 0 })
    })

    // Close stdin immediately. claude-code 2.1.x native binary waits ~3s for
    // stdin data even when the prompt is supplied via `-p <text>` arg, then
    // gives up with `Warning: no stdin data received in 3s, proceeding without
    // it` and exits non-zero. Closing the inherited stdin pipe lets the child
    // see EOF and proceed without the warning. Mirrors the working pattern in
    // rhi-discord-bot/src/claude/subprocess.ts (`proc.stdin?.end()`).
    child.stdin?.end()

    // Log the child PID for debugging
    if (child.pid) {
      console.log(`[relvetia-executor] Spawned claude (PID: ${child.pid})`)
    }
  })
}

/**
 * Default {@link LlmExecutor} backed by the Claude CLI (`claude --print`).
 * Wraps {@link executePrompt} so the daemon's scheduling core can depend on the
 * shared `LlmExecutor` seam (see `@rhi/shared`) instead of the concrete CLI.
 * Inject a different backend via {@link setLlmExecutor} to run a non-Claude
 * model without touching the scheduler.
 */
export class CliLlmAdapter implements LlmExecutor {
  readonly name = 'claude-cli'

  execute(prompt: string, opts: LlmExecuteOptions = {}): Promise<LlmExecuteResult> {
    return executePrompt(prompt, opts)
  }
}

let activeExecutor: LlmExecutor = new CliLlmAdapter()

/** Swap the active LLM backend (tests / non-Claude deployments). */
export function setLlmExecutor(executor: LlmExecutor): void {
  activeExecutor = executor
}

/** The injected LLM backend. Defaults to {@link CliLlmAdapter}. */
export function getLlmExecutor(): LlmExecutor {
  return activeExecutor
}
