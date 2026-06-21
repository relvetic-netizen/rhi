import { getLiveSessionCount, killSession } from "./spawn.js";
import type { GuildKey, PersonaName } from "./types.js";
import { makeSessionKey, PersonaError, TooManySessionsError } from "./types.js";

const CONCURRENCY_CAP = 8;
const QUEUE_DEPTH_LIMIT = 5;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const chains = new Map<string, Promise<void>>();
const pendingCounters = new Map<string, number>();
const lastActivity = new Map<string, number>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export class QueueFullError extends PersonaError {
  constructor(persona: PersonaName, guildKey: GuildKey) {
    super(`Queue full for ${persona}:${guildKey} (depth ≥ ${QUEUE_DEPTH_LIMIT})`);
    this.name = "QueueFullError";
  }
}

/** Run `fn` inside a per-(persona,guild) serialized queue. Throws if concurrency cap or queue depth exceeded. */
export async function withGuildLock<T>(
  persona: PersonaName,
  guildKey: GuildKey,
  fn: () => Promise<T>
): Promise<T> {
  const key = makeSessionKey(persona, guildKey);
  if (!chains.has(key) && getLiveSessionCount() >= CONCURRENCY_CAP) {
    throw new TooManySessionsError(getLiveSessionCount(), CONCURRENCY_CAP);
  }
  const depth = pendingCounters.get(key) ?? 0;
  if (depth >= QUEUE_DEPTH_LIMIT) {
    throw new QueueFullError(persona, guildKey);
  }
  pendingCounters.set(key, depth + 1);

  const prev = chains.get(key) ?? Promise.resolve();
  const task = (async () => {
    try {
      await prev;
      lastActivity.set(key, Date.now());
      return await fn();
    } finally {
      const c = pendingCounters.get(key) ?? 1;
      const next = Math.max(0, c - 1);
      pendingCounters.set(key, next);
      if (next === 0) {
        pendingCounters.delete(key);
        chains.delete(key);
      }
    }
  })();
  chains.set(
    key,
    task.then(
      () => undefined,
      () => undefined
    )
  );
  return task;
}

export function getQueueDepth(persona: PersonaName, guildKey: GuildKey): number {
  return pendingCounters.get(makeSessionKey(persona, guildKey)) ?? 0;
}

export function getLiveGuildCount(): number {
  return getLiveSessionCount();
}

export function touch(persona: PersonaName, guildKey: GuildKey): void {
  lastActivity.set(makeSessionKey(persona, guildKey), Date.now());
}

export function evictIdle(now: number = Date.now()): string[] {
  const evicted: string[] = [];
  for (const [key, ts] of lastActivity.entries()) {
    if (now - ts > IDLE_TIMEOUT_MS) {
      const [persona, ...guildParts] = key.split(":");
      const guildKey = guildParts.join(":");
      killSession(persona, guildKey);
      lastActivity.delete(key);
      evicted.push(key);
    }
  }
  return evicted;
}

export function startCleanupJob(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    try {
      const evicted = evictIdle();
      for (const key of evicted) {
        console.log(`[persona-session] idle eviction ${key}`);
      }
    } catch (err) {
      console.error(`[persona-session] cleanup error:`, err);
    }
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopCleanupJob(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function clearGuildSession(persona: PersonaName, guildKey: GuildKey): boolean {
  const key = makeSessionKey(persona, guildKey);
  const killed = killSession(persona, guildKey);
  lastActivity.delete(key);
  pendingCounters.delete(key);
  chains.delete(key);
  return killed;
}

export const __testing = {
  CONCURRENCY_CAP,
  QUEUE_DEPTH_LIMIT,
  IDLE_TIMEOUT_MS,
  chains,
  pendingCounters,
  lastActivity,
};
