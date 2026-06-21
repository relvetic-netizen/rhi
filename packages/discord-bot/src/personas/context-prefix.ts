import {
  ChannelType,
  type Message,
  type Guild,
  type TextBasedChannel,
} from "discord.js";
import type { ContextPrefix, ServerMapMember } from "./types.js";

const REPLY_TRUNCATE = 500;
const RECENT_TRUNCATE = 200;
const RECENT_COUNT = 5;
const MEMBER_CAP = 50;
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_FETCH_LIMIT = 200;

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function classifyChannel(type: number): "text" | "thread" | "dm" {
  if (type === ChannelType.DM) return "dm";
  if (
    type === ChannelType.PublicThread ||
    type === ChannelType.PrivateThread ||
    type === ChannelType.AnnouncementThread
  )
    return "thread";
  return "text";
}

export async function buildContextPrefix(
  msg: Message,
  notionSchemasAvailable: string[] = [],
): Promise<ContextPrefix> {
  const kind = classifyChannel(msg.channel.type);

  const guild = msg.guild ? { id: msg.guild.id, name: msg.guild.name } : null;

  const channelName =
    "name" in msg.channel && typeof msg.channel.name === "string"
      ? msg.channel.name
      : kind === "dm"
        ? "dm"
        : "unknown";
  const channelMeta: ContextPrefix["channel"] = {
    id: msg.channel.id,
    name: channelName,
    type: kind,
  };
  if (
    "topic" in msg.channel &&
    typeof msg.channel.topic === "string" &&
    msg.channel.topic
  ) {
    channelMeta.topic = msg.channel.topic;
  }

  let threadParent: ContextPrefix["threadParent"];
  if (kind === "thread" && "parent" in msg.channel && msg.channel.parent) {
    threadParent = {
      channelId: msg.channel.parent.id,
      channelName: msg.channel.parent.name,
    };
  }

  const replyTo = await buildReplyTo(msg);
  const recentMessages = await buildRecentMessages(msg);
  const mentionedMembers = buildMentionedMembers(msg);
  const serverMap = await buildServerMap(msg);

  return {
    guild,
    channel: channelMeta,
    threadParent,
    replyTo,
    recentMessages,
    mentionedMembers,
    serverMap,
    notionSchemasAvailable,
  };
}

