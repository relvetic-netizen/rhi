/**
 * One-time setup script: Create project channels, utility channels,
 * set permissions, rename an existing channel, delete old channels.
 *
 * Usage: npx tsx scripts/setup-channels.ts
 */
import dotenv from "dotenv";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  OverwriteType,
} from "discord.js";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Replace these with your own Discord IDs (Developer Mode → right-click → Copy ID).
const GUILD_ID = process.env.GUILD_ID || "YOUR_GUILD_ID";

// Owner accounts (full access to every channel created below)
const OWNER_IDS = [
  "YOUR_OWNER_USER_ID",
  // "ANOTHER_OWNER_USER_ID",
];

// Collaborator IDs (extra members for the comic channel example below)
const MIX_IDS = [
  "YOUR_COLLABORATOR_USER_ID",
  // "ANOTHER_COLLABORATOR_USER_ID",
];
const COLLABORATOR_ID_2 = "YOUR_COLLABORATOR_USER_ID_2";

// Bot ID (the application/bot user this script logs in as)
const BOT_ID = process.env.BOT_ID || "YOUR_BOT_USER_ID";

// Existing channels to handle
const EXISTING_CHANNEL_ID = "YOUR_EXISTING_CHANNEL_ID"; // example: rename to a project channel
const OLD_CHANNEL_ID_1 = "YOUR_OLD_CHANNEL_ID_1";       // example: delete
const OLD_CHANNEL_ID_2 = "YOUR_OLD_CHANNEL_ID_2";       // example: delete

// Project channels to create (private, owner-only unless specified).
// Replace the names with your own projects and set notionPageId to your Notion
// page/database ID (or any string you want shown in the channel topic).
const PROJECT_CHANNELS = [
  { name: "project-alpha", notionPageId: "YOUR_NOTION_PAGE_ID" },
  { name: "project-beta", notionPageId: "YOUR_NOTION_PAGE_ID" },
  { name: "project-gamma", notionPageId: "YOUR_NOTION_PAGE_ID" },
];

// Utility channels (owner-only)
const UTILITY_CHANNELS = [
  { name: "notifications", topic: "Deadline alerts, mail notifications, daily reports" },
  { name: "task-management", topic: "Weekly review, task registration, scheduling" },
  { name: "agent-reports", topic: "Agent work reports" },
];

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
  console.log(`Logged in as ${client.user?.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  console.log(`Guild: ${guild.name}`);

  const botMember = await guild.members.fetch(BOT_ID);

  // Helper: create private channel visible only to specified users + bot
  async function createPrivateChannel(
    name: string,
    topic: string,
    allowedUserIds: string[]
  ) {
    const permissionOverwrites = [
      // Deny @everyone
      {
        id: guild.id,
        type: OverwriteType.Role as const,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      // Allow bot
      {
        id: BOT_ID,
        type: OverwriteType.Member as const,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageThreads,
          PermissionFlagsBits.CreatePublicThreads,
        ],
      },
      // Allow specified users
      ...allowedUserIds.map((userId) => ({
        id: userId,
        type: OverwriteType.Member as const,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.CreatePublicThreads,
        ],
      })),
    ];

    const channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      topic,
      permissionOverwrites,
    });

    console.log(`  Created #${name} (${channel.id})`);
    return channel;
  }

  // 1. Rename an existing channel and set permissions (example)
  console.log("\n--- Renaming existing channel ---");
  try {
    const existingChannel = await guild.channels.fetch(EXISTING_CHANNEL_ID);
    if (existingChannel) {
      await existingChannel.setName("renamed-channel");
      // Set permissions: owners + collaborators + bot
      const comicUsers = [...OWNER_IDS, ...MIX_IDS, COLLABORATOR_ID_2];
      await existingChannel.permissionOverwrites.set([
        {
          id: guild.id,
          type: OverwriteType.Role,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: BOT_ID,
          type: OverwriteType.Member,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageThreads,
            PermissionFlagsBits.CreatePublicThreads,
          ],
        },
        ...comicUsers.map((userId) => ({
          id: userId,
          type: OverwriteType.Member as const,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.CreatePublicThreads,
          ],
        })),
      ]);
      console.log(`  Renamed and set permissions for #renamed-channel (${existingChannel.id})`);
    }
  } catch (e) {
    console.error(`  Failed to rename channel:`, e);
  }

  // 2. Delete old channels
  console.log("\n--- Deleting old channels ---");
  for (const [name, id] of [
    ["old-channel-1", OLD_CHANNEL_ID_1],
    ["old-channel-2", OLD_CHANNEL_ID_2],
  ]) {
    try {
      const ch = await guild.channels.fetch(id);
      if (ch) {
        await ch.delete(`Cleanup: replaced by new channel structure`);
        console.log(`  Deleted #${name}`);
      }
    } catch (e) {
      console.error(`  Failed to delete #${name}:`, e);
    }
  }

  // 3. Create project channels
  console.log("\n--- Creating project channels ---");
  const channelIds: Record<string, string> = {};

  for (const proj of PROJECT_CHANNELS) {
    const ch = await createPrivateChannel(
      proj.name,
      `Project channel — Notion: ${proj.notionPageId}`,
      OWNER_IDS
    );
    channelIds[proj.name] = ch.id;
  }

  // 4. Create utility channels
  console.log("\n--- Creating utility channels ---");
  for (const util of UTILITY_CHANNELS) {
    const ch = await createPrivateChannel(util.name, util.topic, OWNER_IDS);
    channelIds[util.name] = ch.id;
  }

  // 5. Summary
  console.log("\n=== Channel Setup Complete ===");
  console.log("\nChannel IDs (save these for channels.json):");
  console.log(JSON.stringify(channelIds, null, 2));
  console.log(`\n#renamed-channel: ${EXISTING_CHANNEL_ID}`);

  client.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
