# RHI Assistant — Discord Claude Bot

Discord からローカルの Claude Code CLI を操作する Bot です。StructuredIO（NDJSON）プロトコル経由でスラッシュコマンドやメッセージから Claude Code へ質問・コード実行・業務管理を行えます。

## 主な機能

この Bot ができることは次の 3 つです。

1. **会話履歴の取得** — Discord MCP Server (stdio、REST API のみ) が、サーバー・チャンネルの一覧とメッセージ履歴の読み出し・検索を Claude Code に提供する
2. **AI とのやり取り** — メッセージ (メンション / auto チャンネル / DM) や `/ask`・`/code` で Claude Code に話しかけ、応答をストリーミングで返す。`-p` + `--resume` 方式でセッション継続、チャンネル別の system prompt、画像添付、persona モード (任意) に対応
3. **スラッシュコマンドでの session 起動・停止** — `/claude` で独立した Claude Code セッションをバックグラウンド起動し、`/claude-list` で一覧、`/claude-exit` で終了する

## セットアップ

### Bot の作成（Discord Developer Portal）

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** → アプリ名（例: `RHI Assistant`）を入力。
2. 左メニュー **Bot** → **Add Bot** → **Reset Token** で Bot Token を取得（`.env` の `DISCORD_BOT_TOKEN` に設定。**絶対に公開しない**）。
3. 同画面の **Privileged Gateway Intents** で以下を ON にする:
   - **Message Content Intent** — メッセージ本文の読み取りに必要
   - **Server Members Intent** — Bot が常に要求するため必要（OFF だとログインが拒否される）。persona モードのメンバー一覧取得にも使う
   - **Presence Intent** — Bot が常に要求するため必要（OFF だとログインが拒否される）
4. 左メニュー **OAuth2 → URL Generator**:
   - **Scopes**: `bot` + `applications.commands`（スラッシュコマンド登録用）
   - **Bot Permissions**（必要最小限）: `View Channels` / `Send Messages` / `Send Messages in Threads` / `Embed Links` / `Attach Files` / `Read Message History` / `Add Reactions` / `Use External Emojis` / `Manage Threads`（thread 作成に必要）
   - 下部に生成される URL をブラウザで開き、Bot を導入したいサーバーへ招待。
5. サーバー側で Bot 用の専用ロール（例: `RHI Bot`）を作り、上記権限と動作チャンネルへのアクセスを付与すると運用しやすい。

> **トークン漏洩時**: Developer Portal → Bot → **Reset Token** で再発行 → `.env` 更新 → daemon 再起動（`nssm restart rhi-discord-bot` 等）。**漏洩したトークンは即無効化される**ので、リポジトリへの commit やログ出力は厳禁。

### 前提条件

- Node.js（v18 以上）
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) インストール済み（Max Plan 推奨）
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications)）

### インストール

```bash
git clone https://github.com/your-org/rhi-discord-bot.git
cd rhi-discord-bot
npm install
```

### 初回セットアップ（チェックリスト）

```bash
# 1. 設定ファイルの作成
cp .env.example .env                                          # 環境変数
cp config/channels.example.json config/channels.json                  # チャンネル応答モード

# 2. .env を編集して必須値を設定（少なくとも DISCORD_BOT_TOKEN）

# 3. channels.json に自分のチャンネル ID を記入

# 4. ビルド＆テスト
npm run build
npm test

# 5. Bot 起動
npm start

```

### 設定ファイル

#### 環境変数

`.env.example` をコピーして `.env` を作成し、値を設定してください。

```bash
cp .env.example .env
```