async function buildReplyTo(msg: Message): Promise<ContextPrefix["replyTo"]> {
  if (!msg.reference) return undefined;
  try {
    const ref = await msg.fetchReference();
    return {
      authorId: ref.author.id,
      authorName: ref.member?.displayName ?? ref.author.username,
      content: truncate(ref.content, REPLY_TRUNCATE),
      timestamp: new Date(ref.createdTimestamp).toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function buildRecentMessages(
  msg: Message,
): Promise<ContextPrefix["recentMessages"]> {
  if (!msg.channel.isTextBased()) return [];
  try {
    const fetched = await msg.channel.messages.fetch({
      limit: RECENT_COUNT + 1,
      before: msg.id,
    });
    const sorted = [...fetched.values()].sort(
      (a, b) => a.createdTimestamp - b.createdTimestamp,
    );
    return sorted.slice(-RECENT_COUNT).map((m) => ({
      authorName: m.member?.displayName ?? m.author.username,
      content: truncate(m.content, RECENT_TRUNCATE),
      timestamp: new Date(m.createdTimestamp).toISOString(),
    }));
  } catch {
    return [];
  }
}

function buildMentionedMembers(
  msg: Message,
): ContextPrefix["mentionedMembers"] {
  if (!msg.mentions.members) return [];
  const out: ContextPrefix["mentionedMembers"] = [];
  for (const [, member] of msg.mentions.members) {
    out.push({
      id: member.id,
      displayName: member.displayName,
      roles: member.roles.cache
        .map((r) => r.name)
        .filter((n) => n !== "@everyone"),
    });
  }
  return out;
}

async function buildServerMap(
  msg: Message,
): Promise<ContextPrefix["serverMap"]> {
  if (!msg.guild) return { channels: [], members: [] };

  const channels: ContextPrefix["serverMap"]["channels"] = [];
  for (const [, ch] of msg.guild.channels.cache) {
    if (
      ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement ||
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread
    ) {
      const parentName =
        "parent" in ch && ch.parent && typeof ch.parent.name === "string"
          ? ch.parent.name
          : undefined;
      channels.push({
        channelId: ch.id,
        name: ch.name,
        category: parentName,
      });
    }
  }

  const members =
    msg.guild.memberCount <= MEMBER_CAP
      ? await buildFullMemberRoster(msg.guild)
      : await buildActiveMemberRoster(msg.channel, msg.guild);

  return { channels, members };
}

async function buildFullMemberRoster(guild: Guild): Promise<ServerMapMember[]> {
  try {
    await guild.members.fetch();
  } catch {
    // fetch may fail if GuildMembers intent is not granted;
    // fall back to whatever is already cached.
  }
  const out: ServerMapMember[] = [];
  for (const [, member] of guild.members.cache) {
    if (member.user.bot) continue;
    out.push({
      id: member.id,
      displayName: member.displayName,
      primaryRole: member.roles.hoist?.name ?? member.roles.highest?.name,
    });
  }
  return out;
}

async function buildActiveMemberRoster(
  channel: TextBasedChannel,
  guild: Guild,
): Promise<ServerMapMember[]> {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  try {
    const messages = await channel.messages.fetch({
      limit: ACTIVE_FETCH_LIMIT,
    });
    const counts = new Map<string, number>();
    for (const m of messages.values()) {
      if (m.createdTimestamp < cutoff) continue;
      if (m.author.bot) continue;
      counts.set(m.author.id, (counts.get(m.author.id) ?? 0) + 1);
    }
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MEMBER_CAP);
    const out: ServerMapMember[] = [];
    for (const [authorId] of sorted) {
      const member = guild.members.cache.get(authorId);
      if (!member) continue;
      out.push({
        id: authorId,
        displayName: member.displayName,
        primaryRole: member.roles.hoist?.name ?? member.roles.highest?.name,
      });
    }
    return out;
  } catch (err) {
    // Silent [] would let the persona hallucinate an empty server; surface the root cause.
    console.warn(
      `[persona-context] active roster fetch failed for guild ${guild.id}: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return [];
  }
}

/** JSON.stringify-escape any user-controlled string before embedding in the context block.
 *  Discord display names, channel topics, and role names are untrusted — an unescaped
 *  `</context>\n<system>...` could hijack prompt structure via injection.
 *
 *  Also replaces `<` inside the JSON-quoted value with `<` so that literal
 *  `<tag>` substrings in user data cannot be read as prompt-directives by the LLM.
 *  `>` is left alone because without a matching `<` it's no longer a tag opener. */
function safeStr(s: string | undefined): string {
  if (s === undefined || s === null) return '""';
  return JSON.stringify(s).replace(/</g, "\\u003C");
}

export function serializeForPrompt(ctx: ContextPrefix): string {
  const lines: string[] = ["<context>"];
  if (ctx.guild) {
    lines.push(
      `guild: name=${safeStr(ctx.guild.name)} id=${safeStr(ctx.guild.id)}`,
    );
  }
  const topicPart = ctx.channel.topic
    ? ` topic=${safeStr(ctx.channel.topic)}`
    : "";
  lines.push(
    `channel: name=${safeStr(ctx.channel.name)} id=${safeStr(ctx.channel.id)} type=${ctx.channel.type}${topicPart}`,
  );
  if (ctx.threadParent) {
    lines.push(
      `thread_parent: name=${safeStr(ctx.threadParent.channelName)} id=${safeStr(ctx.threadParent.channelId)}`,
    );
  }
  if (ctx.replyTo) {
    lines.push(
      `reply_to: author=${safeStr(ctx.replyTo.authorName)} id=${safeStr(ctx.replyTo.authorId)} at=${ctx.replyTo.timestamp}`,
    );
    lines.push(`  content: ${safeStr(ctx.replyTo.content)}`);
  }
  if (ctx.recentMessages.length > 0) {
    lines.push(`recent_messages:`);
    for (const m of ctx.recentMessages) {
      lines.push(
        `  - at=${m.timestamp} author=${safeStr(m.authorName)} content=${safeStr(m.content)}`,
      );
    }
  }
  if (ctx.mentionedMembers.length > 0) {
    lines.push(`mentioned_members:`);
    for (const mem of ctx.mentionedMembers) {
      const rolePart =
        mem.roles.length > 0 ? ` roles=${JSON.stringify(mem.roles)}` : "";
      lines.push(
        `  - name=${safeStr(mem.displayName)} id=${safeStr(mem.id)}${rolePart}`,
      );
    }
  }
  if (ctx.serverMap.channels.length > 0) {
    lines.push(`server_map.channels (${ctx.serverMap.channels.length}):`);
    for (const ch of ctx.serverMap.channels) {
      const cat = ch.category ? ` category=${safeStr(ch.category)}` : "";
      lines.push(
        `  - name=${safeStr(ch.name)} id=${safeStr(ch.channelId)}${cat}`,
      );
    }
  }
  if (ctx.serverMap.members.length > 0) {
    lines.push(`server_map.members (${ctx.serverMap.members.length}):`);
    for (const m of ctx.serverMap.members) {
      const role = m.primaryRole ? ` role=${safeStr(m.primaryRole)}` : "";
      lines.push(
        `  - name=${safeStr(m.displayName)} id=${safeStr(m.id)}${role}`,
      );
    }
  }
  if (ctx.notionSchemasAvailable.length > 0) {
    lines.push(
      `notion_schemas_available: ${JSON.stringify(ctx.notionSchemasAvailable)}`,
    );
  }
  lines.push("</context>");
  return lines.join("\n");
}
