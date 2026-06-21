import dotenv from "dotenv";
import fs from "fs";
import path from "path";

import {
  loadProtectedRowsConfig,
  formatProtectedSection,
  type ProtectedRowsConfig,
} from "./notion/protected-rows.js";

dotenv.config();

/** Discord channel ID for the accounting channel. When set, the protected_rows
 *  section is appended to that channel's system prompt. Optional — leave unset to disable. */
const ACCOUNTING_CHANNEL_ID = process.env.ACCOUNTING_CHANNEL_ID || "";

export type ChannelMode = "auto" | "mention" | "none" | "persona";

export interface ChannelConfig {
  name: string;
  mode: ChannelMode;
  /** Persona name when mode = "persona". Falls back to config.botPersona if absent. */
  persona?: string;
  systemPrompt?: string;
  notionPageId?: string;
  /** Optional per-channel model override for persona-mode sessions. */
  personaModel?: string;
}

function loadChannelConfigs(): Record<string, ChannelConfig> {
  const configPath = path.resolve(__dirname, "..", "config", "channels.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const channels =
      (JSON.parse(raw) as { channels: Record<string, ChannelConfig> })
        .channels || {};
    // Resolve {{notion.xxx}} placeholders in systemPrompts
    for (const cfg of Object.values(channels)) {
      if (cfg.systemPrompt) {
        cfg.systemPrompt = resolveNotionIds(cfg.systemPrompt);
      }
    }
    return channels;
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

function loadJsonConfig<T>(filename: string, fallback: T): T {
  const configPath = path.resolve(__dirname, "..", "config", filename);
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

function detectChromePath(): string {
  const platform = process.platform;
  if (platform === "win32")
    return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (platform === "darwin")
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return "google-chrome";
}

export const notionDatabaseIds: Record<string, string> = loadJsonConfig(
  "notion-ids.json",
  {},
);

/** Notion keys already warned about, so an unconfigured install logs each
 *  missing DB once instead of on every prompt build. */
const warnedMissingNotionIds = new Set<string>();

/** Replace {{notion.xxx}} placeholders with actual DB IDs from notion-ids.json.
 *  When a key is unconfigured the placeholder is left in place and a one-time
 *  warning is logged, so Notion-dependent features degrade gracefully (the bot
 *  still starts) instead of failing silently. See README "Notion setup". */
export function resolveNotionIds(template: string): string {
  return template.replace(/\{\{notion\.(\w+)\}\}/g, (match, key) => {
    const id = notionDatabaseIds[key];
    if (id) return id;
    if (!warnedMissingNotionIds.has(key)) {
      warnedMissingNotionIds.add(key);
      console.warn(
        `[config] Notion DB "${key}" is not configured (config/notion-ids.json); ` +
          `the related feature is unavailable. See README "Notion setup".`,
      );
    }
    return match;
  });
}

export const channelConfigs = loadChannelConfigs();

export const invoiceDefaults = loadJsonConfig("invoice-defaults.json", {
  issuer: null,
  bankInfo: null,
});

export const protectedRowsConfig: ProtectedRowsConfig = loadProtectedRowsConfig(
  path.resolve(__dirname, "..", "config", "protected-rows.json"),
);

const PROTECTED_SECTION = formatProtectedSection(protectedRowsConfig);

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
  geminiCliPath: process.env.GEMINI_CLI_PATH || "gemini",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.1-pro-preview",
  geminiTimeoutMs: parseIntEnv("GEMINI_TIMEOUT_MS", "120000"),
  defaultWorkingDir: process.env.DEFAULT_WORKING_DIR || process.cwd(),
  chromePath: process.env.CHROME_EXECUTABLE_PATH || detectChromePath(),
  invoiceOutputDir: process.env.INVOICE_OUTPUT_DIR || "",
  fumoarTemplatePath: process.env.FUMOAR_TEMPLATE_PATH || "",
  novelProjectPath: process.env.NOVEL_PROJECT_PATH || "",
  chromeNoSandbox:
    (process.env.CHROME_NO_SANDBOX || "false").toLowerCase() === "true",
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
  /** Feature flag — when false (default) the HTTP MCP transport is dormant and daemon retains
   *  pre-existing behavior exactly. Sprint 3 flips this to true alongside dogfood. */
  mcpHttpEnable:
    (process.env.MCP_HTTP_ENABLE || "false").toLowerCase() === "true",
  mcpHttpPort: parseIntEnv("MCP_HTTP_PORT", "7800"),
  /** Sprint 1 default = 127.0.0.1. Sprint 3 dogfood flips to 0.0.0.0 with explicit user re-confirm. */
  mcpBind: process.env.MCP_BIND || "127.0.0.1",
  /** Shared bearer token. Required only when mcpHttpEnable=true; absent value is tolerated when
   *  the flag is off so the daemon still starts (e.g. during CI or before .env is updated). */
  mcpApiKey: ((): string => {
    const enabled =
      (process.env.MCP_HTTP_ENABLE || "false").toLowerCase() === "true";
    if (enabled) return requireEnv("MCP_API_KEY");
    return process.env.MCP_API_KEY || "";
  })(),
  /** DNS-rebinding protection: Host header must match one of these. */
  mcpAllowedHosts: (process.env.MCP_ALLOWED_HOSTS || "localhost,127.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** HTTP-only tool denylist. stdio transport is unaffected. Defaults block the LAN-RCE-grade tools. */
  mcpHttpToolDenylist: (
    process.env.MCP_HTTP_TOOL_DENYLIST || "gemini_review,gemini_search"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
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

/** Get system prompt for a channel (if configured).
 *  経理 channel の場合は protected_rows section を末尾に append する。 */
export function getChannelSystemPrompt(channelId: string): string | undefined {
  const base = channelConfigs[channelId]?.systemPrompt;
  if (!base) return base;
  if (channelId === ACCOUNTING_CHANNEL_ID && PROTECTED_SECTION) {
    return `${base}\n${PROTECTED_SECTION}`;
  }
  return base;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
