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
      name: "help",
      description: "コマンド一覧とBotの使い方を表示",
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
  ];

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[discord] Slash commands registered globally");
}
