import { z } from "zod";
import { Collection, type Client, type GuildBasedChannel } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtChannel } from "../utils/formatters.js";

export function registerChannelTools(server: McpServer, client: Client): void {
  // discord_list_channels
  safeTool(
    server,
    "discord_list_channels",
    "List all channels in a guild",
    {
      guild_id: z.string().describe("Guild ID"),
    },
    async ({ guild_id }) => {
      checkRateLimit(guild_id, "list_channels");
      const guild = await resolveGuild(client, guild_id);
      let channels: Collection<string, GuildBasedChannel>;
      if (guild.channels.cache.size > 0) {
        channels = guild.channels.cache;
      } else {
        const fetched = await guild.channels.fetch();
        channels = new Collection<string, GuildBasedChannel>();
        for (const [id, ch] of fetched) {
          if (ch) channels.set(id, ch);
        }
      }
      channels = channels.sort(
        (a, b) =>
          ("position" in a ? a.position : 0) -
          ("position" in b ? b.position : 0),
      );

      if (channels.size === 0) return "No channels found.";
      return channels.map(fmtChannel).join("\n---\n");
    },
  );
}
