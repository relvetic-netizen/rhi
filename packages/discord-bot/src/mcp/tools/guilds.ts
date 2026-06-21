import { z } from "zod";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtGuild, fmtMember, fmtMessage } from "../utils/formatters.js";

export function registerGuildTools(server: McpServer, client: Client): void {
  // discord_list_guilds
  safeTool(
    server,
    "discord_list_guilds",
    "List all guilds (servers) the bot is a member of",
    {},
    async () => {
      const cached = client.guilds.cache;
      if (cached.size > 0) {
        return cached
          .map((g) => `${g.name} (${g.id}) — ${g.memberCount} members`)
          .join("\n");
      }
      // REST-only mode: fetch via API
      const fetched = await client.guilds.fetch();
      if (fetched.size === 0) return "Bot is not in any guilds.";
      return fetched
        .map((g) => `${g.name} (${g.id})`)
        .join("\n");
    }
  );

  // discord_get_guild
  safeTool(
    server,
    "discord_get_guild",
    "Get detailed info about a guild",
    {
      guild_id: z.string().describe("Guild ID"),
    },
    async ({ guild_id }) => {
      checkRateLimit(guild_id, "get_guild");
      const guild = await resolveGuild(client, guild_id);
      return fmtGuild(guild);
    }
  );

  // discord_list_members
  safeTool(
    server,
    "discord_list_members",
    "List members of a guild (with roles)",
    {
      guild_id: z.string().describe("Guild ID"),
      limit: z.number().min(1).max(100).default(50).describe("Max members to fetch (1-100)"),
    },
    async ({ guild_id, limit }) => {
      checkRateLimit(guild_id, "list_members");
      const guild = await resolveGuild(client, guild_id);
      const members = await guild.members.list({ limit });

      if (members.size === 0) return "No members found.";
      return members.map(fmtMember).join("\n---\n");
    }
  );

  // discord_search_messages
  safeTool(
    server,
    "discord_search_messages",
    "Search messages in a channel by keyword (client-side filter, fetches up to 100 recent messages)",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      query: z.string().describe("Search keyword"),
      limit: z.number().min(1).max(100).default(50).describe("Max messages to scan (1-100)"),
    },
    async ({ guild_id, channel_id, query, limit }) => {
      checkRateLimit(guild_id, "search_messages");
      const guild = await resolveGuild(client, guild_id);
      const channel =
        guild.channels.cache.get(channel_id) ||
        (await guild.channels.fetch(channel_id).catch(() => null));

      if (!channel || !("messages" in channel)) {
        throw new Error(`Channel ${channel_id} not found or not text-based.`);
      }

      const textChannel = channel as import("discord.js").TextChannel;
      const messages = await textChannel.messages.fetch({ limit });
      const queryLower = query.toLowerCase();
      const matches = messages.filter(
        (m) =>
          m.content.toLowerCase().includes(queryLower) ||
          m.author.tag.toLowerCase().includes(queryLower)
      );

      if (matches.size === 0) return `No messages matching "${query}".`;
      return matches.map(fmtMessage).join("\n---\n");
    }
  );

  // discord_get_audit_log
  safeTool(
    server,
    "discord_get_audit_log",
    "Get recent audit log entries for a guild",
    {
      guild_id: z.string().describe("Guild ID"),
      limit: z.number().min(1).max(50).default(10).describe("Number of entries (1-50)"),
    },
    async ({ guild_id, limit }) => {
      checkRateLimit(guild_id, "get_audit_log");
      const guild = await resolveGuild(client, guild_id);
      const auditLogs = await guild.fetchAuditLogs({ limit });

      if (auditLogs.entries.size === 0) return "No audit log entries.";

      return auditLogs.entries
        .map((entry) => {
          return [
            `Action: ${entry.action} (${entry.actionType})`,
            `Executor: ${entry.executor?.tag ?? "unknown"}`,
            `Target: ${entry.target?.toString() ?? "unknown"}`,
            `Reason: ${entry.reason ?? "(none)"}`,
            `Date: ${entry.createdAt.toISOString()}`,
          ].join("\n");
        })
        .join("\n---\n");
    }
  );
}
