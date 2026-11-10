import {
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
} from "discord.js";
import type { SessionManager } from "../session/manager.js";
import { handleTurn } from "./handlers.js";
import { config, channelConfigs } from "../config.js";
import type { ReplyTarget } from "./handlers.js";
import { getErrorMessage } from "../logger.js";
import {
  ClaudeRegistry,
  defaultRegistryPath,
} from "../claude-bridge/registry.js";
import { launchClaude } from "../claude-bridge/launcher.js";
import {
  killAllRegistryAndCse,
  killByPid,
  formatKillReport,
} from "../claude-bridge/killer.js";
import {
  listClaudeProcesses,
  classify,
} from "../claude-bridge/cse-sessions/inspector.js";
import {
  formatList,
  formatKillByPid,
} from "../claude-bridge/cse-sessions/formatter.js";
import { clearGuildSession } from "../personas/session-manager.js";
import { deriveGuildKey } from "../personas/types.js";
import { getChannelMode } from "../config.js";
import os from "os";
import path from "path";

const claudeRegistry = new ClaudeRegistry(defaultRegistryPath());

/** #ai_chat channel ID — direct reply instead of thread */
const AI_CHAT_CHANNEL_ID =
  Object.entries(channelConfigs).find(([, c]) => c.name === "ai_chat")?.[0] ??
  "";

/**
 * For most channels: deferReply → editReply with pointer → create thread → return thread target.
 * For #ai_chat: deferReply → return interaction target (direct reply).
 */
async function deferAndPrepareTarget(
  interaction: ChatInputCommandInteraction,
): Promise<ReplyTarget> {
  await interaction.deferReply();

  // Direct reply in DMs, #ai_chat, or inside threads/forum posts (can't nest threads)
  const channel = interaction.channel;
  if (
    !interaction.guild ||
    interaction.channelId === AI_CHAT_CHANNEL_ID ||
    channel?.isThread()
  ) {
    return { type: "interaction", interaction };
  }

  const reply = await interaction.fetchReply();
  const thread = await reply.startThread({
    name: `/${interaction.commandName} ${interaction.options.getString("prompt")?.slice(0, 70) || "応答"}`,
    autoArchiveDuration: 60,
  });
  return { type: "thread", thread, originalMessage: reply };
}

export function setupCommandHandlers(
  client: Client,
  sessionManager: SessionManager,
): void {
  /** Commands available to all users (non-authorized included) */
  const publicCommands = new Set(["ask", "help", "clear", "status"]);

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // Two-tier permission: public commands for everyone, rest for authorized users only
    const isAuthorized =
      !config.allowedUserIds ||
      config.allowedUserIds.includes(interaction.user.id);
    if (!isAuthorized && !publicCommands.has(interaction.commandName)) {
      await interaction.reply({
        content:
          "このコマンドは認可ユーザーのみ使用できます。\n使用可能: /ask, /help, /clear, /status",
        ephemeral: true,
      });
      return;
    }

    try {
      switch (interaction.commandName) {
        case "ask":
          await handleAsk(interaction, sessionManager);
          break;
        case "code":
          await handleCode(interaction, sessionManager);
          break;
        case "clear":
          await handleClear(interaction, sessionManager);
          break;
        case "status":
          await handleStatus(interaction, sessionManager);
          break;
        case "help":
          await handleHelp(interaction);
          break;
        case "claude":
          await handleClaudeLaunch(interaction);
          break;
        case "claude-list":
          await handleClaudeList(interaction);
          break;
        case "claude-exit":
          await handleClaudeExit(interaction);
          break;
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      console.error(`[commands] Error in /${interaction.commandName}:`, msg);
      const reply = interaction.deferred
        ? interaction.editReply.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({ content: `Error: ${msg}`, ephemeral: true } as any).catch(
        () => {},
      );
    }
  });
}

async function handleAsk(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

async function handleCode(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const workingDir = interaction.options.getString("working_dir");

  if (workingDir) {
    const resolved = path.resolve(workingDir);
    const allowed = config.allowedWorkingDirs.some((dir) =>
      resolved.startsWith(path.resolve(dir)),
    );
    if (!allowed) {
      await interaction.reply({
        content: `Working directory not allowed: ${resolved}`,
        ephemeral: true,
      });
      return;
    }
  }

  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
    { workingDir: workingDir || undefined },
  );
  await handleTurn(session, prompt, target);
}

