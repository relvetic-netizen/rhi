import type {
  Guild,
  GuildBasedChannel,
  GuildMember,
  Message,
  Role,
  User,
  GuildScheduledEvent,
} from "discord.js";
import { ChannelType } from "discord.js";

export function fmtGuild(g: Guild): string {
  return [
    `Guild: ${g.name} (${g.id})`,
    `Owner: ${g.ownerId}`,
    `Members: ${g.memberCount}`,
    `Channels: ${g.channels.cache.size}`,
    `Created: ${g.createdAt.toISOString()}`,
  ].join("\n");
}

function channelTypeName(type: ChannelType): string {
  return ChannelType[type] ?? `Unknown(${type})`;
}

export function fmtChannel(c: GuildBasedChannel): string {
  const lines = [
    `#${c.name} (${c.id})`,
    `Type: ${channelTypeName(c.type)}`,
    `Position: ${"position" in c ? c.position : "N/A"}`,
  ];
  if ("topic" in c && c.topic) lines.push(`Topic: ${c.topic}`);
  if (c.parent) lines.push(`Category: ${c.parent.name}`);
  return lines.join("\n");
}

export function fmtMessage(m: Message): string {
  const authorTag = m.author?.tag ?? "System";
  const authorId = m.author?.id ?? "system";
  const lines = [
    `[${m.createdAt.toISOString()}] ${authorTag} (${authorId}): ${m.content || "(no text)"}`,
  ];
  if (m.embeds.length > 0) lines.push(`  Embeds: ${m.embeds.length}`);
  if (m.attachments.size > 0)
    lines.push(`  Attachments: ${m.attachments.map((a) => a.name).join(", ")}`);
  if (m.reference?.messageId)
    lines.push(`  Reply to: ${m.reference.messageId}`);
  return lines.join("\n");
}

export function fmtMember(m: GuildMember): string {
  return [
    `${m.user.tag} (${m.id})`,
    `Nick: ${m.nickname ?? "(none)"}`,
    `Roles: ${m.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => r.name)
      .join(", ") || "(none)"}`,
    `Joined: ${m.joinedAt?.toISOString() ?? "unknown"}`,
  ].join("\n");
}

export function fmtUser(u: User): string {
  return [
    `${u.tag} (${u.id})`,
    `Bot: ${u.bot}`,
    `Created: ${u.createdAt.toISOString()}`,
  ].join("\n");
}

export function fmtRole(r: Role): string {
  return [
    `${r.name} (${r.id})`,
    `Color: ${r.hexColor}`,
    `Position: ${r.position}`,
    `Members: ${r.members.size}`,
    `Mentionable: ${r.mentionable}`,
    `Hoisted: ${r.hoist}`,
  ].join("\n");
}

export function fmtEvent(e: GuildScheduledEvent): string {
  return [
    `${e.name} (${e.id})`,
    `Status: ${e.status}`,
    `Start: ${e.scheduledStartAt?.toISOString() ?? "TBD"}`,
    `End: ${e.scheduledEndAt?.toISOString() ?? "TBD"}`,
    `Location: ${e.entityMetadata?.location ?? e.channel?.name ?? "N/A"}`,
    `Description: ${e.description ?? "(none)"}`,
  ].join("\n");
}
