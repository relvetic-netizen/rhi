import { z } from "zod";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtRole } from "../utils/formatters.js";

export function registerRoleTools(server: McpServer, client: Client): void {
  // discord_list_roles
  safeTool(
    server,
    "discord_list_roles",
    "List all roles in a guild",
    {
      guild_id: z.string().describe("Guild ID"),
    },
    async ({ guild_id }) => {
      checkRateLimit(guild_id, "list_roles");
      const guild = await resolveGuild(client, guild_id);
      const roleCollection =
        guild.roles.cache.size > 0
          ? guild.roles.cache
          : await guild.roles.fetch();
      const roles = roleCollection.sort((a, b) => b.position - a.position);

      if (roles.size === 0) return "No roles found.";
      return roles.map(fmtRole).join("\n---\n");
    }
  );

  // discord_manage_role
  safeTool(
    server,
    "discord_manage_role",
    "Add or remove a role from a guild member",
    {
      guild_id: z.string().describe("Guild ID"),
      user_id: z.string().describe("User ID"),
      role_id: z.string().describe("Role ID"),
      action: z.enum(["add", "remove"]).describe("Add or remove the role"),
    },
    async ({ guild_id, user_id, role_id, action }) => {
      checkRateLimit(guild_id, "manage_role");
      const guild = await resolveGuild(client, guild_id);
      const member = await guild.members.fetch(user_id);
      const role =
        guild.roles.cache.get(role_id) ||
        (await guild.roles.fetch(role_id).catch(() => null));

      if (!role) {
        throw new Error(`Role ${role_id} not found in guild.`);
      }

      if (action === "add") {
        await member.roles.add(role);
        return `Role "${role.name}" added to ${member.user.tag}.`;
      } else {
        await member.roles.remove(role);
        return `Role "${role.name}" removed from ${member.user.tag}.`;
      }
    }
  );
}
