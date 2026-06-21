/**
 * MCP + Discord Bot entry point.
 * stdout is reserved for MCP protocol — all console.log output is redirected to stderr.
 */
import "./dns-fix.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

console.log = (...args: unknown[]) => {
  console.error(...args);
};

import { config, getChannelMode, channelConfigs } from "./config.js";
import { getErrorMessage } from "./logger.js";
import { createClient, registerCommands } from "./discord/client.js";
import { setupCommandHandlers } from "./discord/commands.js";
import { SessionManager } from "./session/manager.js";
import { Semaphore, UserSemaphoreMap } from "./session/concurrency.js";
import { handleTurn } from "./discord/handlers.js";
import { downloadAttachments, buildImagePrompt, cleanupTempAttachments } from "./discord/attachments.js";
import { createMcpServer, startMcpTransport } from "./mcp/server.js";
import type { Message } from "discord.js";

const client = createClient();
const sessionManager = new SessionManager();
const globalSemaphore = new Semaphore(config.maxConcurrentSessions);
const userSemaphores = new UserSemaphoreMap();

const AI_CHAT_CHANNEL_ID = Object.entries(channelConfigs).find(
  ([, c]) => c.name === "ai_chat"
)?.[0] ?? "";

setupCommandHandlers(client, sessionManager);
setInterval(() => cleanupTempAttachments(), 30 * 60 * 1000);

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  // DMs: always respond
  if (!message.guild) {
    // fall through to handle
  } else {
    const mode = getChannelMode(message.channelId);
    const isMention = client.user && message.mentions.has(client.user.id);
    const isReplyToBot = message.reference && (await message.fetchReference().catch(() => null))?.author?.id === client.user?.id;

    if (mode === "none") return;
    if (mode === "mention" && !isMention && !isReplyToBot) return;
  }

  // User allowlist check
  if (config.allowedUserIds && !config.allowedUserIds.includes(message.author.id)) {
    return;
  }

  let content = message.content;
  if (client.user) {
    content = content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
  }

  // Handle image attachments
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

  // React immediately to acknowledge the message
  await message.react("👀").catch(() => {});

  try {
    const session = await sessionManager.getOrCreate(
      message.channelId,
      message.author.id
    );

    if (!message.guild || message.channelId === AI_CHAT_CHANNEL_ID || message.channel.isThread()) {
      await handleTurn(session, content, { type: "message", message });
    } else {
      const thread = await message.startThread({
        name: content.slice(0, 90) || "応答",
        autoArchiveDuration: 60,
      });
      await handleTurn(session, content, { type: "thread", thread, originalMessage: message });
    }

    await message.reactions.cache.get("👀")?.users.remove(client.user!.id).catch(() => {});
    await message.react("✅").catch(() => {});
  } catch (err) {
    const msg = getErrorMessage(err);
    console.error("[messageCreate] Error:", msg);
    await message.reply(`Error: ${msg}`).catch(() => {});
    await message.reactions.cache.get("👀")?.users.remove(client.user!.id).catch(() => {});
    await message.react("❌").catch(() => {});
  } finally {
    globalSemaphore.release();
    userSem.release();
  }
});

const mcpServer = createMcpServer(client);
startMcpTransport(mcpServer).then(() => {
  console.error("[mcp] Discord MCP server ready with 25 tools");
});

client.once("clientReady", async () => {
  console.error(`[bot] Logged in as ${client.user?.tag}`);
  if (client.user) {
    try {
      await registerCommands(client.user.id);
    } catch (err) {
      console.error("[bot] Failed to register commands:", err);
    }
  }
});

process.on("SIGINT", () => {
  console.error("[bot] Shutting down...");
  sessionManager.destroyAll();
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("[bot] Shutting down...");
  sessionManager.destroyAll();
  client.destroy();
  process.exit(0);
});

client.login(config.discordBotToken);
