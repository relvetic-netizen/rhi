import { randomBytes } from "crypto";
import type { Message, TextBasedChannel } from "discord.js";
import type { SDKAssistantMessage, SDKResultMessage } from "../types.js";
import { StreamingResponse } from "../response/streaming.js";
import { formatAssistantMessage } from "../response/formatter.js";
import { buildContextPrefix, serializeForPrompt } from "./context-prefix.js";
import {
  getSchemas,
  getSchemaNames,
  serializeForFirstMessage,
} from "./notion-schema-cache.js";
import {
  ensureSession,
  sendUserMessage,
  killSession,
  type PersonaSessionHandle,
} from "./spawn.js";
import { deriveGuildKey } from "./types.js";
import type { PersonaConfig } from "./types.js";
import { config, getChannelPersonaModel } from "../config.js";
import {
  withGuildLock,
  getQueueDepth,
  clearGuildSession,
  QueueFullError,
} from "./session-manager.js";
import { TooManySessionsError } from "./types.js";

export async function routeMentionToPersona(
  msg: Message,
  persona: PersonaConfig,
): Promise<void> {
  const guildKey = deriveGuildKey(msg);
  const clientId = msg.client.user?.id;

  // Reaction while queued behind prior turn(s).
  const preDepth = getQueueDepth(persona.name, guildKey);
  const waiting = preDepth > 0 ? msg.react("⏳").catch(() => undefined) : null;

  try {
    await withGuildLock(persona.name, guildKey, async () => {
      if (waiting) {
        await waiting;
        if (clientId) {
          await msg.reactions.cache
            .get("⏳")
            ?.users.remove(clientId)
            .catch(() => undefined);
        }
      }
      await runOneTurn(msg, persona, guildKey);
    });
  } catch (err) {
    if (err instanceof TooManySessionsError || err instanceof QueueFullError) {
      await msg
        .reply(`ちょっと立て込んでる、後で返す (${err.message})`)
        .catch(() => undefined);
      return;
    }
    throw err;
  }
}

async function runOneTurn(
  msg: Message,
  persona: PersonaConfig,
  guildKey: string,
): Promise<void> {
  // 1. Cost-fuse pre-check: have we already exceeded MAX_AI_TURNS_PER_CONVERSATION?
  const handle = await ensureSession(persona, guildKey, {
    model: msg.guild ? getChannelPersonaModel(msg.channel.id) : undefined,
  });
  if (handle.turnCount >= config.maxAiTurnsPerConversation) {
    await msg
      .reply(
        `（cost fuse 発動: ${persona.name} が ${config.maxAiTurnsPerConversation} turn 連続で動いたので休憩します）`,
      )
      .catch(() => undefined);
    clearGuildSession(persona.name, guildKey);
    return;
  }

  // 2. Gather schemas (24h TTL cache) + context prefix
  const schemas = await getSchemas();
  const ctx = await buildContextPrefix(msg, getSchemaNames(schemas));

  // 3. Compose prompt parts. Use a random nonce tag so untrusted user content
  //    cannot close the envelope via literal `</user_message>` injection.
  const contextBlock = serializeForPrompt(ctx);
  const userMessage = stripBotMention(msg);
  const nonce = randomBytes(8).toString("hex");
  const userBlock = [
    `<user_message_${nonce} author=${JSON.stringify(msg.author.username)} timestamp=${JSON.stringify(new Date(msg.createdTimestamp).toISOString())}>`,
    userMessage,
    `</user_message_${nonce}>`,
  ].join("\n");

  // 4. Notion schemas first message only
  const isFirstMessage = !handle.sessionId;
  const notionBlock = isFirstMessage ? serializeForFirstMessage(schemas) : "";

  const prompt = [contextBlock, notionBlock, userBlock]
    .filter((p) => p && p.length > 0)
    .join("\n\n");

  // 5. Wire Discord reply output (reuse existing StreamingResponse)
  const target = await buildReplyTarget(msg);
  const channel = extractChannel(msg);
  if (!channel) {
    throw new Error(
      `routeMentionToPersona: channel is not text-based for msg ${msg.id}`,
    );
  }
  const streaming = new StreamingResponse(channel, target);

  await runTurn(persona, guildKey, handle, prompt, streaming);
}

function runTurn(
  persona: PersonaConfig,
  guildKey: string,
  handle: PersonaSessionHandle,
  prompt: string,
  streaming: StreamingResponse,
): Promise<void> {
  const { router, subprocess } = handle;

  return new Promise<void>((resolve, reject) => {
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      router.removeListener("text_delta", onDelta);
      router.removeListener("assistant", onAssistant);
      router.removeListener("result", onResult);
      router.removeListener("error", onError);
      subprocess.removeListener("exit", onExit);
    };

    const onDelta = (text: string) => streaming.appendDelta(text);

    const onAssistant = (msg: SDKAssistantMessage) => {
      const formatted = formatAssistantMessage(msg);
      if (formatted) streaming.setFinalContent(formatted);
    };

    const onResult = async (msg: SDKResultMessage) => {
      cleanup();
      try {
        const footer =
          msg.subtype !== "success" && "errors" in msg && msg.errors.length > 0
            ? `\n**Error:** ${msg.errors.join(", ")}`
            : "";
        await streaming.finalize(footer);
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = () => {
      cleanup();
      streaming
        .finalize("\n*Session ended unexpectedly.*")
        .then(resolve, reject);
    };

    router.on("text_delta", onDelta);
    router.on("assistant", onAssistant);
    router.on("result", onResult);
    router.on("error", onError);
    subprocess.once("exit", onExit);

    sendUserMessage(persona, guildKey, prompt).catch((err) => {
      cleanup();
      reject(err);
    });
  });
}

function stripBotMention(msg: Message): string {
  const clientId = msg.client.user?.id;
  let text = msg.content;
  if (clientId) {
    text = text.replace(new RegExp(`<@!?${clientId}>`, "g"), "").trim();
  }
  return text;
}

function extractChannel(msg: Message): TextBasedChannel | null {
  return msg.channel.isTextBased() ? (msg.channel as TextBasedChannel) : null;
}

async function buildReplyTarget(
  msg: Message,
): Promise<import("../discord/handlers.js").ReplyTarget> {
  if (msg.channel.isThread()) {
    return { type: "thread", thread: msg.channel, originalMessage: msg };
  }
  return { type: "message", message: msg };
}

export { deriveGuildKey } from "./types.js";
export type {
  ContextPrefix,
  GuildKey,
  PersonaName,
  PersonaConfig,
  PersonaSessionOptions,
  MentionedMember,
  ServerMapChannel,
  ServerMapMember,
  ReplyTo,
  RecentMessage,
} from "./types.js";
export { PersonaError, TooManySessionsError } from "./types.js";
