import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { config } from "../config.js";
import { NDJSONParser } from "./ndjson.js";
import { resolveClaudeInvocation } from "./resolve-cli.js";
import type { SDKOutboundMessage } from "../types.js";

export interface ClaudeSubprocessOptions {
  workingDir?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  /** Extra directories to expose to Claude via --add-dir (repeated flag). */
  additionalDirs?: string[];
  /** Extra env merged on top of process.env (e.g. RELVETIA_INCLUDE_<PERSONA>=1). */
  env?: Record<string, string>;
  /** Override config.claudeModel for this subprocess. */
  model?: string;
}

/**
 * Runs `claude -p` per message with `--resume` for context continuity.
 * Each call spawns a new process but resumes the same session.
 */
export class ClaudeSubprocess extends EventEmitter {
  private _sessionId: string = "";
  private _alive = false;
  private currentProcess: ChildProcess | null = null;
  private _systemPrompt: string = "";
  private _additionalDirs: string[] = [];
  private _extraEnv: Record<string, string> = {};
  private _model: string | undefined;
  private _workingDir: string | undefined;

  get alive(): boolean {
    return this._alive;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async start(options: ClaudeSubprocessOptions = {}): Promise<void> {
    this._alive = true;
    this._sessionId = ""; // Will be set on first message
    this._systemPrompt = options.systemPrompt || "";
    this._additionalDirs = options.additionalDirs || [];
    this._extraEnv = options.env || {};
    this._model = options.model;
    this._workingDir = options.workingDir;
  }

  /** Pre-seed a session id (used by resumption flows like persona spawn). */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /**
   * Send a message to Claude. Spawns `claude -p` process per message.
   * Uses --resume with session_id for context continuity.
   */
  async sendUserMessage(content: string): Promise<void> {
    if (!this._alive) {
      throw new Error("ClaudeSubprocess is not running");
    }

    const { bin, prefixArgs, useShell } = resolveClaudeInvocation({
      cliPath: config.claudeCliPath,
      cliScript: config.claudeCliScript,
    });

    const cliArgs = [
      ...prefixArgs,
      "-p",
      content,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      this._model || config.claudeModel,
    ];

    for (const dir of this._additionalDirs) {
      cliArgs.push("--add-dir", dir);
    }

    // Resume previous session for context continuity
    if (this._sessionId) {
      cliArgs.push("--resume", this._sessionId);
    }

    // Append channel system prompt on first message only
    if (!this._sessionId && this._systemPrompt) {
      cliArgs.push("--append-system-prompt", this._systemPrompt);
    }

    const proc = spawn(bin, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this._workingDir || config.defaultWorkingDir,
      env: { ...process.env, CI: "1", TERM: "dumb", ...this._extraEnv },
      shell: useShell,
    });
    this.currentProcess = proc;

    // Close stdin immediately (not needed for -p mode)
    proc.stdin?.end();

    const parser = new NDJSONParser(proc.stdout!);

    parser.onMessage((msg: SDKOutboundMessage) => {
      // Capture session_id from init message
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        this._sessionId = (msg as any).session_id || "";
        console.log(`[subprocess] Session: ${this._sessionId}`);
      }
      this.emit("message", msg);
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.warn("[subprocess:stderr]", text.slice(0, 200));
      }
    });

    proc.on("exit", (code, signal) => {
      parser.close();
      this.currentProcess = null;
      this.emit("exit", code, signal);
      if (code !== 0) {
        console.error(`[subprocess] Exited with code=${code} signal=${signal}`);
      }
    });

    proc.on("error", (err) => {
      this.emit("error", err);
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, config.claudeSubprocessTimeoutMs);

    proc.on("exit", () => clearTimeout(timeout));
  }

  async sendControlResponse(
    _requestId: string,
    _response: Record<string, unknown>,
  ): Promise<void> {
    // No-op in -p mode (permissions are bypassed)
  }

  kill(): void {
    this._alive = false;
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
    }
  }
}
