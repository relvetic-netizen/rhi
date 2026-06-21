/**
 * LLM execution seam — the abstraction the daemon spawns prompts through.
 *
 * The daemon historically called the Claude CLI directly (`claude --print`).
 * This interface lets any backend (a different CLI, an HTTP API, a local
 * model) be injected without touching the daemon's scheduling core. The
 * bundled `CliLlmAdapter` (packages/daemon) implements it over the Claude CLI.
 */

/** Options for a single prompt execution. Backends may ignore fields they
 *  cannot honour (e.g. an HTTP backend has no `cwd`). */
export interface LlmExecuteOptions {
  /** Model identifier, backend-specific (e.g. 'opus', 'sonnet'). */
  model?: string
  /** Upper bound on agentic turns, if the backend is turn-based. */
  maxTurns?: number
  /** Hard timeout in milliseconds. */
  timeoutMs?: number
  /** Working directory for process-based backends. */
  cwd?: string
  /** Restrict the backend to these tool names, if supported. */
  allowedTools?: string[]
}

/** Result of a single prompt execution. */
export interface LlmExecuteResult {
  /** Captured stdout / completion text. */
  stdout: string
  /** Process exit code (0 = success). HTTP-style backends map success to 0. */
  exitCode: number
}

/** A pluggable backend that runs a single prompt to completion. */
export interface LlmExecutor {
  /** Stable identifier for logs/diagnostics (e.g. 'claude-cli'). */
  readonly name: string
  /** Run `prompt` to completion and resolve with its output. */
  execute(prompt: string, opts?: LlmExecuteOptions): Promise<LlmExecuteResult>
}