async function handleClear(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  // If this channel is in persona mode, clear THIS bot's persona session for the guild.
  const mode = interaction.guild ? getChannelMode(interaction.channelId) : "dm";
  if (mode === "persona" && config.botPersona) {
    const personaName = config.botPersona;
    const guildKey = deriveGuildKey(interaction);
    const killed = clearGuildSession(personaName, guildKey);
    await interaction.reply({
      content: killed
        ? `このサーバーの ${personaName} session を破棄した。次メッセージから新セッション。`
        : `${personaName} session 無し。`,
      ephemeral: true,
    });
    return;
  }

  // Existing channel-scoped clear for non-persona modes
  const destroyed = sessionManager.destroySession(interaction.channelId);
  await interaction.reply({
    content: destroyed
      ? "Session cleared. A new session will start on your next message."
      : "No active session in this channel.",
    ephemeral: true,
  });
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const session = sessionManager.get(interaction.channelId);

  if (!session) {
    await interaction.reply({
      content: "No active session in this channel.",
      ephemeral: true,
    });
    return;
  }

  const uptime = Math.round((Date.now() - session.lastActivity) / 1000);
  const embed = new EmbedBuilder()
    .setTitle("Claude Code Session")
    .setColor(session.subprocess.alive ? 0x00ff00 : 0xff0000)
    .addFields(
      {
        name: "Status",
        value: session.subprocess.alive ? "Active" : "Inactive",
        inline: true,
      },
      { name: "Channel", value: `<#${session.channelId}>`, inline: true },
      { name: "Last Activity", value: `${uptime}s ago`, inline: true },
      {
        name: "Active Sessions",
        value: `${sessionManager.activeCount}`,
        inline: true,
      },
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("RHI Assistant — コマンド一覧")
    .setColor(0x5865f2)
    .setDescription("Discord経由でClaude Codeを操作するBotです。")
    .addFields(
      { name: "/ask <prompt>", value: "質問・相談（汎用）", inline: true },
      {
        name: "/code <prompt>",
        value: "コード実行（ツール制限なし）",
        inline: true,
      },
      { name: "/clear", value: "セッション破棄", inline: true },
      { name: "/status", value: "セッション状態確認", inline: true },
      {
        name: "/claude [name] [cwd]",
        value: "独立 Claude をバックグラウンド起動（Remote Control）",
        inline: true,
      },
      {
        name: "/claude-list",
        value: "registry セッションと cse_session を一覧表示",
        inline: true,
      },
      {
        name: "/claude-exit [pid]",
        value: "Claude セッションを終了（pid 指定で個別 kill）",
        inline: true,
      },
    )
    .addFields({
      name: "メッセージ応答",
      value:
        "#ai_chat: 全メッセージに応答\n案件チャンネル: @メンション時のみ\n画像添付: 自動認識・解析",
    })
    .setFooter({ text: "RHI Assistant v1.1" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleClaudeLaunch(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const name = interaction.options.getString("name") || undefined;
  const cwdOpt = interaction.options.getString("cwd") || undefined;
  const cwd = cwdOpt
    ? path.resolve(cwdOpt.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : os.homedir();

  try {
    const result = await launchClaude(claudeRegistry, { name, cwd });
    await interaction.reply({
      content: `Claude "${result.name}" launched (PID ${result.pid}, cwd=${result.cwd}). スマホアプリの Remote Control から接続してください。`,
      ephemeral: true,
    });
  } catch (err) {
    const msg = getErrorMessage(err);
    await interaction.reply({
      content: `Launch failed: ${msg}`,
      ephemeral: true,
    });
  }
}

async function handleClaudeList(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (process.platform !== "win32") {
    await interaction.reply({
      content: "Windows 専用です (PowerShell 依存)",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  try {
    const procs = await listClaudeProcesses();
    const classified = classify(procs, claudeRegistry.list());
    const text = formatList(classified);
    await interaction.editReply({ content: "```\n" + text + "\n```" });
  } catch (err) {
    const msg = getErrorMessage(err);
    await interaction.editReply({ content: `List failed: ${msg}` });
  }
}

async function handleClaudeExit(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const pidOpt = interaction.options.getInteger("pid");
    if (process.platform !== "win32") {
      await interaction.editReply({
        content: "Windows 専用です (PowerShell 依存)",
      });
      return;
    }
    const procs = await listClaudeProcesses();
    const classified = classify(procs, claudeRegistry.list());
    const ctx = {
      botPid: process.pid,
      registryPids: classified.registry.map((r) => r.proc.pid),
      cseSessionPids: classified.cse.map((c) => c.proc.pid),
    };

    if (pidOpt !== null) {
      const result = await killByPid(pidOpt, ctx, claudeRegistry);
      await interaction.editReply({ content: formatKillByPid(result) });
      return;
    }

    const result = await killAllRegistryAndCse(
      claudeRegistry,
      ctx.cseSessionPids,
    );
    await interaction.editReply({ content: formatKillReport(result) });
  } catch (err) {
    const msg = getErrorMessage(err);
    await interaction.editReply({
      content: `Kill failed: ${msg}`,
    });
  }
}
