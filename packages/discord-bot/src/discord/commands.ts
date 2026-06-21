import {
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
} from "discord.js";
import type { SessionManager } from "../session/manager.js";
import { handleTurn } from "./handlers.js";
import {
  config,
  notionDatabaseIds,
  channelConfigs,
  resolveNotionIds,
} from "../config.js";
import type { ReplyTarget } from "./handlers.js";
import { downloadAttachments, buildImagePrompt } from "./attachments.js";
import { handlePc } from "./pc-control.js";
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
import {
  invalidate as invalidateNotionCache,
  notifyWrite as notifyNotionWrite,
} from "../personas/notion-schema-cache.js";
import {
  appendAudit,
  buildEntry as buildAuditEntry,
} from "../audit/audit-log.js";
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
        case "project":
          await handleProject(interaction, sessionManager);
          break;
        case "deadline":
          await handleDeadline(interaction, sessionManager);
          break;
        case "task":
          await handleTask(interaction);
          break;
        case "week":
          await handleWeek(interaction, sessionManager);
          break;
        case "newproject":
          await handleNewProject(interaction, sessionManager);
          break;
        case "invoice":
          await handleInvoice(interaction, sessionManager);
          break;
        case "expense":
          await handleExpense(interaction, sessionManager);
          break;
        case "received":
          await handleReceived(interaction, sessionManager);
          break;
        case "help":
          await handleHelp(interaction);
          break;
        case "pc":
          await handlePc(interaction, sessionManager);
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
        case "refresh-notion":
          await handleRefreshNotion(interaction);
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

