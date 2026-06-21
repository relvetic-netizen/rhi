import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const liveKeys = new Set<string>();
let mockLiveCount = 0;
const killHistory: string[] = [];

vi.mock("../spawn.js", () => ({
  getLiveSessionCount: () => mockLiveCount,
  getSession: (persona: string, guildKey: string) => {
    const key = `${persona}:${guildKey}`;
    return liveKeys.has(key) ? { persona, guildKey } : undefined;
  },
  killSession: (persona: string, guildKey: string) => {
    const key = `${persona}:${guildKey}`;
    killHistory.push(key);
    if (liveKeys.has(key)) {
      liveKeys.delete(key);
      mockLiveCount--;
      return true;
    }
    return false;
  },
}));

import {
  withGuildLock,
  getQueueDepth,
  evictIdle,
  clearGuildSession,
  stopCleanupJob,
  touch,
  QueueFullError,
  __testing,
} from "../session-manager.js";
import { TooManySessionsError } from "../types.js";

const PERSONA = "aria";
const KEY = (g: string) => `${PERSONA}:${g}`;

describe("personas/session-manager", () => {
  beforeEach(() => {
    __testing.chains.clear();
    __testing.pendingCounters.clear();
    __testing.lastActivity.clear();
    liveKeys.clear();
    mockLiveCount = 0;
    killHistory.length = 0;
    stopCleanupJob();
  });

  afterEach(() => {
    stopCleanupJob();
  });

  it("serializes two calls on same (persona,guild) (second runs after first completes)", async () => {
    const order: number[] = [];
    const run = async (id: number, delay: number) =>
      withGuildLock(PERSONA, "G_A", async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delay));
        order.push(id * 10);
      });
    await Promise.all([run(1, 30), run(2, 10)]);
    expect(order).toEqual([1, 10, 2, 20]);
  });

  it("runs different guilds in parallel", async () => {
    const startTimes: number[] = [];
    const run = async (guild: string) =>
      withGuildLock(PERSONA, guild, async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 40));
      });
    await Promise.all([run("G1"), run("G2")]);
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(20);
  });

  it("runs same guild on different personas in parallel", async () => {
    const startTimes: number[] = [];
    const run = async (persona: string) =>
      withGuildLock(persona, "G_SHARED", async () => {
        startTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 40));
      });
    await Promise.all([run("aria"), run("nova")]);
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(20);
  });

  it("throws TooManySessionsError when live count >= cap and new (persona,guild)", async () => {
    mockLiveCount = 8;
    await expect(
      withGuildLock(PERSONA, "G_NEW", async () => 1),
    ).rejects.toBeInstanceOf(TooManySessionsError);
  });

  it("throws QueueFullError when pending depth >= 5", async () => {
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const long = () => withGuildLock(PERSONA, "G_FULL", () => gate);
    const first5 = Array.from({ length: 5 }, () => long().catch((e) => e));
    await expect(long()).rejects.toBeInstanceOf(QueueFullError);
    await Promise.all(first5);
  });

  it("getQueueDepth reflects live pending count", async () => {
    const hold = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const p1 = withGuildLock(PERSONA, "G_Q", () => hold);
    const p2 = withGuildLock(PERSONA, "G_Q", async () => undefined);
    await Promise.resolve();
    expect(getQueueDepth(PERSONA, "G_Q")).toBeGreaterThanOrEqual(1);
    await Promise.all([p1, p2]);
    expect(getQueueDepth(PERSONA, "G_Q")).toBe(0);
  });

  it("evictIdle kills sessions past IDLE_TIMEOUT_MS", () => {
    liveKeys.add(KEY("G_IDLE"));
    mockLiveCount = 1;
    __testing.lastActivity.set(KEY("G_IDLE"), Date.now() - 31 * 60 * 1000);
    const evicted = evictIdle();
    expect(evicted).toEqual([KEY("G_IDLE")]);
    expect(killHistory).toContain(KEY("G_IDLE"));
  });

  it("evictIdle keeps active sessions", () => {
    __testing.lastActivity.set(KEY("G_ACTIVE"), Date.now() - 1 * 60 * 1000);
    const evicted = evictIdle();
    expect(evicted).toEqual([]);
    expect(killHistory).toEqual([]);
  });

  it("touch updates lastActivity per (persona,guild)", () => {
    touch(PERSONA, "G_T");
    const ts = __testing.lastActivity.get(KEY("G_T"));
    expect(ts).toBeDefined();
    expect(Date.now() - (ts ?? 0)).toBeLessThan(50);
  });

  it("clearGuildSession removes lock state + kills only the named persona", () => {
    liveKeys.add(KEY("G_CLEAR"));
    liveKeys.add(`nova:G_CLEAR`); // another persona still active
    mockLiveCount = 2;
    __testing.lastActivity.set(KEY("G_CLEAR"), Date.now());
    __testing.lastActivity.set(`nova:G_CLEAR`, Date.now());
    const killed = clearGuildSession(PERSONA, "G_CLEAR");
    expect(killed).toBe(true);
    expect(__testing.lastActivity.has(KEY("G_CLEAR"))).toBe(false);
    expect(__testing.lastActivity.has(`nova:G_CLEAR`)).toBe(true);
    expect(liveKeys.has(`nova:G_CLEAR`)).toBe(true);
  });

  it("errors inside fn propagate but don't leak chain", async () => {
    await expect(
      withGuildLock(PERSONA, "G_ERR", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(__testing.pendingCounters.get(KEY("G_ERR")) ?? 0).toBe(0);
    const result = await withGuildLock(PERSONA, "G_ERR", async () => "ok");
    expect(result).toBe("ok");
  });
});
