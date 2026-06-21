import { ClaudeSubprocess, type ClaudeSubprocessOptions } from "../claude/subprocess.js";
import { AgentSession } from "../claude/agent-session.js";
import { ProtocolRouter } from "../claude/protocol.js";
import type { SDKOutboundMessage } from "../types.js";
import { config } from "../config.js";
import { getMcpServerConfig } from "../mcp/agent-mcp-config.js";

/** Common interface for both ClaudeSubprocess and AgentSession */
type SessionBackend = ClaudeSubprocess | AgentSession;

export class Session {
  readonly channelId: string;
  readonly userId: string;
  readonly subprocess: SessionBackend;
  readonly router: ProtocolRouter;
  lastActivity: number;

  constructor(channelId: string, userId: string) {
    this.channelId = channelId;
    this.userId = userId;

    if (config.useAgentSdk) {
      this.subprocess = new AgentSession(getMcpServerConfig());
    } else {
      this.subprocess = new ClaudeSubprocess();
    }

    this.router = new ProtocolRouter();
    this.lastActivity = Date.now();

    this.subprocess.on("message", (msg: SDKOutboundMessage) => {
      this.router.route(msg);
    });
  }

  async start(options: ClaudeSubprocessOptions = {}): Promise<void> {
    await this.subprocess.start(options);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  async sendMessage(content: string): Promise<void> {
    this.touch();
    await this.subprocess.sendUserMessage(content);
  }

  async respondToPermission(
    requestId: string,
    response: Record<string, unknown>
  ): Promise<void> {
    await this.subprocess.sendControlResponse(requestId, response);
  }

  destroy(): void {
    this.subprocess.kill();
  }
}
