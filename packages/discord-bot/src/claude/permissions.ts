import {
  EmbedBuilder,
  type TextBasedChannel,
  type Message,
  type MessageReaction,
  type User,
} from "discord.js";
import type { Session } from "../session/session.js";
import type { SDKControlRequest, CanUseToolRequest } from "../types.js";
import { config } from "../config.js";

const SAFE_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "View"]);
const PROMPT_TIMEOUT_MS = 60_000;

export class PermissionHandler {
  private session: Session;
  private channel: TextBasedChannel;

  constructor(session: Session, channel: TextBasedChannel) {
    this.session = session;
    this.channel = channel;
  }

  async handle(msg: SDKControlRequest): Promise<void> {
    const req = msg.request as CanUseToolRequest;
    if (req.subtype !== "can_use_tool") return;

    const toolName = req.tool_name;
    const toolUseId = req.tool_use_id;
    const requestId = msg.request_id;

    switch (config.permissionMode) {
      case "auto":
        await this.autoHandle(requestId, toolName, toolUseId, req);
        break;
      case "prompt":
        await this.promptUser(requestId, toolName, toolUseId, req);
        break;
      case "deny":
        await this.deny(requestId, toolUseId, "All tools denied by policy");
        break;
    }
  }

  private async autoHandle(
    requestId: string,
    toolName: string,
    toolUseId: string,
    req: CanUseToolRequest
  ): Promise<void> {
    if (SAFE_TOOLS.has(toolName)) {
      await this.allow(requestId, toolUseId);
    } else {
      await this.promptUser(requestId, toolName, toolUseId, req);
    }
  }

  private async promptUser(
    requestId: string,
    toolName: string,
    toolUseId: string,
    req: CanUseToolRequest
  ): Promise<void> {
    const inputPreview = JSON.stringify(req.input, null, 2).slice(0, 1000);

    const embed = new EmbedBuilder()
      .setTitle(`Permission Request: ${toolName}`)
      .setDescription(req.description || `Claude wants to use **${toolName}**`)
      .addFields({
        name: "Input",
        value: `\`\`\`json\n${inputPreview}\n\`\`\``,
      })
      .setColor(0xffa500)
      .setFooter({
        text: `React ✅ to allow, ❌ to deny (${PROMPT_TIMEOUT_MS / 1000}s timeout)`,
      });

    if (!("send" in this.channel)) return this.deny(requestId, toolUseId, "Cannot prompt in this channel type");
    const promptMsg = await this.channel.send({ embeds: [embed] });
    await promptMsg.react("✅");
    await promptMsg.react("❌");

    try {
      const collected = await promptMsg.awaitReactions({
        filter: (reaction: MessageReaction, user: User) =>
          !user.bot &&
          user.id === this.session.userId &&
          ["✅", "❌"].includes(reaction.emoji.name || ""),
        max: 1,
        time: PROMPT_TIMEOUT_MS,
      });

      const reaction = collected.first();
      if (reaction?.emoji.name === "✅") {
        await this.allow(requestId, toolUseId);
        await promptMsg.edit({
          embeds: [embed.setColor(0x00ff00).setFooter({ text: "Allowed" })],
        });
      } else {
        await this.deny(requestId, toolUseId, "Denied by user");
        await promptMsg.edit({
          embeds: [embed.setColor(0xff0000).setFooter({ text: "Denied" })],
        });
      }
    } catch {
      await this.deny(requestId, toolUseId, "Permission timed out");
      await promptMsg
        .edit({
          embeds: [embed.setColor(0xff0000).setFooter({ text: "Timed out - denied" })],
        })
        .catch(() => {});
    }
  }

  private async allow(requestId: string, toolUseId: string): Promise<void> {
    await this.session.respondToPermission(requestId, {
      behavior: "allow",
      toolUseID: toolUseId,
    });
  }

  private async deny(
    requestId: string,
    toolUseId: string,
    message: string
  ): Promise<void> {
    await this.session.respondToPermission(requestId, {
      behavior: "deny",
      toolUseID: toolUseId,
      message,
    });
  }
}
