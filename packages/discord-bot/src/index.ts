import "./dns-fix.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import {
  config,
  getChannelMode,
  getChannelPersona,
  channelConfigs,
} from "./config.js";
import { getErrorMessage } from "./logger.js";
import { createClient, registerCommands } from "./discord/client.js";
import { setupCommandHandlers } from "./discord/commands.js";
import { SessionManager } from "./session/manager.js";
import { Semaphore, UserSemaphoreMap } from "./session/concurrency.js";
import { handleTurn, markProcessed } from "./discord/handlers.js";
import {
  downloadAttachments,
  buildImagePrompt,
  cleanupTempAttachments,
} from "./discord/attachments.js";
import { createHttpMcpServer } from "./mcp/http-tool-filter.js";
import { startHttpMcpServer } from "./mcp/http-transport.js";
import { buildClientReadyProbe } from "./mcp/client-ready-probe.js";
import {
  routeMentionToPersona,
  startCleanupJob as startPersonaCleanup,
  stopCleanupJob as stopPersonaCleanup,
  destroyAllSessions as destroyPersonaSessions,
  clearGuildSession,
  getPersona,
  requirePersona,
  writeStopTombstone,
  isStopTombstoned,
  deriveGuildKey,
} from "./personas/index.js";
import type { Message } from "discord.js";

const client = createClient();
const sessionManager = new SessionManager();
const globalSemaphore = new Semaphore(config.maxConcurrentSessions);

/** #ai_chat channel — direct reply instead of thread. Resolved by channel ID, not name. */
const AI_CHAT_CHANNEL_ID =
  Object.entries(channelConfigs).find(([, c]) => c.name === "ai_chat")?.[0] ??
  "";
const userSemaphores = new UserSemaphoreMap();

/** Exact-match stop command. Authorized human only. */
const STOP_PATTERNS =
  /^\s*(stop|止めて|やめて|終了|もういい|おしまい)[。.!！\s]*$/i;

setupCommandHandlers(client, sessionManager);
setInterval(() => cleanupTempAttachments(), 30 * 60 * 1000);
startPersonaCleanup();

// Persona pipeline is opt-in via BOT_PERSONA. When set, fail loudly if it isn't a
// known persona (defined in persona.config.json) — better than a silent typo.
if (config.botPersona) {
  const p = getPersona(config.botPersona);
  if (!p) {
    console.error(
      `[bot] FATAL: BOT_PERSONA="${config.botPersona}" is not a known persona ` +
        `(define it in persona.config.json or RHI_PERSONA_CONFIG). Aborting.`,
    );
    process.exit(1);
  }
  console.log(
    `[bot] persona=${p.name} peer_bot_ids=[${config.peerBotIds.join(",")}] cost_fuse=${config.maxAiTurnsPerConversation}`,
  );
} else {
  console.log(
    `[bot] no BOT_PERSONA set — persona pipeline disabled (generic-Claude only)`,
  );
}

