import {
  Client,
  PermissionFlagsBits,
  type GuildMember,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";

const MCP_ALLOWED_GUILD_IDS = process.env.MCP_ALLOWED_GUILD_IDS
  ? process.env.MCP_ALLOWED_GUILD_IDS.split(",").map((s) => s.trim())
  : null;

// Rate limiter: per guild+action, 10 requests per 10 seconds
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 10;

export function checkRateLimit(guildId: string, action: string): void {
  const key = `${guildId}:${action}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }

  if (bucket.count >= RATE_LIMIT) {
    throw new Error(
      `Rate limit exceeded for ${action} in guild ${guildId}. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)}s.`,
    );
  }

  bucket.count++;
}

export function checkGuildAllowed(guildId: string): void {
  if (MCP_ALLOWED_GUILD_IDS && !MCP_ALLOWED_GUILD_IDS.includes(guildId)) {
    throw new Error(
      `Guild ${guildId} is not in MCP_ALLOWED_GUILD_IDS whitelist.`,
    );
  }
}

export async function resolveGuild(
  client: Client,
  guildId: string,
): Promise<Guild> {
  checkGuildAllowed(guildId);
  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));
  if (!guild) {
    throw new Error(
      `Guild ${guildId} not found. Bot may not be a member of this server.`,
    );
  }
  return guild;
}

export async function resolveChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<GuildBasedChannel> {
  const guild = await resolveGuild(client, guildId);
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel) {
    throw new Error(`Channel ${channelId} not found in guild ${guildId}.`);
  }
  return channel;
}

/** Admin mutation tools (channel create / permission / topic) are gated by an
 *  env flag so they are off by default. Set MCP_OPERATOR_ID=<discord_user_id>
 *  to enable. This prevents prompt-injection → unauthed guild-admin chains. */
export function isAdminMcpEnabled(): boolean {
  return !!process.env.MCP_OPERATOR_ID;
}

export function checkBotPermission(
  member: GuildMember,
  permission: bigint,
  actionName: string,
): void {
  if (!member.permissions.has(permission)) {
    const permName =
      Object.entries(PermissionFlagsBits).find(
        ([, v]) => v === permission,
      )?.[0] ?? String(permission);
    throw new Error(
      `Bot lacks permission "${permName}" required for ${actionName}.`,
    );
  }
}