async function handleProject(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const name = interaction.options.getString("name", true);
  const prompt = `Notion Projects DBから「${name}」の案件情報を取得して、現在のステータス・締切・最新のタスク状況を教えてください。Projects DB Data Source ID: ${notionDatabaseIds.projects || "MISSING_NOTION_ID"}`;
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

async function handleDeadline(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const prompt = `Notion Projects DB (Data Source ID: ${notionDatabaseIds.projects || "MISSING_NOTION_ID"}) から全案件の締切一覧を取得して、締切が近い順にリスト表示してください。期限超過は🔴、今日は🟡、3日以内は🟠、それ以降は🟢で色分けしてください。`;
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

async function handleWeek(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const prompt = `あなたはRHI（れるべち重工業）の業務アシスタントです。週次レビューを作成してください。

手順:
1. Notion MCP で Projects DB (id: "collection://${notionDatabaseIds.projects || "MISSING_NOTION_ID"}") から全案件を取得
2. 各案件のステータス、締切、優先度を確認
3. Google Calendar MCP で来週の予定を取得
4. このチャンネルにスレッド付きで投稿（discord MCPは使わず直接返答）

フォーマット:
📋 週次レビュー
【案件一覧】常駐/受託/自社に分類、ステータスと締切
【来週の予定】カレンダーから
【優先度提案】締切と重要度から判断

日本語で、全案件を漏れなくリスト。締切が近い案件は警告マーク付き。`;
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

const ACCOUNTING_DS_PLACEHOLDER = "MISSING_NOTION_ID";

function accountingDsId(): string {
  return notionDatabaseIds.accounting || ACCOUNTING_DS_PLACEHOLDER;
}

/**
 * v3 統合 Accounting DB は単一 DS で、種別 select prop により
 * income / expense / invoice_issued / invoice_received / receipt を区別する。
 * 旧 alias (issuedInvoices / receivedInvoices / expenses) は廃止。
 */
export function buildInvoicePrompt(action: string): string {
  const ds = accountingDsId();
  switch (action) {
    case "unpaid":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_issued AND ステータス=送信済み」で filter (notion-fetch query.filter に \`{ "and": [ { "property": "種別", "select": { "equals": "invoice_issued" } }, { "property": "ステータス", "status": { "equals": "送信済み" } } ] }\`) し、支払期限順にリスト表示してください。期限超過は🔴、今日は🟡、3日以内は🟠、それ以降は🟢で色分け。合計金額も表示。該当なしなら「未入金の請求書はありません」と回答。`;
    case "monthly":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_issued AND 発行日=今月」で filter し、今月発行した請求書を一覧表示してください。金額合計（税抜・税込）も表示。`;
    case "summary":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_issued」で filter し、今月と先月の売上を比較サマリーで表示してください。入金済み/未入金の内訳、案件別の金額も表示。`;
    default:
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_issued」で filter し、状況をまとめてください。`;
  }
}

export function buildExpensePrompt(action: string): string {
  const ds = accountingDsId();
  switch (action) {
    case "monthly":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=expense AND 日付=今月」で filter (notion-fetch query.filter に \`{ "property": "種別", "select": { "equals": "expense" } }\`) し、今月の経費を一覧表示してください。合計金額も表示。`;
    case "by_category":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=expense AND 日付=今月」で filter し、経費をカテゴリ別に集計して表示してください。各カテゴリの合計と全体合計を表示。`;
    case "tax":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=expense AND 日付=今年度」で filter し、勘定科目別に集計してください。確定申告用のフォーマットで、勘定科目ごとの合計と年間合計を表示。`;
    default:
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=expense」で filter し、状況をまとめてください。`;
  }
}

export function buildReceivedPrompt(action: string): string {
  const ds = accountingDsId();
  switch (action) {
    case "unpaid":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_received AND ステータス∈{未処理, 承認済み}」で filter (notion-fetch query.filter に \`{ "and": [ { "property": "種別", "select": { "equals": "invoice_received" } }, { "or": [ { "property": "ステータス", "status": { "equals": "未処理" } }, { "property": "ステータス", "status": { "equals": "承認済み" } } ] } ] }\`) し、支払期限順にリスト表示してください。期限超過は🔴、今日は🟡、3日以内は🟠、それ以降は🟢で色分け。合計金額も表示。`;
    case "monthly":
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_received AND 受領日=今月」で filter し、今月受領した請求書を一覧表示してください。合計金額も表示。`;
    default:
      return `Notion Accounting DB (Data Source ID: ${ds}) を「種別=invoice_received」で filter し、状況をまとめてください。`;
  }
}

async function handleInvoice(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  const prompt = buildInvoicePrompt(action);
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

async function handleExpense(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  const prompt = buildExpensePrompt(action);
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
}

async function handleReceived(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const action = interaction.options.getString("action", true);
  const prompt = buildReceivedPrompt(action);
  const target = await deferAndPrepareTarget(interaction);
  const session = await sessionManager.getOrCreate(
    interaction.channelId,
    interaction.user.id,
  );
  await handleTurn(session, prompt, target);
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
      { name: "/project <name>", value: "案件ステータス確認", inline: true },
      { name: "/deadline", value: "全案件の締切一覧", inline: true },
      { name: "/task <text>", value: "Notionにタスク作成", inline: true },
      {
        name: "/newproject <name>",
        value: "新規案件セットアップ",
        inline: true,
      },
      { name: "/week", value: "週次レビュー実行", inline: true },
      { name: "/pc <action>", value: "PC遠隔操作・スクショ", inline: true },
      {
        name: "/invoice <action>",
        value: "請求書一覧・売上サマリー",
        inline: true,
      },
      {
        name: "/expense <action>",
        value: "経費一覧・カテゴリ集計",
        inline: true,
      },
      { name: "/received <action>", value: "受領請求書の確認", inline: true },
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
        "#ai_chat: 全メッセージに応答\n#経理: 請求書/経費を自然言語管理\n案件チャンネル: @メンション時のみ\n画像添付: 自動認識・解析",
    })
    .setFooter({ text: "RHI Assistant v1.1" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleTask(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const text = interaction.options.getString("text", true);
  const targetDbId = notionDatabaseIds.tasks || "MISSING_NOTION_ID";

  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTION_API_KEY || ""}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: targetDbId },
        properties: {
          タスク: {
            title: [{ text: { content: text.slice(0, 200) } }],
          },
          ステータス: {
            status: { name: "未着手" },
          },
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ text: { content: text } }] },
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      const err = new Error(
        `Notion API error ${response.status}: ${errBody.slice(0, 200)}`,
      );
      try {
        appendAudit(
          buildAuditEntry({
            tool: "notion-create-pages",
            target_id: targetDbId,
            target_type: "data_source",
            action: "create",
            user_id: interaction.user.id,
            result: "error",
            error: err.message,
          }),
        );
      } catch (auditErr) {
        console.warn(
          "[handleTask] audit-log append failed:",
          auditErr instanceof Error ? auditErr.message : auditErr,
        );
      }
      throw err;
    }

    // Write 成功時のみ schema cache を invalidate (autoInvalidateOnWrite)。
    notifyNotionWrite("tasks");
    let createdPageId: string | undefined;
    try {
      const created = (await response.json()) as { id?: string };
      if (typeof created.id === "string" && created.id.length > 0) {
        createdPageId = created.id;
      }
    } catch (parseErr) {
      console.warn(
        "[handleTask] failed to parse Notion response for audit:",
        parseErr instanceof Error ? parseErr.message : parseErr,
      );
    }
    try {
      appendAudit(
        buildAuditEntry({
          tool: "notion-create-pages",
          target_id: createdPageId ?? targetDbId,
          target_type: createdPageId ? "page" : "data_source",
          action: "create",
          user_id: interaction.user.id,
          result: "ok",
        }),
      );
    } catch (auditErr) {
      console.warn(
        "[handleTask] audit-log append failed:",
        auditErr instanceof Error ? auditErr.message : auditErr,
      );
    }

    await interaction.reply({
      content: `✅ タスクを作成しました: ${text.slice(0, 100)}${text.length > 100 ? "..." : ""}`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.reply({
      content: `タスク作成失敗: ${msg}`,
      ephemeral: true,
    });
  }
}

const NEW_PROJECT_SYSTEM_PROMPT = `あなたはRHI（れるべち重工業）のプロジェクトマネージャーAIです。
新規案件のセットアップを対話的に進めてください。

## あなたの役割
ユーザーにヒアリングしながら、案件のタスク・スケジュール・担当を決定し、Notionに一括作成します。

## 利用するNotion DB（v3 統合 schema、Notion MCP経由）
- TaskTemplates DB (DS: {TEMPLATES_DS}) — 案件テンプレート定義
- Projects DB (DS: {{notion.projects}}) — 案件一覧 (v3 master)
- Tasks DB (DS: {{notion.tasks}}) — タスク一覧 (v3 master)
- Counterparties DB (DS: {{notion.counterparties}}) — 取引先 (旧「取引先 DB」、v3 では Counterparties に統合)

備考: 経理関連 (請求書・経費・領収書) は Accounting DB (DS: {{notion.accounting}}) の単一 DS に集約済。種別 select prop で income / expense / invoice_issued / invoice_received / receipt を区別する。新規案件作成では Accounting DB は直接触らない (発生時に経理 channel が記録)。

## セットアップフロー

### Step 1: テンプレート選択
TaskTemplates DB から全テンプレートを取得し、一覧を提示:
「どのタイプの案件ですか？」
1. 映像受託（工程型）— 漫画動画等、7工程、30日
2. イベント（日程型）— イベント撮影等、6工程、45日
3. 運営（継続型）— YouTube運営等、4工程、14日
4. 技術支援（タスク型）— 開発支援等、4工程、7日
5. 単発制作 — MV/イラスト等、4工程、21日
6. カスタム（手動でタスクを定義）

### Step 2: 詳細ヒアリング
選択されたテンプレートの情報を踏まえて、以下を順番に確認:
- **取引先**: 取引先DBから既存一覧を提示。なければ新規作成。
- **締切**: 「いつまでに完了？」（日付を聞く）
- **開始日**: 「いつから開始？」（デフォルト: 今日）
- **担当者**: 「アサインする人は？」（任意、後で設定可能）
- **優先度**: 最高/高/中/低
- **連絡ツール**: テンプレートのデフォルトを提示、変更可能
- **予算・請求**: テンプレートの請求サイクルを提示、金額があれば聞く

### Step 3: ワークロード分析と提案
**重要**: タスクスケジュールを提案する前に、必ず以下を実行:
1. Tasks DB から「未完了」の全タスクを取得
2. Projects DB から「進行中」の全案件を取得
3. 既存の負荷状況を分析（各週のタスク数、締切集中度）
4. テンプレートの工期比率（ratio）に基づいて期限を自動計算
5. 既存タスクとの競合を避けるよう調整

提案フォーマット:
\`\`\`
📋 新規案件セットアップ提案

【案件情報】
案件名: ○○
取引先: ○○
期間: YYYY/MM/DD 〜 YYYY/MM/DD
優先度: ○
請求: ○○

【タスクスケジュール】
1. ○○ — MM/DD〜MM/DD（担当: ○○）
2. ○○ — MM/DD〜MM/DD（担当: ○○）
...

【既存案件との負荷状況】
- 第N週: 既存タスクN件 + 新規N件 = 合計N件 ⚠️/✅
\`\`\`

### Step 4: 確認と実行
「この内容で作成しますか？」と確認。
ユーザーが「修正したい」と言えば該当箇所を変更。
ユーザーが「OK」「作成して」等と言えば:

1. **Projects DB** にレコード作成（案件名、ステータス=進行中、締切、優先度、カテゴリ、クライアント）
2. **Tasks DB** にタスクを一括作成（各タスクに案件リレーション、期限、工程、ステータス=未着手）
3. 結果を報告:「✅ 案件と{N}個のタスクを作成しました」

## 注意事項
- 日本語で対話
- 1ステップずつ質問する（一度に全部聞かない）
- テンプレートのタスク定義JSONの ratio フィールドを使って期限を自動配分
- 「カスタム」選択時はユーザーにタスクを自由に定義してもらう
- Notion作成はユーザーの最終確認後のみ実行
- Discord チャンネル作成は提案するが、実行はしない（管理者権限が必要なため）
`;

async function handleNewProject(
  interaction: ChatInputCommandInteraction,
  sessionManager: SessionManager,
): Promise<void> {
  const name = interaction.options.getString("name", true);
  const target = await deferAndPrepareTarget(interaction);

  // Clear existing session to start fresh with project setup prompt
  sessionManager.destroySession(interaction.channelId);

  const session = await sessionManager.create(
    interaction.channelId,
    interaction.user.id,
    { systemPrompt: resolveNotionIds(NEW_PROJECT_SYSTEM_PROMPT) },
  );

  await handleTurn(
    session,
    `新規案件「${name}」のセットアップを開始してください。まずテンプレート一覧をNotionから取得して提示してください。`,
    target,
  );
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

async function handleRefreshNotion(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    config.allowedUserIds &&
    !config.allowedUserIds.includes(interaction.user.id)
  ) {
    await interaction.reply({
      content: "権限がない。この操作は operator のみ。",
      ephemeral: true,
    });
    return;
  }
  invalidateNotionCache();
  await interaction.reply({
    content:
      "Notion DB schema キャッシュを invalidate した。次 persona セッションで再取得される。",
    ephemeral: true,
  });
}