client.on("messageCreate", async (message: Message) => {
  // 1. Self ID guard — never react to our own posts (defense vs PEER_BOT_IDS misconfiguration).
  if (client.user && message.author.id === client.user.id) return;

  // 2. Bot guard with peer-bot allowlist
  const isPeerBot =
    message.author.bot && config.peerBotIds.includes(message.author.id);
  if (message.author.bot && !isPeerBot) return;

  // 3. Authorized-human stop command — short-circuit BEFORE anything else.
  //    Peer bots cannot trigger stop (a runaway peer must not also halt us).
  //    User allowlist applies (only allowed users can issue stop).
  if (
    config.botPersona &&
    !isPeerBot &&
    STOP_PATTERNS.test(message.content) &&
    (!config.allowedUserIds ||
      config.allowedUserIds.includes(message.author.id))
  ) {
    const persona = requirePersona(config.botPersona);
    const guildKey = deriveGuildKey(message);
    clearGuildSession(persona.name, guildKey);
    await writeStopTombstone(persona, guildKey).catch(() => undefined);
    await message.reply(`（会話を終わります）`).catch(() => undefined);
    return;
  }

  // 4. Channel mode + gating
  let channelMode: "auto" | "mention" | "none" | "persona" | "dm" = "dm";
  let isMention = false;
  let isReplyToBot = false;
  if (!message.guild) {
    // DM: always respond
  } else {
    channelMode = getChannelMode(message.channelId);
    isMention = !!(client.user && message.mentions.has(client.user.id));
    isReplyToBot = !!(
      message.reference &&
      (await message.fetchReference().catch(() => null))?.author?.id ===
        client.user?.id
    );

    if (channelMode === "none") return;

    if (channelMode === "mention") {
      if (!isMention && !isReplyToBot) return;
    } else if (channelMode === "persona") {
      // Persona-mode gating:
      //   - human author: must @-mention or reply-to-bot (existing behavior)
      //   - peer bot: must @-mention (NOT just isReplyToBot — that lets two bots ping-pong without user supervision)
      if (isPeerBot) {
        if (!isMention) return;
      } else {
        if (!isMention && !isReplyToBot) return;
      }
    }
  }

  // 5. User allowlist — skipped for peer bots (they're allowlisted via PEER_BOT_IDS)
  if (
    !isPeerBot &&
    config.allowedUserIds &&
    !config.allowedUserIds.includes(message.author.id)
  ) {
    return;
  }

  // 6. Persona-mode routing
  const personaName =
    channelMode === "persona"
      ? getChannelPersona(message.channelId)
      : undefined;
  if (personaName && config.personaDiscord) {
    if (personaName !== config.botPersona) {
      // This bot doesn't service this persona — silent ignore. Other bots may pick it up.
      return;
    }
    const persona = requirePersona(personaName);
    const guildKey = deriveGuildKey(message);

    // Stop tombstone check (5 min TTL): if a stop happened recently, ignore the next peer bot
    // engagement to break ping-pong tail.
    if (isPeerBot && (await isStopTombstoned(persona, guildKey))) {
      console.log(
        `[persona] tombstone active ${persona.name}:${guildKey} — ignore peer bot reply`,
      );
      return;
    }

    const clientId = client.user!.id;
    await message.react("👀").catch(() => {});
    try {
      await routeMentionToPersona(message, persona);
      await markProcessed(message, clientId, "ok");
    } catch (err) {
      console.error(`[persona:${persona.name}] Error:`, getErrorMessage(err));
      await message
        .reply(`(${persona.name} エラー) ${getErrorMessage(err)}`)
        .catch(() => {});
      await markProcessed(message, clientId, "err");
    }
    return;
  }

  // 7. Generic-Claude path (auto / mention / DM channels not bound to a persona)
  let content = message.content;
  if (client.user) {
    content = content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .trim();
  }

  const imagePaths = await downloadAttachments(message.attachments);
  const imagePrefix = buildImagePrompt(imagePaths);

  if (!content && imagePaths.length === 0) return;
  content = imagePrefix + (content || "この画像について説明してください");

  const userSem = userSemaphores.get(message.author.id);
  if (!userSem.tryAcquire()) {
    await message.reply("You already have a request in progress. Please wait.");
    return;
  }
  await globalSemaphore.acquire();

  await message.react("👀").catch(() => {});

  try {
    const session = await sessionManager.getOrCreate(
      message.channelId,
      message.author.id,
    );

    if (
      !message.guild ||
      message.channelId === AI_CHAT_CHANNEL_ID ||
      message.channel.isThread()
    ) {
      await handleTurn(session, content, { type: "message", message });
    } else {
      const thread = await message.startThread({
        name: content.slice(0, 90) || "応答",
        autoArchiveDuration: 60,
      });
      await handleTurn(session, content, {
        type: "thread",
        thread,
        originalMessage: message,
      });
    }

    await markProcessed(message, client.user!.id, "ok");
  } catch (err) {
    const msg = getErrorMessage(err);
    console.error("[messageCreate] Error:", msg);
    await message.reply(`Error: ${msg}`).catch(() => {});
    await markProcessed(message, client.user!.id, "err");
  } finally {
    globalSemaphore.release();
    userSem.release();
  }
});

client.once("clientReady", async () => {
  console.log(`[bot] Logged in as ${client.user?.tag}`);
  if (client.user) {
    try {
      await registerCommands(client.user.id);
    } catch (err) {
      console.error("[bot] Failed to register commands:", err);
    }
  }
});

let httpMcpHandle: { close: () => Promise<void> } | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`[bot] Shutting down (${signal})...`);
  // Outer hard-kill in case any awaited close (Discord, HTTP MCP, persona)
  // hangs — NSSM would eventually SIGKILL, but a deterministic exit beats a zombie.
  const hardKill = setTimeout(() => {
    console.error("[bot] Shutdown stuck after 10s, forcing exit");
    process.exit(1);
  }, 10_000);
  hardKill.unref();
  stopPersonaCleanup();
  destroyPersonaSessions();
  sessionManager.destroyAll();
  if (httpMcpHandle) {
    try {
      await httpMcpHandle.close();
    } catch (err) {
      console.error("[bot] HTTP MCP close failed:", err);
    }
  }
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  if (config.mcpHttpEnable) {
    try {
      httpMcpHandle = await startHttpMcpServer(createHttpMcpServer(client), {
        isClientReady: buildClientReadyProbe(client),
      });
    } catch (err) {
      console.error("[bot] FATAL: HTTP MCP failed to start:", err);
      process.exit(1);
    }
  }
  try {
    await client.login(config.discordBotToken);
  } catch (err) {
    console.error("[bot] FATAL: Discord login failed:", err);
    if (httpMcpHandle) {
      await httpMcpHandle.close().catch(() => undefined);
    }
    process.exit(1);
  }
}

void main();