| 変数名                                      |           必須            | デフォルト                                                           | 説明                                                                                                                                                                |
| ------------------------------------------- | :-----------------------: | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_BOT_TOKEN`                         |            Yes            | —                                                                    | Discord Bot トークン                                                                                                                                                |
| `CLAUDE_CLI_PATH`                           |             —             | `claude`                                                             | Claude CLI の実行パス。未設定なら PATH 上の `claude` シムを自動解決 (Windows は `.cmd` をパースして `bin/claude.exe` / `cli-wrapper.cjs` / `cli.js` を存在順に選択) |
| `CLAUDE_CLI_SCRIPT`                         |             —             | —                                                                    | 明示 override (特定 `.exe` / `.cjs` / `.js` に pin したい場合のみ)。通常は空でよい                                                                                  |
| `DEFAULT_WORKING_DIR`                       |             —             | `process.cwd()`                                                      | Claude CLI の作業ディレクトリ                                                                                                                                       |
| `SESSION_IDLE_TIMEOUT_MS`                   |             —             | `1800000`                                                            | セッションアイドルタイムアウト（30 分）                                                                                                                             |
| `MAX_CONCURRENT_SESSIONS`                   |             —             | `5`                                                                  | 最大同時セッション数                                                                                                                                                |
| `PERMISSION_MODE`                           |             —             | `auto`                                                               | 権限モード（auto / prompt / deny）                                                                                                                                  |
| `ALLOWED_WORKING_DIRS`                      |             —             | `.`                                                                  | 許可する作業ディレクトリ                                                                                                                                            |
| `ALLOWED_USER_IDS`                          |             —             | —                                                                    | 許可ユーザー ID（カンマ区切り）                                                                                                                                     |
| `DNS_SERVERS`                               |             —             | `8.8.8.8,8.8.4.4`                                                    | DNS サーバー（カンマ区切り）                                                                                                                                        |
| `LOG_LEVEL`                                 |             —             | `INFO`                                                               | ログレベル（DEBUG / INFO / WARN / ERROR）                                                                                                                           |
| `NOTION_API_KEY`                            |             —             | —                                                                    | persona モードで Notion DB の schema を最初のメッセージに添える場合の Integration Token（任意） |
| `NOTION_IDS_PATH`                           |             —             | `config/notion-ids.json`                                             | Notion の DB 一覧ファイルのパス override（相対パスは `process.cwd()` 基準） |
| `MCP_ALLOWED_GUILD_IDS`                     |             —             | —                                                                    | Bot 操作対象 guild の allowlist。未設定は全 guild 許可                                                                                                              |
| `PEER_BOT_IDS`                              |             —             | —                                                                    | 「peer bot」として `bot` filter を通すユーザー ID（カンマ区切り）                                                                                                   |
| `BOT_PERSONA`                               |             —             | —                                                                    | この Bot インスタンスが演じる persona。`persona.config.json`（`persona.config.example.json` をコピー）の `name` と一致させる。未設定で persona pipeline 無効        |
| `RHI_PERSONA_CONFIG`                        |             —             | `persona.config.json`                                                | persona 定義ファイルのパス override                                                                                                                                 |
| `MAX_AI_TURNS_PER_CONVERSATION`             |             —             | `40`                                                                 | 同一会話での persona session 自動 kill 閾値                                                                                                                         |
| `PERSONA_DISCORD`                           |             —             | `1`                                                                  | `0` で persona Discord pipeline を無効化                                                                                                                            |
| `USE_AGENT_SDK`                             |             —             | `false`                                                              | Claude Agent SDK 経路を使うか                                                                                                                                       |
| `CLAUDE_MODEL`                              |             —             | `claude-sonnet-4-6`                                                  | Claude session の既定モデル                                                                                                                                         |
| `CLAUDE_SUBPROCESS_TIMEOUT_MS`              |             —             | `1800000`                                                            | Claude CLI subprocess の hard timeout (30 分)                                                                                                                       |
| `OPENROUTER_API_KEY` / `ANTHROPIC_BASE_URL` |             —             | —                                                                    | モデル切り替え実験用の base URL / 鍵 override                                                                                                                       |

#### Notion（任意、persona モードのみ）

persona モードは、`config/notion-ids.json`（`config/notion-ids.example.json` をコピー）と `NOTION_API_KEY` が設定されていれば、そこに書かれた Notion DB の schema を会話の最初のメッセージに添えます。どちらも未設定なら何もしません。

- 読み込み先は 2 つで決まります。どのワークスペースかは `NOTION_API_KEY`、どの DB かは DB 一覧のファイルです。
- DB 一覧は `{ "キー名": "DB の ID" }` の JSON です。キー名は自由で、その名前が schema の見出しになります。
- 別の一覧を使うときは `NOTION_IDS_PATH` にファイルのパスを書きます（例: 個人用と会社用で `.env` を分ける）。相対パスは Bot を起動したディレクトリ（`process.cwd()`）が基準なので、絶対パスで書くのが確実です。

### ビルドと起動

```bash
# ビルド
npm run build

# テスト
npm test

# Bot 起動（Gateway + スラッシュコマンド + メッセージ処理）
npm start

