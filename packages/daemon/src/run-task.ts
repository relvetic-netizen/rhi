#!/usr/bin/env node
// run-task — standalone script to execute a Relvetia prompt file via claude -p.
//
// Called by shell hooks (e.g., relvetia-session-distill.sh) to run a prompt
// from the prompts/ directory through the executor. Reuses the same CLI
// resolution logic (fnm path, Windows .cmd handling) as the daemon.
//
// Usage:
//   node dist-runners/run-task.js <prompt-file> [options]
//   node dist-runners/run-task.js distill-session.md
//   node dist-runners/run-task.js distill-session.md --model sonnet --max-turns 10
//
// Options:
//   --model <model>             Model to use (default: opus)
//   --max-turns <n>             Max conversation turns (default: 15)
//   --timeout <ms>              Timeout in milliseconds (default: 900000)
//   --cwd <dir>                 Working directory for claude process
//   --no-screening              Disable screening-based memory filtering
//   --write-timestamp <path>    On successful completion (exit 0), write the
//                               current ISO timestamp to <path>. Used by the
//                               session-distill hook to stamp .last-session-distill
//                               from Node rather than relying on the LLM prompt.
//
// Output: stdout from claude process. Exit code mirrors claude's exit code.

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, resolve, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import { executePrompt } from './executor.js'
import { atomicWrite } from '../../extracted/util/atomicWrite.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Prompts directory resolution (multiple layouts):
//   Development: relvetia-daemon/src/run-task.ts  → ../prompts/
//   Bundled:     relvetia-daemon/dist-runners/    → ../prompts/
//   Deployed:    ~/.claude/relvetia/dist/         → ../dist/relvetia-daemon/prompts/
//   RELVETIA_DIR:  $RELVETIA_DIR/dist/relvetia-daemon/prompts/ (env override)
function resolvePromptsDir(): string {
  // 1. RELVETIA_DIR env (set by hooks, most reliable for deployed layout)
  const relvetiaDir = process.env.RELVETIA_DIR
  if (relvetiaDir) {
    const envPath = join(relvetiaDir, 'dist', 'relvetia-daemon', 'prompts')
    if (existsSync(envPath)) return envPath
  }
  // 2. Relative to __dirname (works for dev and bundled layouts)
  const relativePath = resolve(__dirname, '..', 'prompts')
  if (existsSync(relativePath)) return relativePath
  // 3. Deployed layout: __dirname/relvetia-daemon/prompts/
  const deployedPath = join(__dirname, 'relvetia-daemon', 'prompts')
  if (existsSync(deployedPath)) return deployedPath
  // Fallback
  return relativePath
}
const PROMPTS_DIR = resolvePromptsDir()

function usage(): never {
  console.error('Usage: run-task <prompt-file> [--model <m>] [--max-turns <n>] [--timeout <ms>] [--cwd <dir>] [--no-screening] [--write-timestamp <path>]')
  process.exit(1)
}

function parseArgs(args: string[]): {
  promptFile: string
  model?: string
  maxTurns?: number
  timeoutMs?: number
  cwd?: string
  enableScreening: boolean
  writeTimestamp?: string
} {
  if (args.length === 0) usage()

  const promptFile = args[0]
  let model: string | undefined
  let maxTurns: number | undefined
  let timeoutMs: number | undefined
  let cwd: string | undefined
  let enableScreening = true
  let writeTimestamp: string | undefined

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--model':
        model = args[++i]
        break
      case '--max-turns':
        maxTurns = parseInt(args[++i], 10)
        break
      case '--timeout':
        timeoutMs = parseInt(args[++i], 10)
        break
      case '--cwd':
        cwd = args[++i]
        break
      case '--no-screening':
        enableScreening = false
        break
      case '--write-timestamp':
        writeTimestamp = args[++i]
        break
      default:
        console.error(`Unknown option: ${args[i]}`)
        usage()
    }
  }

  return { promptFile, model, maxTurns, timeoutMs, cwd, enableScreening, writeTimestamp }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opts = parseArgs(args)

  // Resolve prompt file path
  let promptPath: string
  if (isAbsolute(opts.promptFile)) {
    promptPath = opts.promptFile
  } else if (existsSync(opts.promptFile)) {
    promptPath = resolve(opts.promptFile)
  } else {
    promptPath = join(PROMPTS_DIR, opts.promptFile)
  }

  if (!existsSync(promptPath)) {
    console.error(`[run-task] Prompt file not found: ${promptPath}`)
    console.error(`[run-task] Searched: ${opts.promptFile}, ${join(PROMPTS_DIR, opts.promptFile)}`)
    process.exit(1)
  }

  const prompt = await readFile(promptPath, 'utf-8')
  console.error(`[run-task] Executing: ${promptPath} (${prompt.length} chars)`)

  const { stdout, exitCode } = await executePrompt(prompt, {
    model: opts.model,
    maxTurns: opts.maxTurns,
    timeoutMs: opts.timeoutMs,
    cwd: opts.cwd,
    enableScreening: opts.enableScreening,
  })

  // Output to stdout (stderr used for logging above)
  if (stdout) {
    process.stdout.write(stdout)
  }

  // Stamp the timestamp file on success so the next run can scope its work
  // to entries newer than this timestamp. Done here (not in the prompt) so
  // the stamp is guaranteed regardless of whether the LLM remembers to write
  // it. On failure we deliberately skip the stamp so the next run re-scans
  // the same window.
  if (exitCode === 0 && opts.writeTimestamp) {
    try {
      await atomicWrite(opts.writeTimestamp, new Date().toISOString() + '\n')
    } catch (err) {
      console.error(`[run-task] Failed to write timestamp to ${opts.writeTimestamp}:`, err)
    }
  }

  process.exit(exitCode)
}

main().catch(err => {
  console.error('[run-task] Fatal error:', err)
  process.exit(1)
})
