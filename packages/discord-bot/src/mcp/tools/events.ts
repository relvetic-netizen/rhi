import { z } from "zod";
import { GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from "discord.js";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { resolveGuild, checkRateLimit } from "../utils/guards.js";
import { fmtEvent } from "../utils/formatters.js";

export function registerEventTools(server: McpServer, client: Client): void {
  // discord_create_event
  safeTool(
    server,
    "discord_create_event",
    "Create a scheduled event in a guild",
    {
      guild_id: z.string().describe("Guild ID"),
      name: z.string().describe("Event name"),
      description: z.string().optional().describe("Event description"),
      start_time: z.string().describe("ISO 8601 start time"),
      end_time: z.string().optional().describe("ISO 8601 end time"),
      location: z.string().optional().describe("External location (for external events)"),
      channel_id: z.string().optional().describe("Voice/Stage channel ID (for voice events)"),
    },
    async ({ guild_id, name, description, start_time, end_time, location, channel_id }) => {
      checkRateLimit(guild_id, "create_event");
      const guild = await resolveGuild(client, guild_id);

      const isExternal = !channel_id;

      const endTime = end_time
        || (isExternal ? new Date(new Date(start_time).getTime() + 3600_000).toISOString() : undefined);

      const event = await guild.scheduledEvents.create({
        name,
        scheduledStartTime: start_time,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        ...(description && { description }),
        ...(endTime && { scheduledEndTime: endTime }),
        ...(isExternal
          ? {
              entityType: GuildScheduledEventEntityType.External,
              entityMetadata: { location: location || "TBD" },
            }
          : {
              entityType: GuildScheduledEventEntityType.Voice,
              channel: channel_id,
            }),
      });
      return `Event created: ${event.name} (${event.id})\nStart: ${event.scheduledStartAt?.toISOString()}`;
    }
  );

  // discord_list_events
  safeTool(
    server,
    "discord_list_events",
    "List scheduled events in a guild",
    {
      guild_id: z.string().describe("Guild ID"),
    },
    async ({ guild_id }) => {
      checkRateLimit(guild_id, "list_events");
      const guild = await resolveGuild(client, guild_id);
      const events = await guild.scheduledEvents.fetch();

      if (events.size === 0) return "No scheduled events.";
      return events.map(fmtEvent).join("\n---\n");
    }
  );

  // discord_delete_event
  safeTool(
    server,
    "discord_delete_event",
    "Delete a scheduled event",
    {
      guild_id: z.string().describe("Guild ID"),
      event_id: z.string().describe("Event ID"),
    },
    async ({ guild_id, event_id }) => {
      checkRateLimit(guild_id, "delete_event");
      const guild = await resolveGuild(client, guild_id);
      const events = await guild.scheduledEvents.fetch();
      const event = events.get(event_id);
      if (!event) throw new Error(`Event ${event_id} not found.`);
      const name = event.name;
      await event.delete();
      return `Event "${name}" (${event_id}) deleted.`;
    }
  );
}
