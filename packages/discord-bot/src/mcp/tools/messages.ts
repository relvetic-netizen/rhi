import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import {
  type Client,
  type TextChannel,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import {
  resolveChannel,
  checkRateLimit,
  checkBotPermission,
} from "../utils/guards.js";
import { fmtMessage } from "../utils/formatters.js";

function asTextChannel(channel: { id: string; send?: unknown }): TextChannel {
  if (!("send" in channel)) {
    throw new Error(`Channel ${channel.id} is not a text-based channel.`);
  }
  return channel as TextChannel;
}

export function registerMessageTools(server: McpServer, client: Client): void {
  // discord_send_message
  safeTool(
    server,
    "discord_send_message",
    "Send a message to a Discord channel (supports embeds and replies)",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      content: z.string().describe("Message content"),
      embed: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          color: z.number().optional(),
          fields: z
            .array(
              z.object({
                name: z.string(),
                value: z.string(),
                inline: z.boolean().optional(),
              }),
            )
            .optional(),
        })
        .optional()
        .describe("Optional embed"),
      reply_to: z.string().optional().describe("Message ID to reply to"),
      files: z
        .array(z.string())
        .optional()
        .describe("File paths to attach (max 10 files, 25MB each)"),
    },
    async ({ guild_id, channel_id, content, embed, reply_to, files }) => {
      checkRateLimit(guild_id, "send_message");
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );

      const options: {
        content: string;
        embeds?: EmbedBuilder[];
        reply?: { messageReference: string };
        files?: AttachmentBuilder[];
      } = { content };
      if (embed) {
        const eb = new EmbedBuilder();
        if (embed.title) eb.setTitle(embed.title);
        if (embed.description) eb.setDescription(embed.description);
        if (embed.color !== undefined) eb.setColor(embed.color);
        if (embed.fields) eb.addFields(embed.fields);
        options.embeds = [eb];
      }
      if (reply_to) {
        options.reply = { messageReference: reply_to };
      }
      if (files && files.length > 0) {
        if (files.length > 10) throw new Error("Max 10 files per message.");
        const MAX_SIZE = 25 * 1024 * 1024;
        options.files = files.map((filePath: string) => {
          const resolved = path.resolve(filePath);
          if (!fs.existsSync(resolved))
            throw new Error(`File not found: ${filePath}`);
          const stat = fs.statSync(resolved);
          if (stat.size > MAX_SIZE)
            throw new Error(
              `File exceeds 25MB limit: ${filePath} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
            );
          return new AttachmentBuilder(resolved);
        });
      }

      const msg = await ch.send(options);
      return `Message sent: ${msg.id}`;
    },
  );

  // discord_read_messages
  safeTool(
    server,
    "discord_read_messages",
    "Read message history from a channel",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(25)
        .describe("Number of messages (1-100)"),
      before: z
        .string()
        .optional()
        .describe("Get messages before this message ID"),
      after: z
        .string()
        .optional()
        .describe("Get messages after this message ID"),
      from_user: z.string().optional().describe("Filter by user ID"),
    },
    async ({ guild_id, channel_id, limit, before, after, from_user }) => {
      checkRateLimit(guild_id, "read_messages");
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );

      const fetchOpts: { limit: number; before?: string; after?: string } = {
        limit,
      };
      if (before) fetchOpts.before = before;
      if (after) fetchOpts.after = after;

      const fetched = await ch.messages.fetch(fetchOpts);
      let messages = [...fetched.values()];
      if (from_user) {
        messages = messages.filter((m) => m.author.id === from_user);
      }

      if (messages.length === 0) return "No messages found.";
      return messages.map(fmtMessage).join("\n---\n");
    },
  );

  // discord_edit_message
  safeTool(
    server,
    "discord_edit_message",
    "Edit a message sent by the bot",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to edit"),
      content: z.string().describe("New content"),
    },
    async ({ guild_id, channel_id, message_id, content }) => {
      checkRateLimit(guild_id, "edit_message");
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );
      const msg = await ch.messages.fetch(message_id);

      const botId = client.user?.id ?? (await client.application?.fetch())?.id;
      if (!botId || msg.author.id !== botId) {
        throw new Error("Can only edit messages sent by the bot.");
      }

      await msg.edit(content);
      return `Message ${message_id} edited.`;
    },
  );

  // discord_delete_message
  safeTool(
    server,
    "discord_delete_message",
    "Delete a message",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to delete"),
    },
    async ({ guild_id, channel_id, message_id }) => {
      checkRateLimit(guild_id, "delete_message");
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );
      const msg = await ch.messages.fetch(message_id);
      await msg.delete();
      return `Message ${message_id} deleted.`;
    },
  );

  // discord_react
  safeTool(
    server,
    "discord_react",
    "Add a reaction to a message",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID"),
      emoji: z.string().describe("Emoji (unicode or custom format <:name:id>)"),
    },
    async ({ guild_id, channel_id, message_id, emoji }) => {
      checkRateLimit(guild_id, "react");
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );
      const msg = await ch.messages.fetch(message_id);
      await msg.react(emoji);
      return `Reaction ${emoji} added to message ${message_id}.`;
    },
  );

  // discord_await_reaction — used by the persona for the β confirm flow
  // (post preview → wait for ✅/❌ from operator → proceed or abort).
  safeTool(
    server,
    "discord_await_reaction",
    "Wait for a reaction on a posted message (✅/❌ confirm flow). Returns JSON with reacted/emoji/user_id or timed_out.",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to watch"),
      allowed_user_id: z
        .string()
        .optional()
        .describe(
          "If set, only this user's reaction counts (else any non-bot)",
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .default(60_000)
        .describe("Timeout in ms (default 60s, max 10min)"),
      emojis: z
        .array(z.string())
        .default(["✅", "❌"])
        .describe("Accepted emoji names (unicode)"),
    },
    async ({
      guild_id,
      channel_id,
      message_id,
      allowed_user_id,
      timeout_ms,
      emojis,
    }) => {
      const ch = asTextChannel(
        await resolveChannel(client, guild_id, channel_id),
      );
      const msg = await ch.messages.fetch(message_id);
      const collected = await msg
        .awaitReactions({
          filter: (reaction, user) => {
            if (user.bot) return false;
            if (allowed_user_id && user.id !== allowed_user_id) return false;
            const name = reaction.emoji.name ?? "";
            return emojis.includes(name);
          },
          max: 1,
          time: timeout_ms,
          errors: ["time"],
        })
        .catch(() => null);
      if (!collected || collected.size === 0) {
        return JSON.stringify({ reacted: false, timed_out: true });
      }
      const reaction = collected.first()!;
      const botId = client.user?.id;
      const userId =
        [...reaction.users.cache.keys()].find((id) => id !== botId) ?? null;
      return JSON.stringify({
        reacted: true,
        emoji: reaction.emoji.name,
        user_id: userId,
      });
    },
  );
}
