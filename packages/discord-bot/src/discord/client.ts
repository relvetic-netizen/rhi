import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { config } from "../config.js";

export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildScheduledEvents,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
}

export async function registerCommands(clientId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discordBotToken);

  const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
    {
      name: "ask",
      description: "Send a question to Claude Code",
      options: [
        {
          name: "prompt",
          description: "Your question",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "code",
      description: "Send a coding request to Claude Code (tools enabled)",
      options: [
        {
          name: "prompt",
          description: "Your coding request",
          type: 3, // STRING
          required: true,
        },
        {
          name: "working_dir",
          description: "Working directory path",
          type: 3, // STRING
          required: false,
        },
      ],
    },
    {
      name: "clear",
      description: "Reset this channel's in-memory conversation context",
    },
    {
      name: "status",
      description: "Show current session status",
    },
    {
      name: "project",
      description: "案件ステータス確認・更新",
      options: [
        {
          name: "name",
          description: "案件名（部分一致）",
          type: 3, // STRING
          required: true,
          choices: [
            { name: "イルカ", value: "イルカ" },
            { name: "フーモア", value: "フーモア" },
            { name: "アップランド", value: "アップランド" },
            { name: "Kai コミック", value: "Kai様" },
            { name: "CryptoHiroba", value: "CryptoHiroba" },
            { name: "ポケットライブ", value: "ポケットライブ" },
            { name: "浜田 MV", value: "浜田様" },
            { name: "小説", value: "ライトノベル" },
            { name: "暗号資産", value: "暗号資産" },
            { name: "民泊", value: "民泊" },
          ],
        },
      ],
    },
    {
      name: "deadline",
      description: "全案件の締切一覧を表示",
    },
    {
      name: "task",
      description: "Notionにタスクを作成（AI処理なし）",
      options: [
        {
          name: "text",
          description: "タスク内容",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "week",
      description: "週次レビューを手動実行",
    },
    {
      name: "newproject",
      description: "新規案件セットアップ（対話型）",
      options: [
        {
          name: "name",
          description: "案件名",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "help",
      description: "コマンド一覧とBotの使い方を表示",
    },
    {
      name: "pc",
      description: "PC遠隔操作（スクリーンショット・マウス・キーボード）",
      options: [
        {
          name: "action",
          description: "操作内容（screenshot / ss / 自然言語で操作指示）",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "invoice",
      description: "請求書の発行・確認・売上サマリー",
      options: [
        {
          name: "action",
          description: "操作",
          type: 3, // STRING
          required: true,
          choices: [
            { name: "未入金一覧", value: "unpaid" },
            { name: "今月の発行分", value: "monthly" },
            { name: "売上サマリー", value: "summary" },
          ],
        },
      ],
    },
    {
      name: "expense",
      description: "経費の確認・集計",
      options: [
        {
          name: "action",
          description: "操作",
          type: 3, // STRING
          required: true,
          choices: [
            { name: "今月の経費一覧", value: "monthly" },
            { name: "カテゴリ別集計", value: "by_category" },
            { name: "確定申告用集計", value: "tax" },
          ],
        },
      ],
    },
    {
      name: "received",
      description: "受領請求書の確認",
      options: [
        {
          name: "action",
          description: "操作",
          type: 3, // STRING
          required: true,
          choices: [
            { name: "未払い一覧", value: "unpaid" },
            { name: "今月の受領分", value: "monthly" },
          ],
        },
      ],
    },
    {
      name: "claude",
      description: "独立した Claude Code セッションをバックグラウンド起動（Remote Control 向け）",
      options: [
        {
          name: "name",
          description: "セッション名（省略時は自動連番）",
          type: 3, // STRING
          required: false,
        },
        {
          name: "cwd",
          description: "作業ディレクトリ（省略時はホーム ~/ ）",
          type: 3, // STRING
          required: false,
        },
      ],
    },
    {
      name: "claude-list",
      description: "registry セッションと cse_session を一覧表示",
    },
    {
      name: "claude-exit",
      description: "Claude セッションを終了（pid 指定で個別 kill、無指定で registry+cse 全 kill）",
      options: [
        {
          name: "pid",
          description: "終了する PID（省略時は registry と cse_session を全 kill）",
          type: 4, // INTEGER
          required: false,
        },
      ],
    },
    {
      name: "refresh-notion",
      description: "Notion DB schema キャッシュを invalidate して次セッションで再取得する",
    },
  ];

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[discord] Slash commands registered globally");
}
