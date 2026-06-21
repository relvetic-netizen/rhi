import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

import { Client } from "discord.js";

async function main() {
  const client = new Client({ intents: [] });
  const token = process.env.DISCORD_BOT_TOKEN!;
  client.token = token;
  client.rest.setToken(token);

  console.log("Testing REST-only mode...");

  // Test 1: Fetch guild (set GUILD_ID in your .env, or replace the fallback)
  const guild = await client.guilds.fetch(process.env.GUILD_ID || "YOUR_GUILD_ID");
  console.log(`✅ Guild: ${guild.name} (${guild.id})`);
  console.log(`   Members: ${guild.memberCount}`);

  // Test 2: Fetch channels
  const channels = await guild.channels.fetch();
  const textChannels = [...channels.values()].filter(c => c && c.type === 0);
  console.log(`✅ Channels: ${channels.size} total, ${textChannels.length} text`);

  for (const [, ch] of channels) {
    if (!ch) continue;
    console.log(`   #${ch.name} (${ch.id})`);
  }

  // Test 3: Fetch roles
  const roles = await guild.roles.fetch();
  console.log(`✅ Roles: ${roles.size}`);

  // Test 4: Send a test message (set TEST_CHANNEL_ID in your .env, or replace the fallback)
  const channel = await guild.channels.fetch(process.env.TEST_CHANNEL_ID || "YOUR_CHANNEL_ID");
  if (channel && "send" in channel) {
    const msg = await (channel as any).send("🔧 REST-only test message — verifying bot setup.");
    console.log(`✅ Message sent: ${msg.id}`);
    // Delete test message
    await msg.delete();
    console.log(`✅ Test message deleted`);
  }

  console.log("\n=== All REST-only tests passed ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Test failed:", e);
  process.exit(1);
});
