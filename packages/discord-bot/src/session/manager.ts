import { config, getChannelSystemPrompt } from "../config.js";
import { Session } from "./session.js";
import type { ClaudeSubprocessOptions } from "../claude/subprocess.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private idleCheckInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.idleCheckInterval = setInterval(() => {
      this.cleanupIdleSessions();
    }, 60_000);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  has(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  get(channelId: string): Session | undefined {
    return this.sessions.get(channelId);
  }

  async create(
    channelId: string,
    userId: string,
    options: ClaudeSubprocessOptions = {}
  ): Promise<Session> {
    const existing = this.sessions.get(channelId);
    if (existing) {
      existing.destroy();
      this.sessions.delete(channelId);
    }

    if (this.sessions.size >= config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions (${config.maxConcurrentSessions}) reached. Try /clear in another channel.`
      );
    }

    const session = new Session(channelId, userId);

    // Inject channel system prompt
    const systemPrompt = getChannelSystemPrompt(channelId);
    await session.start({ ...options, systemPrompt });
    this.sessions.set(channelId, session);
    return session;
  }

  async getOrCreate(
    channelId: string,
    userId: string,
    options: ClaudeSubprocessOptions = {}
  ): Promise<Session> {
    const existing = this.sessions.get(channelId);
    if (existing?.subprocess.alive) {
      existing.touch();
      return existing;
    }
    return this.create(channelId, userId, options);
  }

  destroySession(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (session) {
      session.destroy();
      this.sessions.delete(channelId);
      return true;
    }
    return false;
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();
    for (const [channelId, session] of this.sessions) {
      if (now - session.lastActivity > config.sessionIdleTimeoutMs) {
        console.log(`[session] Idle timeout for channel ${channelId}`);
        session.destroy();
        this.sessions.delete(channelId);
      }
    }
  }

  destroyAll(): void {
    for (const [channelId, session] of this.sessions) {
      session.destroy();
    }
    this.sessions.clear();
    clearInterval(this.idleCheckInterval);
  }
}
