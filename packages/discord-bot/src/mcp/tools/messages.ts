import { z } from "zod";
import type { Client, TextChannel } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveChannel, checkRateLimit } from "../utils/guards.js";
import { fmtMessage } from "../utils/formatters.js";

function asTextChannel(channel: { id: string; send?: unknown }): TextChannel {
  if (!("send" in channel)) {
    throw new Error(`Channel ${channel.id} is not a text-based channel.`);
  }
  return channel as TextChannel;
}

export function registerMessageTools(server: McpServer, client: Client): void {
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
}
