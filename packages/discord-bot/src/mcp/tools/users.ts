import { z } from "zod";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtUser } from "../utils/formatters.js";

export function registerUserTools(server: McpServer, client: Client): void {
  // discord_get_user
  safeTool(
    server,
    "discord_get_user",
    "Get information about a user",
    {
      guild_id: z.string().describe("Guild ID (for context)"),
      user_id: z.string().describe("User ID"),
    },
    async ({ guild_id, user_id }) => {
      checkRateLimit(guild_id, "get_user");
      const user = await client.users.fetch(user_id);
      const guild = await resolveGuild(client, guild_id);
      let info = fmtUser(user);

      try {
        const member = await guild.members.fetch(user_id);
        info += `\nNickname: ${member.nickname ?? "(none)"}`;
        info += `\nRoles: ${member.roles.cache
          .filter((r) => r.name !== "@everyone")
          .map((r) => r.name)
          .join(", ") || "(none)"}`;
        info += `\nJoined: ${member.joinedAt?.toISOString() ?? "unknown"}`;
      } catch {
        info += "\n(Not a member of this guild)";
      }

      return info;
    }
  );

  // discord_send_dm
  safeTool(
    server,
    "discord_send_dm",
    "Send a direct message to a user",
    {
      guild_id: z.string().describe("Guild ID (for rate limiting scope)"),
      user_id: z.string().describe("User ID"),
      content: z.string().describe("Message content"),
    },
    async ({ guild_id, user_id, content }) => {
      checkRateLimit(guild_id, "send_dm");
      const user = await client.users.fetch(user_id);
      const dm = await user.send(content);
      return `DM sent to ${user.tag}: ${dm.id}`;
    }
  );

  // discord_get_presence
  safeTool(
    server,
    "discord_get_presence",
    "Get a user's online/offline status (requires Presence Intent)",
    {
      guild_id: z.string().describe("Guild ID"),
      user_id: z.string().describe("User ID"),
    },
    async ({ guild_id, user_id }) => {
      checkRateLimit(guild_id, "get_presence");
      const guild = await resolveGuild(client, guild_id);
      const member = await guild.members.fetch(user_id);
      const presence = member.presence;

      if (!presence) {
        return `${member.user.tag}: offline (or presence not cached)`;
      }

      const activities = presence.activities
        .map((a) => `${a.type}: ${a.name}${a.state ? ` (${a.state})` : ""}`)
        .join(", ");

      return [
        `${member.user.tag}: ${presence.status}`,
        activities ? `Activities: ${activities}` : null,
        `Client: ${JSON.stringify(presence.clientStatus ?? {})}`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  );
}
