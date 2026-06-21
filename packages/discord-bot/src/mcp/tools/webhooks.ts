import { z } from "zod";
import { WebhookClient, EmbedBuilder } from "discord.js";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtGuild } from "../utils/formatters.js";

export function registerWebhookTools(server: McpServer, client: Client): void {
  // discord_webhook_send
  safeTool(
    server,
    "discord_webhook_send",
    "Send a message via a webhook URL (custom username/avatar)",
    {
      webhook_url: z.string().describe("Full webhook URL"),
      content: z.string().describe("Message content"),
      username: z.string().optional().describe("Override username"),
      avatar_url: z.string().optional().describe("Override avatar URL"),
    },
    async ({ webhook_url, content, username, avatar_url }) => {
      const webhook = new WebhookClient({ url: webhook_url });
      try {
        const msg = await webhook.send({
          content,
          username,
          avatarURL: avatar_url,
        });
        return `Webhook message sent: ${msg.id}`;
      } finally {
        webhook.destroy();
      }
    }
  );

  // discord_bulk_status
  safeTool(
    server,
    "discord_bulk_status",
    "Get a quick status overview of all guilds the bot is in",
    {},
    async () => {
      const cached = client.guilds.cache;

      // REST-only mode: limited info available
      if (cached.size === 0) {
        const fetched = await client.guilds.fetch();
        if (fetched.size === 0) return "Bot is not in any guilds.";
        const lines = await Promise.all(
          fetched.map(async (og) => {
            try {
              const g = await client.guilds.fetch(og.id);
              return `**${g.name}** (${g.id})\n  Members: ${g.memberCount}\n  Owner: ${g.ownerId}`;
            } catch {
              return `**${og.name}** (${og.id})`;
            }
          })
        );
        return lines.join("\n---\n");
      }

      const lines = cached.map((g) => {
        const textChannels = g.channels.cache.filter(
          (c) => c.isTextBased() && !c.isThread()
        ).size;
        const voiceChannels = g.channels.cache.filter((c) =>
          c.isVoiceBased()
        ).size;
        const onlineMembers = g.members.cache.filter(
          (m) => m.presence?.status !== "offline" && m.presence !== null
        ).size;

        return [
          `**${g.name}** (${g.id})`,
          `  Members: ${g.memberCount} (${onlineMembers} online)`,
          `  Channels: ${textChannels} text, ${voiceChannels} voice`,
          `  Owner: ${g.ownerId}`,
        ].join("\n");
      });

      return lines.join("\n---\n");
    }
  );
}
