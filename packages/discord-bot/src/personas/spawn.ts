import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { EventEmitter } from "events";
import { ClaudeSubprocess } from "../claude/subprocess.js";
import { ProtocolRouter } from "../claude/protocol.js";
import { config } from "../config.js";
import type { SDKOutboundMessage } from "../types.js";
import type { GuildKey, PersonaConfig, PersonaName } from "./types.js";
import { makeSessionKey, safeFsKey } from "./types.js";

const STOP_TOMBSTONE_TTL_MS = 5 * 60 * 1000;

export interface PersonaSpawnState {
  sessionId: string;
  lastActivity: number;
}

export interface PersonaSessionHandle {
  persona: PersonaName;
  guildKey: GuildKey;
  subprocess: ClaudeSubprocess;
  emitter: EventEmitter;
  router: ProtocolRouter;
  /** sessionId once captured from the first system/init message */
  sessionId: string;
  lastActivity: number;
  /** Per-conversation turn counter. Resets when session is killed/evicted/cleared. */
  turnCount: number;
}

const liveSessions = new Map<string, PersonaSessionHandle>();

/** Ensure a live ClaudeSubprocess exists for this (persona, guild), loading resume state from disk. */
export async function ensureSession(
  persona: PersonaConfig,
  guildKey: GuildKey,
  options: { model?: string } = {}
): Promise<PersonaSessionHandle> {
  const key = makeSessionKey(persona.name, guildKey);
  const existing = liveSessions.get(key);
  if (existing && existing.subprocess.alive) {
    existing.lastActivity = Date.now();
    return existing;
  }

  const systemPrompt = await readDiscordWake(persona);
  const subprocess = new ClaudeSubprocess();
  await subprocess.start({
    workingDir: persona.vesselDir,
    systemPrompt,
    additionalDirs: persona.additionalDirs,
    env: persona.env,
    model: options.model ?? config.claudeModel,
  });

  // Restore prior session id so Claude --resume picks up continuity
  const persisted = await readSpawnState(persona, guildKey);
  if (persisted?.sessionId) {
    subprocess.setSessionId(persisted.sessionId);
  }

  const emitter = new EventEmitter();
  const router = new ProtocolRouter();
  const handle: PersonaSessionHandle = {
    persona: persona.name,
    guildKey,
    subprocess,
    emitter,
    router,
    sessionId: persisted?.sessionId ?? "",
    lastActivity: Date.now(),
    turnCount: 0,
  };

  subprocess.on("message", (msg: SDKOutboundMessage) => {
    if (
      msg.type === "system" &&
      "subtype" in msg &&
      (msg as { subtype?: string }).subtype === "init"
    ) {
      const sid = (msg as { session_id?: string }).session_id;
      if (sid && sid !== handle.sessionId) {
        handle.sessionId = sid;
        void writeSpawnState(persona, guildKey, {
          sessionId: sid,
          lastActivity: Date.now(),
        });
      }
    }
    router.route(msg);
    emitter.emit("message", msg);
  });
  subprocess.on("exit", (code, signal) => emitter.emit("exit", code, signal));
  subprocess.on("error", (err) => emitter.emit("error", err));

  liveSessions.set(key, handle);
  return handle;
}

/** Send a user message to the persona session, spawning if needed. */
export async function sendUserMessage(
  persona: PersonaConfig,
  guildKey: GuildKey,
  content: string,
  options: { model?: string } = {}
): Promise<PersonaSessionHandle> {
  const handle = await ensureSession(persona, guildKey, options);
  handle.lastActivity = Date.now();
  handle.turnCount += 1;
  await handle.subprocess.sendUserMessage(content);
  return handle;
}

/** Kill the live subprocess but keep the sessionId on disk for resume. Resets turnCount. */
export function killSession(persona: PersonaName, guildKey: GuildKey): boolean {
  const key = makeSessionKey(persona, guildKey);
  const handle = liveSessions.get(key);
  if (!handle) return false;
  handle.subprocess.kill();
  liveSessions.delete(key);
  return true;
}

export function getSession(
  persona: PersonaName,
  guildKey: GuildKey
): PersonaSessionHandle | undefined {
  return liveSessions.get(makeSessionKey(persona, guildKey));
}

export function getLiveSessionCount(): number {
  return liveSessions.size;
}

export function destroyAllSessions(): void {
  for (const handle of liveSessions.values()) {
    handle.subprocess.kill();
  }
  liveSessions.clear();
}

/** Get current per-conversation turn count (0 if no live session). */
export function getTurnCount(persona: PersonaName, guildKey: GuildKey): number {
  return liveSessions.get(makeSessionKey(persona, guildKey))?.turnCount ?? 0;
}

// ---- Stop tombstone (disk-persisted so a peer bot reply post-restart respects stop) ----

function tombstonePath(persona: PersonaConfig, guildKey: GuildKey): string {
  return path.join(persona.sessionStateDir, `${safeFsKey(guildKey)}.stopped`);
}

/** Mark a (persona, guild) as stopped. Disk-persisted; expires after STOP_TOMBSTONE_TTL_MS. */
export async function writeStopTombstone(
  persona: PersonaConfig,
  guildKey: GuildKey
): Promise<void> {
  const file = tombstonePath(persona, guildKey);
  const dir = path.dirname(file);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify({ stoppedAt: new Date().toISOString() }) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

/** Returns true if a non-expired stop tombstone exists for this (persona, guild). */
export async function isStopTombstoned(
  persona: PersonaConfig,
  guildKey: GuildKey,
  now: number = Date.now()
): Promise<boolean> {
  const file = tombstonePath(persona, guildKey);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as { stoppedAt?: string };
    const ts = parsed.stoppedAt ? Date.parse(parsed.stoppedAt) : NaN;
    if (!Number.isFinite(ts)) return false;
    if (now - ts > STOP_TOMBSTONE_TTL_MS) {
      // Stale — clear it
      await fs.unlink(file).catch(() => undefined);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearStopTombstone(
  persona: PersonaConfig,
  guildKey: GuildKey
): Promise<void> {
  const file = tombstonePath(persona, guildKey);
  await fs.unlink(file).catch(() => undefined);
}

// ---- Spawn state (sessionId persistence for --resume) ----

function stateFilePath(persona: PersonaConfig, guildKey: GuildKey): string {
  return path.join(persona.sessionStateDir, `${safeFsKey(guildKey)}.json`);
}

async function readDiscordWake(persona: PersonaConfig): Promise<string> {
  try {
    return await fs.readFile(persona.discordWakePath, "utf-8");
  } catch (err) {
    console.error(
      `[persona-spawn] CRITICAL: discord-wake.md missing for persona=${persona.name} at ${persona.discordWakePath}. ` +
        `Persona will spawn with EMPTY system prompt (degraded). ` +
        `err=${err instanceof Error ? err.message : err}`
    );
    return "";
  }
}

async function readSpawnState(
  persona: PersonaConfig,
  guildKey: GuildKey
): Promise<PersonaSpawnState | null> {
  const file = stateFilePath(persona, guildKey);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw) as PersonaSpawnState;
    if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeSpawnState(
  persona: PersonaConfig,
  guildKey: GuildKey,
  state: PersonaSpawnState
): Promise<void> {
  const file = stateFilePath(persona, guildKey);
  const dir = path.dirname(file);
  if (!fsSync.existsSync(dir)) {
    await fs.mkdir(dir, { recursive: true });
  }
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

export const __testing = {
  liveSessions,
  stateFilePath,
  readSpawnState,
  writeSpawnState,
  tombstonePath,
  STOP_TOMBSTONE_TTL_MS,
};
