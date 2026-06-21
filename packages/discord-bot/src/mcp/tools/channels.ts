import { z } from "zod";
import {
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
  Collection,
  type Client,
  type TextChannel,
  type NewsChannel,
  type GuildBasedChannel,
  type GuildChannel,
} from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import {
  resolveGuild,
  resolveChannel,
  checkRateLimit,
  checkBotPermission,
  isAdminMcpEnabled,
} from "../utils/guards.js";
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

  // discord_get_channel
  safeTool(
    server,
    "discord_get_channel",
    "Get detailed info about a channel (topic, pins, etc.)",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
    },
    async ({ guild_id, channel_id }) => {
      checkRateLimit(guild_id, "get_channel");
      const channel = await resolveChannel(client, guild_id, channel_id);
      let info = fmtChannel(channel);

      if ("messages" in channel) {
        const pins = await (channel as TextChannel).messages.fetchPinned();
        if (pins.size > 0) {
          info += `\nPinned messages: ${pins.size}`;
          info +=
            "\n" +
            pins
              .first(5)!
              .map(
                (m) =>
                  `  - ${m.author.tag}: ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}`,
              )
              .join("\n");
        }
      }

      return info;
    },
  );

  // discord_create_thread
  safeTool(
    server,
    "discord_create_thread",
    "Create a new thread in a channel",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      name: z.string().describe("Thread name"),
      message_id: z
        .string()
        .optional()
        .describe("Message ID to start thread from"),
      auto_archive_duration: z
        .enum(["60", "1440", "4320", "10080"])
        .default("1440")
        .describe("Auto-archive duration in minutes"),
    },
    async ({
      guild_id,
      channel_id,
      name,
      message_id,
      auto_archive_duration,
    }) => {
      checkRateLimit(guild_id, "create_thread");
      const channel = await resolveChannel(client, guild_id, channel_id);

      if (!("threads" in channel)) {
        throw new Error("This channel does not support threads.");
      }

      const textCh = channel as TextChannel;
      const archiveDuration = parseInt(auto_archive_duration) as
        | 60
        | 1440
        | 4320
        | 10080;

      if (message_id) {
        const thread = await textCh.threads.create({
          startMessage: message_id,
          name,
          autoArchiveDuration: archiveDuration,
        });
        return `Thread created: ${thread.name} (${thread.id})`;
      } else {
        const thread = await textCh.threads.create({
          name,
          autoArchiveDuration: archiveDuration,
        });
        return `Thread created: ${thread.name} (${thread.id})`;
      }
    },
  );

  // discord_pin_message
  safeTool(
    server,
    "discord_pin_message",
    "Pin or unpin a message",
    {
      guild_id: z.string().describe("Guild ID"),
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID"),
      action: z.enum(["pin", "unpin"]).default("pin").describe("Pin or unpin"),
    },
    async ({ guild_id, channel_id, message_id, action }) => {
      checkRateLimit(guild_id, "pin_message");
      const channel = await resolveChannel(client, guild_id, channel_id);

      if (!("messages" in channel)) {
        throw new Error("This channel does not support messages.");
      }

      const msg = await (channel as TextChannel).messages.fetch(message_id);

      if (action === "pin") {
        await msg.pin();
        return `Message ${message_id} pinned.`;
      } else {
        await msg.unpin();
        return `Message ${message_id} unpinned.`;
      }
    },
  );

  // discord_set_channel_topic
  // Gate admin-mutation tools (topic / permissions / create) behind MCP_OPERATOR_ID
  // to prevent prompt-injection from escalating to guild-admin mutation.
  if (isAdminMcpEnabled()) {
    safeTool(
      server,
      "discord_set_channel_topic",
      "Set the topic of a text channel",
      {
        guild_id: z.string().describe("Guild ID"),
        channel_id: z.string().describe("Channel ID"),
        topic: z.string().max(1024).describe("New channel topic"),
      },
      async ({ guild_id, channel_id, topic }) => {
        checkRateLimit(guild_id, "set_channel_topic");
        const channel = await resolveChannel(client, guild_id, channel_id);

        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        ) {
          throw new Error(
            "Topic can only be set on text or announcement channels.",
          );
        }

        await (channel as TextChannel).setTopic(topic);
        return `Channel topic updated to: ${topic}`;
      },
    );

    // discord_get_channel_permissions
    safeTool(
      server,
      "discord_get_channel_permissions",
      "Get permission overwrites for a channel (shows who has explicit access)",
      {
        guild_id: z.string().describe("Guild ID"),
        channel_id: z.string().describe("Channel ID"),
      },
      async ({ guild_id, channel_id }) => {
        checkRateLimit(guild_id, "get_channel_permissions");
        const channel = await resolveChannel(client, guild_id, channel_id);

        if (!("permissionOverwrites" in channel)) {
          throw new Error(
            "This channel type does not support permission overwrites.",
          );
        }
        const guildChannel = channel as GuildChannel;

        const overwrites = guildChannel.permissionOverwrites.cache;
        if (overwrites.size === 0)
          return "No permission overwrites (using default permissions).";

        const guild = await resolveGuild(client, guild_id);
        const lines: string[] = [];

        for (const [id, overwrite] of overwrites) {
          const type =
            overwrite.type === OverwriteType.Role ? "role" : "member";
          let name = id;

          if (type === "role") {
            const role =
              guild.roles.cache.get(id) ||
              (await guild.roles.fetch(id).catch(() => null));
            name = role ? `@${role.name}` : id;
          } else {
            const member = await guild.members.fetch(id).catch(() => null);
            name = member ? `${member.user.tag}` : id;
          }

          const allowed = overwrite.allow.toArray();
          const denied = overwrite.deny.toArray();
          lines.push(
            `${type}: ${name} (${id})` +
              (allowed.length > 0 ? `\n  Allow: ${allowed.join(", ")}` : "") +
              (denied.length > 0 ? `\n  Deny: ${denied.join(", ")}` : ""),
          );
        }

        return lines.join("\n---\n");
      },
    );

    // discord_set_channel_permissions
    safeTool(
      server,
      "discord_set_channel_permissions",
      "Set permission overwrites for a member or role on a channel",
      {
        guild_id: z.string().describe("Guild ID"),
        channel_id: z.string().describe("Channel ID"),
        target_id: z.string().describe("User ID or Role ID"),
        target_type: z
          .enum(["member", "role"])
          .describe("Whether target is a member or role"),
        action: z
          .enum(["allow", "deny", "remove"])
          .describe(
            "allow: grant access, deny: block access, remove: delete overwrite",
          ),
        permissions: z
          .array(z.string())
          .default(["ViewChannel", "SendMessages", "ReadMessageHistory"])
          .describe(
            "Permission names (e.g. ViewChannel, SendMessages, ReadMessageHistory)",
          ),
      },
      async ({
        guild_id,
        channel_id,
        target_id,
        target_type,
        action,
        permissions,
      }) => {
        checkRateLimit(guild_id, "set_channel_permissions");
        const channel = await resolveChannel(client, guild_id, channel_id);

        if (!("permissionOverwrites" in channel)) {
          throw new Error(
            "This channel type does not support permission overwrites.",
          );
        }
        const guildChannel = channel as GuildChannel;
        const guild = await resolveGuild(client, guild_id);

        // Verify target exists
        if (target_type === "member") {
          await guild.members.fetch(target_id);
        } else {
          const role =
            guild.roles.cache.get(target_id) ||
            (await guild.roles.fetch(target_id).catch(() => null));
          if (!role) throw new Error(`Role ${target_id} not found.`);
        }

        if (action === "remove") {
          await guildChannel.permissionOverwrites.delete(target_id);
          return `Permission overwrite removed for ${target_type} ${target_id} on #${guildChannel.name}.`;
        }

        // Build permission object (guard against prototype pollution via "__proto__" etc.)
        const permObj: Record<string, boolean> = Object.create(null);
        const value = action === "allow";
        for (const perm of permissions) {
          if (
            !Object.prototype.hasOwnProperty.call(PermissionFlagsBits, perm)
          ) {
            throw new Error(
              `Unknown permission: ${perm}. Valid: ${Object.keys(PermissionFlagsBits).join(", ")}`,
            );
          }
          permObj[perm] = value;
        }

        await guildChannel.permissionOverwrites.edit(target_id, permObj, {
          type:
            target_type === "role" ? OverwriteType.Role : OverwriteType.Member,
        });

        return `Permissions ${action === "allow" ? "granted" : "denied"} for ${target_type} ${target_id} on #${guildChannel.name}: ${permissions.join(", ")}`;
      },
    );

    // discord_create_channel — persona β flow uses this after operator ✅ on permission preview
    safeTool(
      server,
      "discord_create_channel",
      "Create a new text or announcement channel. Optionally copies permissionOverwrites from a sibling channel.",
      {
        guild_id: z.string().describe("Guild ID"),
        name: z.string().describe("New channel name (kebab-case)"),
        type: z
          .enum(["text", "announcement"])
          .default("text")
          .describe("Channel kind"),
        parent_category_id: z
          .string()
          .optional()
          .describe("Category channel ID to nest under"),
        topic: z.string().optional().describe("Channel topic / description"),
        copy_permissions_from_channel_id: z
          .string()
          .optional()
          .describe(
            "Sibling channel ID — its permissionOverwrites are copied verbatim",
          ),
      },
      async ({
        guild_id,
        name,
        type,
        parent_category_id,
        topic,
        copy_permissions_from_channel_id,
      }) => {
        checkRateLimit(guild_id, "create_channel");
        const guild = await resolveGuild(client, guild_id);

        let permissionOverwrites:
          | Array<{
              id: string;
              allow?: bigint;
              deny?: bigint;
              type: OverwriteType;
            }>
          | undefined;
        if (copy_permissions_from_channel_id) {
          const sibling = await resolveChannel(
            client,
            guild_id,
            copy_permissions_from_channel_id,
          );
          if (!("permissionOverwrites" in sibling)) {
            throw new Error(
              "Sibling channel has no permissionOverwrites to copy.",
            );
          }
          const overwrites = (sibling as GuildChannel).permissionOverwrites
            .cache;
          permissionOverwrites = overwrites.map((o) => ({
            id: o.id,
            allow: o.allow.bitfield,
            deny: o.deny.bitfield,
            type: o.type,
          }));
        }

        const channelType =
          type === "announcement"
            ? ChannelType.GuildAnnouncement
            : ChannelType.GuildText;

        const newChannel = await guild.channels.create({
          name,
          type: channelType,
          parent: parent_category_id,
          topic,
          permissionOverwrites,
        });

        return `Channel #${newChannel.name} created (id: ${newChannel.id})${
          copy_permissions_from_channel_id
            ? ` with ${permissionOverwrites?.length ?? 0} permission overwrite(s) copied from ${copy_permissions_from_channel_id}`
            : ""
        }.`;
      },
    );
  } // end isAdminMcpEnabled()
}
