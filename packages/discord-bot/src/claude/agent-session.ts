import { EventEmitter } from "events";
import type { ClaudeSubprocessOptions } from "./subprocess.js";
import { config } from "../config.js";

// Agent SDK is ESM-only, so we use dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK query() signature is complex and ESM-only
let _queryFn: ((opts: any) => any) | null = null;
async function getQuery() {
  if (!_queryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    _queryFn = sdk.query;
  }
  return _queryFn;
}

/**
 * Drop-in replacement for ClaudeSubprocess that uses the Agent SDK's query()
 * instead of spawning `claude -p` processes.
 *
 * Emits the same "message" and "exit" events so ProtocolRouter and
 * handlers.ts work without changes.
 */
export class AgentSession extends EventEmitter {
  private _sessionId = "";
  private _alive = false;
  private _systemPrompt = "";
  private _abortController: AbortController | null = null;
  /** The active Query async generator (has .close() for graceful shutdown) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK Query type is ESM-only
  private _currentQuery: (AsyncGenerator<any, void> & { close?: () => void }) | null = null;
  private mcpServers: Record<string, Record<string, unknown>>;

  constructor(mcpServers: Record<string, Record<string, unknown>>) {
    super();
    this.mcpServers = mcpServers;
  }

  get alive(): boolean {
    return this._alive;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async start(options: ClaudeSubprocessOptions = {}): Promise<void> {
    this._alive = true;
    this._sessionId = "";
    this._systemPrompt = options.systemPrompt || "";
  }

  /**
   * Send a message via Agent SDK query(). Iterates the async generator
   * and emits each message as a "message" event (same interface as
   * ClaudeSubprocess).
   */
  async sendUserMessage(content: string): Promise<void> {
    if (!this._alive) {
      throw new Error("AgentSession is not running");
    }

    this._abortController = new AbortController();

    const options: Record<string, unknown> = {
      abortController: this._abortController,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      mcpServers: this.mcpServers,
      allowedTools: ["mcp__discord-bot__*"],
      cwd: config.defaultWorkingDir,
      model: config.claudeModel,
      // Include streaming events so ProtocolRouter receives text_delta
      includePartialMessages: true,
    };

    // Resume previous session for context continuity
    if (this._sessionId) {
      options.resume = this._sessionId;
    }

    // Append system prompt on first message only
    if (!this._sessionId && this._systemPrompt) {
      options.extraArgs = {
        "append-system-prompt": this._systemPrompt,
      };
    }

    try {
      const queryFn = await getQuery();
      const q = queryFn({ prompt: content, options });
      this._currentQuery = q;

      for await (const message of q) {
        // Capture session_id from init message
        if (
          message.type === "system" &&
          "subtype" in message &&
          message.subtype === "init"
        ) {
          this._sessionId = message.session_id || "";
          console.log(`[agent-session] Session: ${this._sessionId}`);
        }

        // Emit same "message" event as ClaudeSubprocess
        this.emit("message", message);
      }

      // Iterator done = query complete
      this._currentQuery = null;
      this.emit("exit", 0, null);
    } catch (err: unknown) {
      this._currentQuery = null;
      if (err instanceof Error && err.name === "AbortError") {
        this.emit("exit", null, "SIGTERM");
      } else {
        this.emit("error", err);
        this.emit("exit", 1, null);
      }
    }
  }

  async sendControlResponse(
    _requestId: string,
    _response: Record<string, unknown>
  ): Promise<void> {
    // No-op: permissions are bypassed via bypassPermissions mode
  }

  kill(): void {
    this._alive = false;
    // Prefer Query.close() for graceful shutdown, fall back to AbortController
    if (this._currentQuery?.close) {
      this._currentQuery.close();
      this._currentQuery = null;
    } else if (this._abortController) {
      this._abortController.abort();
    }
    this._abortController = null;
  }
}
