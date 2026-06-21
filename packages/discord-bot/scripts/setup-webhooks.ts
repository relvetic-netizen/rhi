/**
 * Create Discord webhooks for automated posting channels.
 */
import dotenv from "dotenv";
import path from "path";
import { Client, GatewayIntentBits, TextChannel } from "discord.js";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Replace these with your own Discord IDs (Developer Mode → right-click → Copy ID).
const GUILD_ID = process.env.GUILD_ID || "YOUR_GUILD_ID";
const CHANNELS = [
  { id: "YOUR_CHANNEL_ID_1", name: "notifications" },
  { id: "YOUR_CHANNEL_ID_2", name: "task-management" },
];

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_BOT_TOKEN);
  console.log(`Logged in as ${client.user?.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);

  for (const ch of CHANNELS) {
    const channel = (await guild.channels.fetch(ch.id)) as TextChannel;
    const webhook = await channel.createWebhook({
      name: `Scheduler`,
      reason: "Automated posting",
    });
    console.log(`#${ch.name}: ${webhook.url}`);
  }

  client.destroy();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