# または一括起動（Windows）
./start-all.bat
```

MCP Standalone サーバーは Claude Code が `~/.claude.json` の登録情報をもとに自動起動します。

## Discord スラッシュコマンド（8 個）

| コマンド              | 説明                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `/ask <prompt>`       | 質問・相談（汎用）                                                 |
| `/code <prompt>`      | コード実行（`working_dir` は `ALLOWED_WORKING_DIRS` の配下のみ）   |
| `/clear`              | このチャンネルのセッションを破棄                                   |
| `/status`             | セッション状態の確認                                               |
| `/help`               | コマンド一覧                                                       |
| `/claude [name] [cwd]` | 独立した Claude Code セッションをバックグラウンド起動              |
| `/claude-list`        | registry セッションと cse_session を一覧表示（Windows 専用）       |
| `/claude-exit [pid]`  | Claude セッションを終了（pid 指定で個別 kill、Windows 専用）       |

## MCP ツール（4 ツール）

`dist/mcp-standalone.js` を stdio の MCP server として Claude Code に登録すると、次のツールで会話履歴を読める。Gateway には接続せず、bot token で REST API だけを使う。`MCP_ALLOWED_GUILD_IDS` を設定すると、読めるサーバーをその一覧に限る。

| ツール                    | 説明                                                       |
| ------------------------- | ---------------------------------------------------------- |
| `discord_list_guilds`     | Bot が参加しているサーバーの一覧                           |
| `discord_list_channels`   | サーバーのチャンネル一覧                                   |
| `discord_read_messages`   | チャンネルのメッセージ履歴を読む                           |
| `discord_search_messages` | チャンネルの直近のメッセージをキーワードで検索             |

## チャンネル応答モード

`config/channels.json` でチャンネルごとの応答モードと systemPrompt を設定。

| モード    | 動作               | 使用チャンネル例                       |
| --------- | ------------------ | -------------------------------------- |
| `auto`    | 全メッセージに応答 | #ai_chat                               |
| `mention` | @メンション時のみ  | #ask（未設定のチャンネルの既定）       |
| `none`    | 応答しない         | #general                               |

## テスト

```bash
# テスト実行
npm test

# ウォッチモード
npx vitest
```

テストは `src/**/__tests__/` 配下に配置。vitest を使用。

## 技術スタック

| 技術                           | バージョン / 詳細                                         |
| ------------------------------ | --------------------------------------------------------- |
| TypeScript                     | ES2022, Node16 モジュール                                 |
| discord.js                     | v14                                                       |
| @modelcontextprotocol/sdk      | v1.29.0 (**exact pin** + `overrides` で transitive dedup) |
| @anthropic-ai/claude-agent-sdk | Claude Code セッション制御                                |
| zod                            | スキーマバリデーション                                    |
| vitest                         | ユニットテスト                                            |
| Claude CLI                     | `claude -p`（StructuredIO stream-json）                   |

## プロジェクト構造

```
discord-claude-bot/
├── src/
│   ├── index.ts              # メインエントリ（Gateway Bot）
│   ├── mcp-standalone.ts     # MCP Standalone エントリ（REST-only）
│   ├── dns-fix.ts            # IPv6 DNS タイムアウト対策
│   ├── config.ts             # 環境変数・チャンネル設定・外部設定ファイル読込
│   ├── logger.ts             # 構造化 JSON ロガー
│   ├── types.ts              # StructuredIO NDJSON 型定義
│   ├── claude/               # Claude CLI 連携
│   │   └── __tests__/        # ユニットテスト
│   ├── discord/              # Discord 連携（コマンド・ハンドラ・画像添付）
│   ├── claude-bridge/        # /claude・/claude-list・/claude-exit（起動・一覧・終了）
│   ├── personas/             # persona モード（任意）
│   ├── session/              # セッション管理・同時実行制限
│   │   └── __tests__/        # ユニットテスト
│   ├── response/             # 応答フォーマッタ・ストリーミング
│   │   └── __tests__/        # ユニットテスト
│   └── mcp/                  # MCP Server（4 ツール、stdio）
│       ├── server.ts         # createMcpServer() factory（tool 登録）
│       └── tools/
│           ├── messages.ts   # メッセージ履歴の読み出し
│           ├── channels.ts   # チャンネル一覧
│           └── guilds.ts     # サーバー一覧・メッセージ検索
├── config/
│   ├── channels.example.json            # チャンネル別設定テンプレート
│   └── notion-ids.example.json          # Notion DB ID テンプレート
├── docs/
│   ├── plans/                # 設計メモ（claude-list / kill、SDK 移行）
│   └── specs/                # 仕様（claude-list / kill）
├── .github/workflows/
│   └── ci.yml                # GitHub Actions CI（ビルド + テスト）
├── vitest.config.ts          # テスト設定
├── package.json
└── tsconfig.json
```
