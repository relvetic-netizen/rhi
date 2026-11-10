import type { GuildBasedChannel, Message } from "discord.js";
import { ChannelType } from "discord.js";

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
