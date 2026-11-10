import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

export type ChannelMode = "auto" | "mention" | "none" | "persona";

export interface ChannelConfig {
  name: string;
  mode: ChannelMode;
  /** Persona name when mode = "persona". Falls back to config.botPersona if absent. */
  persona?: string;
  systemPrompt?: string;
  /** Optional per-channel model override for persona-mode sessions. */
  personaModel?: string;
}

function loadChannelConfigs(): Record<string, ChannelConfig> {
  const configPath = path.resolve(__dirname, "..", "config", "channels.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return (
      (JSON.parse(raw) as { channels: Record<string, ChannelConfig> })
        .channels || {}
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      console.error("[config] channels.json not found, using defaults");
    } else {
      console.error(
        "[config] Failed to parse channels.json:",
        err instanceof Error ? err.message : err,
      );
    }
    return {};
  }
}

function loadJsonConfig<T>(configPath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return fallback;
  }
}

function parseIntEnv(name: string, defaultVal: string): number {
  const val = parseInt(process.env[name] || defaultVal, 10);
  if (Number.isNaN(val))
    throw new Error(`Invalid integer for ${name}: ${process.env[name]}`);
  return val;
}

/** Notion DB list: env `NOTION_IDS_PATH` wins (relative to process.cwd()), else
 *  the package-local `config/notion-ids.json`. Missing or invalid file → {}. */
export const notionDatabaseIds: Record<string, string> = loadJsonConfig(
  process.env.NOTION_IDS_PATH ||
    path.resolve(__dirname, "..", "config", "notion-ids.json"),
  {},
);

export const channelConfigs = loadChannelConfigs();

export const config = {
  discordBotToken: requireEnv("DISCORD_BOT_TOKEN"),
  claudeCliPath: process.env.CLAUDE_CLI_PATH || "claude",
  claudeCliScript: process.env.CLAUDE_CLI_SCRIPT || "",
  sessionIdleTimeoutMs: parseIntEnv("SESSION_IDLE_TIMEOUT_MS", "1800000"),
  maxConcurrentSessions: parseIntEnv("MAX_CONCURRENT_SESSIONS", "5"),
  permissionMode: (process.env.PERMISSION_MODE || "auto") as
    | "auto"
    | "prompt"
    | "deny",
  allowedWorkingDirs: (process.env.ALLOWED_WORKING_DIRS || ".")
    .split(":")
    .filter(Boolean),
  mcpAllowedGuildIds: process.env.MCP_ALLOWED_GUILD_IDS
    ? process.env.MCP_ALLOWED_GUILD_IDS.split(",").map((s) => s.trim())
    : null,
  allowedUserIds: process.env.ALLOWED_USER_IDS
    ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim())
    : null, // null = all users allowed
  defaultWorkingDir: process.env.DEFAULT_WORKING_DIR || process.cwd(),
  dnsServers: process.env.DNS_SERVERS || "8.8.8.8,8.8.4.4",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  claudeSubprocessTimeoutMs: parseIntEnv(
    "CLAUDE_SUBPROCESS_TIMEOUT_MS",
    "1800000",
  ),
  useAgentSdk: (process.env.USE_AGENT_SDK || "false").toLowerCase() === "true",
  /** When false, this instance does not route any messages through the persona Discord pipeline. */
  personaDiscord: (process.env.PERSONA_DISCORD ?? "1") !== "0",
  /** Persona this bot instance acts as. Empty = no persona pipeline (generic-Claude only). */
  botPersona: process.env.BOT_PERSONA || "",
  /** Other AI bot user IDs treated as "peer bots" (allowed past `bot` filter). Comma-separated. */
  peerBotIds: process.env.PEER_BOT_IDS
    ? process.env.PEER_BOT_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [],
  /** Cost-fuse: persona session is killed once turnCount reaches this. */
  maxAiTurnsPerConversation: parseIntEnv("MAX_AI_TURNS_PER_CONVERSATION", "40"),
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "",
} as const;

/** Get channel mode: auto (respond to all), mention (@mention only), none (ignore),
 *  persona (route through persona Discord pipeline). */
export function getChannelMode(channelId: string): ChannelMode {
  const cc = channelConfigs[channelId];
  if (cc) return cc.mode;
  return "mention";
}

/** Get persona name routed for a channel.
 *  - mode "persona": uses cc.persona, else config.botPersona (undefined if neither set).
 *  - other modes: undefined. */
export function getChannelPersona(channelId: string): string | undefined {
  const cc = channelConfigs[channelId];
  if (!cc) return undefined;
  if (cc.mode === "persona")
    return cc.persona ?? (config.botPersona || undefined);
  return undefined;
}

/** Get per-channel persona model override (undefined falls back to config.claudeModel). */
export function getChannelPersonaModel(channelId: string): string | undefined {
  return channelConfigs[channelId]?.personaModel;
}

/** Get system prompt for a channel (if configured). */
export function getChannelSystemPrompt(channelId: string): string | undefined {
  return channelConfigs[channelId]?.systemPrompt;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
