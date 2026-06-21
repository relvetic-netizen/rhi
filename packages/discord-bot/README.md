# RHI Assistant — Discord Claude Bot

Discord からローカルの Claude Code CLI を操作する Bot です。StructuredIO（NDJSON）プロトコル経由でスラッシュコマンドやメッセージから Claude Code へ質問・コード実行・業務管理を行えます。

## 主な機能

- **Claude Code 連携** — `-p` + `--resume` 方式でセッション継続、`--append-system-prompt` でチャンネル別コンテキスト注入
- **チャンネル別応答モード** — auto / mention / none をチャンネルごとに設定（16チャンネル対応）
- **セッション管理** — チャンネル×ユーザー単位、アイドルタイムアウト付き
- **請求書・経費管理** — #経理チャンネルで自然言語操作、PDF/Excel請求書生成、Mailgun送信
- **Notion 連携** — 案件管理、タスク管理、請求書/経費/取引先 DB、日報自動生成、Formula 自動計算
- **Google Calendar / Gmail 連携** — 朝ブリーフィング、週次レビュー
- **画像添付対応** — Claude Vision による OCR（請求書/レシート自動解析）
- **ブラウザ自動操作** — agent-browser MCP ツールによる Web 操作（Chatwork / Telegram 等）
- **Gemini 委任** — MCP ツール経由で Gemini 3.1 Pro にタスク委任（コードレビュー・Web 調査・分析）
- **Discord MCP Server** — REST API のみで動作する 43 ツール（Discord 29 + Gemini 3 + Browser 11）。stdio に加え HTTP 経由 (feature flag) でも外部 AI から呼び出し可能
- **スケジュール実行** — Windows Task Scheduler による 9 定期タスク（共通ラッパーでログ・失敗通知対応）
- **CI/CD** — GitHub Actions による自動ビルド・テスト
- **24/7 サーバーデプロイ** — NSSM サービス化、Remote Control、コンテキスト警告

## 24/7 サーバー

Windows マシン上で常時稼働させる構成例（NSSM サービス化）。

### NSSM サービス

| サービス             | 内容                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `rhi-discord-bot`    | Discord Bot（`node dist/index.js`）、自動起動・自動再起動                                 |
| `rhi-remote-control` | Claude Code Remote Control（`claude remote-control --permission-mode bypassPermissions`） |

Remote Control により、スマホ / ブラウザから [claude.ai/code](https://claude.ai/code) 経由でサーバー上の Claude Code を操作可能。

### コンテキスト使用量警告

Claude Code セッションのコンテキスト使用率が 35% を超えると、#通知センター に Discord 通知を自動送信。
Remote Control 経由の操作中でもスマホで確認できる。

- `~/.claude/statusline.js` — 毎ターン、コンテキスト使用率をファイルに記録
- `~/.claude/scripts/context-warning.js` — Stop フックで 35% 超過時��� Discord API 経由で通知（5 分クールダウン）

### デプロイ手順

```bash
# サーバーに SSH 接続
ssh -i ~/.ssh/id_server you@your-host

# クローン・ビルド
cd ~/workspace/projects
git clone https://github.com/your-org/rhi-discord-bot.git
cd rhi-discord-bot && npm install && npm run build

# .env をメインPC からコピーし、パスをサーバー用に修正
# config/notion-ids.json も SCP でコピー

# NSSM でサービス登録
nssm install rhi-discord-bot <node-path> dist/index.js
nssm set rhi-discord-bot AppDirectory <bot-dir>
nssm set rhi-discord-bot ObjectName .\you <password>
nssm start rhi-discord-bot

# スケジュールタスク登録
powershell -ExecutionPolicy Bypass -File schedules/register-tasks.ps1
```

## セットアップ

### Bot の作成（Discord Developer Portal）

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application** → アプリ名（例: `RHI Assistant`）を入力。
2. 左メニュー **Bot** → **Add Bot** → **Reset Token** で Bot Token を取得（`.env` の `DISCORD_BOT_TOKEN` に設定。**絶対に公開しない**）。
3. 同画面の **Privileged Gateway Intents** で以下を ON にする:
   - **Message Content Intent** — メッセージ本文の読み取りに必要
   - **Server Members Intent** — `discord_list_members` / 権限同期で必要
   - **Presence Intent** — `discord_get_presence` を使う場合のみ
4. 左メニュー **OAuth2 → URL Generator**:
   - **Scopes**: `bot` + `applications.commands`（スラッシュコマンド登録用）
   - **Bot Permissions**（必要最小限）: `View Channels` / `Send Messages` / `Send Messages in Threads` / `Embed Links` / `Attach Files` / `Read Message History` / `Add Reactions` / `Use External Emojis` / `Manage Messages`（pin / delete に必要）/ `Manage Threads`（thread 作成に必要）/ `Manage Channels`（`discord_create_channel` / `set_channel_topic` 等に必要、不要なら外す）/ `Manage Roles`（`discord_manage_role` に必要、不要なら外す）
   - 下部に生成される URL をブラウザで開き、Bot を導入したいサーバーへ招待。
5. サーバー側で Bot 用の専用ロール（例: `RHI Bot`）を作り、上記権限と動作チャンネルへのアクセスを付与すると運用しやすい。

> **トークン漏洩時**: Developer Portal → Bot → **Reset Token** で再発行 → `.env` 更新 → daemon 再起動（`nssm restart rhi-discord-bot` 等）。**漏洩したトークンは即無効化される**ので、リポジトリへの commit やログ出力は厳禁。

### 前提条件

- Node.js（v18 以上）
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) インストール済み（Max Plan 推奨）
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications)）
- Google Chrome（PDF 生成に使用、パスは環境変数で設定可能）
- [agent-browser](https://github.com/vercel-labs/agent-browser)（ブラウザ自動操作に使用、任意）

### インストール

```bash
git clone https://github.com/your-org/rhi-discord-bot.git
cd rhi-discord-bot
npm install

# ブラウザ自動操作を使用する場合
npm install -g agent-browser
agent-browser install
```

### 初回セットアップ（チェックリスト）

```bash
# 1. 設定ファイルの作成
cp .env.example .env                                          # 環境変数
cp config/channels.example.json config/channels.json                  # チャンネル応答モード
cp config/notion-ids.example.json config/notion-ids.json              # Notion DB ID（請求書機能を使う場合）
cp config/invoice-defaults.example.json config/invoice-defaults.json  # 請求書発行者情報（同上）
cp config/protected-rows.example.json config/protected-rows.json      # 保護行（任意）

# 2. .env を編集して必須値を設定（少なくとも DISCORD_BOT_TOKEN）

# 3. channels.json / notion-ids.json に自分のチャンネル ID / Notion REST API ID を記入（取得方法は下記参照）

# 4. ビルド＆テスト
npm run build
npm test

# 5. Bot 起動
npm start

# 6. (Windows) スケジュールタスクの登録（管理者権限で実行）
powershell -ExecutionPolicy Bypass -File schedules/register-tasks.ps1

# 7. (Windows) 旧タスクが残っている場合は削除
Unregister-ScheduledTask -TaskName "RHI-PaymentAlert" -Confirm:$false
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
| `CHROME_EXECUTABLE_PATH`                    |             —             | 自動検出                                                             | Chrome 実行パス（PDF生成用）                                                                                                                                        |
| `CHROME_NO_SANDBOX`                         |             —             | `false`                                                              | Chrome sandbox 無効化（Linux root 用）                                                                                                                              |
| `INVOICE_OUTPUT_DIR`                        |             —             | —                                                                    | 請求書 PDF 出力先ディレクトリ                                                                                                                                       |
| `FUMOAR_TEMPLATE_PATH`                      |             —             | —                                                                    | フーモア Excel テンプレートパス                                                                                                                                     |
| `AGENT_BROWSER_PATH`                        |             —             | `agent-browser`                                                      | agent-browser CLI パス                                                                                                                                              |
| `AGENT_BROWSER_TIMEOUT_MS`                  |             —             | `30000`                                                              | ブラウザ操作タイムアウト（ms）                                                                                                                                      |
| `DNS_SERVERS`                               |             —             | `8.8.8.8,8.8.4.4`                                                    | DNS サーバー（カンマ区切り）                                                                                                                                        |
| `LOG_LEVEL`                                 |             —             | `INFO`                                                               | ログレベル（DEBUG / INFO / WARN / ERROR）                                                                                                                           |
| `NOTION_API_KEY`                            |             —             | —                                                                    | Notion Internal Integration Token（`/task` コマンド用）                                                                                                             |
| `MAILGUN_API_KEY`                           |             —             | —                                                                    | Mailgun API Key（請求書メール送信用）                                                                                                                               |
| `MAILGUN_DOMAIN`                            |             —             | `example.com`                                                        | Mailgun 送信ドメイン                                                                                                                                                |
| `GEMINI_CLI_PATH`                           |             —             | `gemini`                                                             | Gemini CLI の実行パス                                                                                                                                               |
| `GEMINI_MODEL`                              |             —             | `gemini-3.1-pro`                                                     | Gemini モデル                                                                                                                                                       |
| `GEMINI_TIMEOUT_MS`                         |             —             | `120000`                                                             | Gemini タイムアウト（ms）                                                                                                                                           |
| `DISCORD_WEBHOOK_ERROR_URL`                 |             —             | —                                                                    | スケジュール失敗時の Discord Webhook 通知先                                                                                                                         |
| `MCP_HTTP_ENABLE`                           |             —             | `false`                                                              | HTTP MCP transport の master switch。`true` で `MCP_API_KEY` が必須                                                                                                 |
| `MCP_HTTP_PORT`                             |             —             | `7800`                                                               | HTTP MCP の listen port                                                                                                                                             |
| `MCP_BIND`                                  |             —             | `127.0.0.1`                                                          | HTTP MCP の bind address。`0.0.0.0` への変更は [Security Runbook](#security-runbook) のチェックリスト参照                                                           |
| `MCP_API_KEY`                               | If `MCP_HTTP_ENABLE=true` | —                                                                    | Bearer auth shared secret。`openssl rand -hex 32` で生成、**絶対に commit しない**                                                                                  |
| `MCP_ALLOWED_HOSTS`                         |             —             | `localhost,127.0.0.1`                                                | DNS rebinding 防御。`0.0.0.0` bind 時は LAN IP / ホスト名を追加                                                                                                     |
| `MCP_HTTP_TOOL_DENYLIST`                    |             —             | `browser_eval,browser_open,browser_fill,gemini_review,gemini_search` | HTTP 経由で露出しないツール（stdio には影響なし）                                                                                                                   |
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

#### 機密情報設定ファイル

請求書発行者情報と Notion DB ID は環境変数ではなく設定ファイルで管理します（`.gitignore` 対象）。

```bash
# テンプレートからコピーして値を設定
cp config/invoice-defaults.example.json config/invoice-defaults.json
cp config/notion-ids.example.json config/notion-ids.json
```

- `config/invoice-defaults.json` — 発行者情報（屋号・住所・口座）
- `config/notion-ids.json` — Notion データベース ID マッピング（REST API ID）

#### Notion データベース ID の取得

`config/notion-ids.json` には各 Notion データベースの **REST API ID** を設定します。
Notion Internal Integration を作成し、対象ワークスペースに接続した上で、以下のコマンドで取得できます。

```bash
# Integration Token を使って全データベースを一覧取得
curl -s -X POST 'https://api.notion.com/v1/search' \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H 'Notion-Version: 2022-06-28' \
  -H 'Content-Type: application/json' \
  -d '{"filter":{"property":"object","value":"database"}}' | python3 -m json.tool
```

| キー             | 対応する Notion DB                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `projects`       | Projects（案件一覧、v3 Master DB）                                                                            |
| `tasks`          | Tasks（タスク一覧、v3 Master DB）                                                                             |
| `accounting`     | Accounting（v3 Master DB、種別 enum `income`/`expense`/`invoice_issued`/`invoice_received`/`receipt` で区別） |
| `counterparties` | Counterparties（取引先、v3 Master DB）                                                                        |
| `resources`      | Resources（テンプレート / 外部リンク、v3 Master DB）                                                          |
| `atomicNotes`    | Atomic Notes（Knowledge Base 配下）                                                                           |
| `dailyReport`    | 日報（Knowledge Base 配下）                                                                                   |
| `businessInfo`   | 事業者情報（ページ ID）                                                                                       |

プロンプト内の DS ID は `{{notion.<キー>}}` プレースホルダで記述され、起動時に `config/notion-ids.json` の値へ解決されます（実装は `resolveNotionIds()`）。

> **Notion 連携は任意です。** `config/notion-ids.json` を作成しない（または一部キーを空のままにする）場合でも Bot は起動します。未設定の DB を参照する機能（`/new-project`・経理コマンド等）は無効化され、起動時に `[config] Notion DB "<キー>" is not configured ...` という警告が 1 行出ます。Notion 機能を使う場合のみ、上記手順で ID を設定してください。

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

## Discord スラッシュコマンド（14 個）

### 汎用

| コマンド  | 説明                   | オプション                              |
| --------- | ---------------------- | --------------------------------------- |
| `/ask`    | Claude Code に質問     | `prompt`（必須）                        |
| `/code`   | コーディングリクエスト | `prompt`（必須）, `working_dir`（任意） |
| `/clear`  | セッションクリア       | —                                       |
| `/status` | セッション状態表示     | —                                       |
| `/help`   | コマンド一覧表示       | —                                       |

### 案件管理

| コマンド    | 説明                 | オプション                     |
| ----------- | -------------------- | ------------------------------ |
| `/project`  | 案件ステータス確認   | `name`（必須・選択式 10 案件） |
| `/deadline` | 全案件の締切一覧     | —                              |
| `/task`     | Notion にタスク作成  | `text`（必須）                 |
| `/week`     | 週次レビュー手動実行 | —                              |

### 経理

| コマンド    | 説明                     | オプション                              |
| ----------- | ------------------------ | --------------------------------------- |
| `/invoice`  | 請求書一覧・売上サマリー | `action`（unpaid / monthly / summary）  |
| `/expense`  | 経費一覧・カテゴリ集計   | `action`（monthly / by_category / tax） |
| `/received` | 受領請求書の確認         | `action`（unpaid / monthly）            |

### ツール

| コマンド | 説明                             | オプション       |
| -------- | -------------------------------- | ---------------- |
| `/pc`    | ブラウザ操作・スクリーンショット | `action`（必須） |

## 請求書・経費管理システム

### #経理チャンネル（自然言語操作）

```
「アップランドに4月分の請求書を作成、5万円、4/30期限」  → PDF生成 + Notion登録
「送信して」                                            → Mailgun でメール送信
「フーモアに請求書を作成」                               → Excel テンプレート生成
「example-client から9万円の請求書きた」                  → 受領請求書 Notion 登録
（画像添付）                                            → OCR → 自動登録
「example-client への支払い完了」                         → 支払済み + 経費DB自動作成
「今月の売上は？」「確定申告用の経費一覧」                → Notion 集計
```

### Notion データベース

| DB         | 用途                                             | 自動計算（Formula）          |
| ---------- | ------------------------------------------------ | ---------------------------- |
| Projects   | 案件一覧・ステータス・締切・アサイン管理         | —                            |
| Tasks      | タスク管理（工程・工数・担当・案件リレーション） | 残り日数、緊急度（🔴🟡🟠🟢） |
| 発行請求書 | クライアントへ送る請求書管理                     | 入金遅延日数                 |
| 受領請求書 | 外注先から届く請求書管理（→案件リレーション）    | —                            |
| 経費       | 事業経費の記録（確定申告用）                     | 会計年月（YYYY-MM）          |
| 取引先     | クライアント・外注先の連絡先                     | —                            |
| 日報       | 日次活動レポート（自動生成、完了タスク数付き）   | —                            |
| 事業者情報 | PDF 請求書ヘッダー用（屋号・住所・口座）         | —                            |

> **ビュー設定**: 各 DB のビュー（Board / Calendar / Gallery 等）は [`docs/notion-view-setup.md`](docs/notion-view-setup.md) を参照してください。

### 請求書生成

- **通常**（PDF）: HTML テンプレート → puppeteer-core → A4 PDF（源泉徴収 10.21% 対応）
- **フーモア専用**（Excel）: 指定テンプレートにセル書き込み
- 保存先: 環境変数 `INVOICE_OUTPUT_DIR` で指定

### メール送信

- Mailgun API（送信元: `invoice@example.com`）
- PDF / Excel 添付対応
- 定型ビジネスメールテンプレート内蔵

## スケジュールタスク（9 つ）

Windows Task Scheduler + `claude -p --dangerously-skip-permissions` で実行。

| タスク                      | 頻度             | 内容                                                         |
| --------------------------- | ---------------- | ------------------------------------------------------------ |
| RHI-TaskDeadlineReminder    | 平日 09:30       | 当日期限タスクを各案件チャンネルに個別通知                   |
| RHI-PaymentFollowup         | 月曜 09:00       | 未入金フォローアップ＋リマインドメール文面生成 → #経理       |
| RHI-MorningBrief            | 月–土 10:00      | 朝ブリーフィング（予定・締切・タスク・メール・請求アラート） |
| RHI-MidweekHealthCheck      | 水曜 10:00       | 週半ば健全性チェック＋Gemini 優先度分析 → #案件管理          |
| RHI-DailyReport             | 毎日 21:00       | 日報 → Notion + #通知センター（重複ガード・タスク進捗付き）  |
| RHI-WeeklyReview            | 日曜 20:00       | 週次レビュー（日報ふりかえり・タスク週報・Gemini 分析付き）  |
| RHI-PermissionSync          | 日曜 21:00       | Notion → Discord 権限同期                                    |
| RHI-MonthlyInvoiceReminder  | 毎月 25 日 10:00 | 未発行請求書リマインダー → #経理                             |
| RHI-MonthlyFinancialSummary | 毎月 1 日 11:00  | 月次経理サマリー → #経理                                     |

> **変更履歴**: RHI-PaymentAlert は RHI-MorningBrief に統合されました（重複 DB フェッチの解消）。
> 旧タスクが残っている場合は `Unregister-ScheduledTask -TaskName "RHI-PaymentAlert"` で削除してください。

### スケジュール登録・更新

```powershell
# 管理者権限で実行
powershell -ExecutionPolicy Bypass -File schedules/register-tasks.ps1

# 旧 PaymentAlert タスクの削除（初回のみ）
Unregister-ScheduledTask -TaskName "RHI-PaymentAlert" -Confirm:$false
```

### スケジュール実行モニタリング

`scripts/schedule-runner.ps1` を共通ラッパーとして使うと、以下の機能が有効になります:

- **ログ蓄積**: `logs/schedule-{TaskName}-{timestamp}.log` に実行結果・所要時間を記録
- **失敗通知**: `DISCORD_WEBHOOK_ERROR_URL` 設定時、失敗タスクを Discord に自動通知
- **自動ローテーション**: 30 日以上のログファイルを自動削除

```powershell
# schedule-runner.ps1 経由の実行例（.bat から呼び出す場合）
powershell -ExecutionPolicy Bypass -File scripts/schedule-runner.ps1 ^
  -TaskName "MorningBrief" ^
  -ScheduleFile "schedules/morning-brief.md" ^
  -Model "haiku" ^
  -EnsureChrome
```

### コスト最適化

スケジュールタスクは用途に応じてモデルを使い分けます:

| モデル   | 対象タスク                                                                                              | 用途                           |
| -------- | ------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `haiku`  | MorningBrief, DailyReport, PermissionSync, MonthlyInvoice, TaskDeadline, PaymentFollowup, MidweekHealth | データ収集・集計（コスト重視） |
| `sonnet` | WeeklyReview, MonthlyFinancial                                                                          | 分析・サマリー生成（精度重視） |

## MCP ツール（43 ツール）

REST API のみで動作する Discord 操作ツール群 + Gemini 委任 + ブラウザ自動操作。Gateway 接続不要。
stdio（標準入出力）と HTTP（feature flag、後述）の 2 transport から呼び出せる。

ツール名は MCP 上の正準名（コードベース上の `safeTool(...)` 第 2 引数）に揃えてある。

| カテゴリ                 | ツール (HTTP 経由で `⛔` のものは [denylist](#mcp-http-server-feature-flag) で既定不可)                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **メッセージ (6)**       | `discord_send_message`, `discord_read_messages`, `discord_edit_message`, `discord_delete_message`, `discord_react`, `discord_await_reaction`                                                                                |
| **チャンネル (8)**       | `discord_list_channels`, `discord_get_channel`, `discord_create_thread`, `discord_pin_message`, `discord_set_channel_topic`, `discord_get_channel_permissions`, `discord_set_channel_permissions`, `discord_create_channel` |
| **ギルド (5)**           | `discord_list_guilds`, `discord_get_guild`, `discord_list_members`, `discord_search_messages`, `discord_get_audit_log`                                                                                                      |
| **ユーザー (3)**         | `discord_get_user`, `discord_send_dm`, `discord_get_presence`                                                                                                                                                               |
| **ロール (2)**           | `discord_list_roles`, `discord_manage_role`                                                                                                                                                                                 |
| **イベント (3)**         | `discord_create_event`, `discord_list_events`, `discord_delete_event`                                                                                                                                                       |
| **Webhook / Status (2)** | `discord_webhook_send`, `discord_bulk_status`                                                                                                                                                                               |
| **Gemini (3)**           | `gemini_query`, `gemini_review` ⛔, `gemini_search` ⛔                                                                                                                                                                      |
| **ブラウザ (11)**        | `browser_health_check`, `browser_open` ⛔, `browser_snapshot`, `browser_click`, `browser_fill` ⛔, `browser_type`, `browser_screenshot`, `browser_scroll`, `browser_navigate`, `browser_get_text`, `browser_eval` ⛔        |

合計 43 ツール（Discord 29 + Gemini 3 + Browser 11）。`⛔` は LAN 上の RCE / browser hijack 経路を断つため
HTTP transport の既定 denylist（`MCP_HTTP_TOOL_DENYLIST`）で除外され、stdio 経由でのみ呼び出せる。
HTTP 公開時のツール数は既定 38（= 43 − 5）。

### Gemini 委任ツール

Claude Code から Gemini 3.1 Pro にタスクを委任する MCP ツール群。Google AI Pro プラン（OAuth 認証）の quota で動作。

| ツール          | モード                   | 用途                                        |
| --------------- | ------------------------ | ------------------------------------------- |
| `gemini_query`  | テキストのみ             | 分析・要約・翻訳・抽象推論                  |
| `gemini_review` | `--yolo`（ツール使用可） | コードレビュー・git diff 分析・ファイル探索 |
| `gemini_search` | `--yolo`（ツール使用可） | Web 検索込みの調査タスク                    |

`--yolo` モードでは Gemini のビルトインツール（ファイル読み書き・シェル実行・Web 検索）が自動承認で使用可能。
セットアップと詳細は [`docs/gemini-integration.md`](docs/gemini-integration.md) を参照。

### ブラウザ自動操作ツール（agent-browser）

[agent-browser](https://github.com/vercel-labs/agent-browser) を MCP ツールとしてラップ。Chatwork / Telegram Web 等のブラウザ操作を AI エージェントが実行可能。

| ツール               | 用途                                          |
| -------------------- | --------------------------------------------- |
| `browser_open`       | URL を開いてページ構造を取得                  |
| `browser_snapshot`   | アクセシビリティツリー取得（@ref で要素特定） |
| `browser_click`      | 要素クリック                                  |
| `browser_fill`       | 入力フィールドにテキスト入力                  |
| `browser_type`       | キーボード入力                                |
| `browser_screenshot` | スクリーンショット撮影                        |
| `browser_scroll`     | ページスクロール                              |
| `browser_navigate`   | 戻る / 進む / リロード                        |
| `browser_get_text`   | 要素のテキスト取得                            |
| `browser_eval`       | JavaScript 実行                               |

`session_name` パラメータでセッションを永続化でき、ログイン状態を維持できます。

## MCP HTTP Server (feature flag)

通常 MCP は stdio 経由（`@modelcontextprotocol/sdk` の `StdioServerTransport`）で local subprocess に閉じるが、
このリポジトリでは同じ MCP server を **HTTP 経由** でも公開できる。LAN 上の別 PC や別 AI セッション（Claude / Codex / Pi など）から、
1 つの Bot プロセスを multi-client RPC として共有できる。

### 概要

| 項目         | 値                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Endpoint     | `POST http://<host>:<port>/mcp` (JSON-RPC 2.0)                                                     |
| 認証         | `Authorization: Bearer <MCP_API_KEY>` (timing-safe 比較)                                           |
| Liveness     | `GET /health` (認証不要、`{status, uptime, version, toolCount, clientReady}` 返却)                 |
| Feature flag | `MCP_HTTP_ENABLE=true` (既定 `false`、flag off で 1 bit も挙動を変えない)                          |
| 既定 bind    | `127.0.0.1` (loopback only)                                                                        |
| 既定 port    | `7800`                                                                                             |
| Transport    | `StreamableHTTPServerTransport`、stateless (`sessionIdGenerator: undefined`)、per-request instance |

### 起動

`.env` に以下を設定し、`MCP_HTTP_ENABLE=true` にして daemon を再起動するだけで HTTP 公開が有効になる。
`.env.example` も同じ並びで列挙済み。

```bash
MCP_HTTP_ENABLE=true
MCP_HTTP_PORT=7800
MCP_BIND=127.0.0.1                # LAN 公開する場合は 0.0.0.0、ただし下記 Security Runbook を必ず読む
MCP_API_KEY=<openssl rand -hex 32>
MCP_ALLOWED_HOSTS=localhost,127.0.0.1
MCP_HTTP_TOOL_DENYLIST=browser_eval,browser_open,browser_fill,gemini_review,gemini_search
```

`MCP_HTTP_ENABLE=true` のとき `MCP_API_KEY` 未設定は起動エラー（`.env` 更新前の再起動を防ぐため flag off 時は許容）。

### 防御層

`src/mcp/http-transport.ts` は **plain `node:http`**（Express ではない）で以下のミドルウェアを順に適用する:

1. **Host header check** — `MCP_ALLOWED_HOSTS` に無い `Host` は **421 Misdirected Request**（DNS rebinding 防御）。
   Host 値は比較前に **正規化** される: lowercase、末尾ドット (`localhost.`) 除去、IPv6 bracket (`[::1]:7800` → `::1`) unwrap、`,` または whitespace を含む値（misconfigured proxy 由来の Host header smuggling）は即拒否
2. **`GET /health`** はここまでで処理（無認証）
3. **`POST /mcp` 以外**は 404
4. **Rate limit** — 同一 IP からの認証失敗 5/min を超えると **429** + `Retry-After: 60`（brute-force 抑止、in-memory バケット、追加 dep なし）。
   各 bucket は次のリクエスト到達時に lazy evict、加えて **60 秒間隔の periodic sweep**（`setInterval(...).unref()` で process を生かさない）で rotating-IP probe による bucket leak も防ぐ
5. **Bearer token** — 長さに依存しない sha256 ハッシュ比較 + `crypto.timingSafeEqual`（タイミング攻撃耐性、`WWW-Authenticate: Bearer realm="mcp"` 付与）
6. **Body size cap + slow-loris guard** — `Content-Length` または stream byte counter で **1MB** 超は 413（DoS 抑止）。
   さらに body 全体の到着に **5 秒の deadline**（`BODY_READ_DEADLINE_MS`）を設け、超過時は **408 Request Timeout** + `Connection: close` を返してから `setImmediate(req.destroy())` で socket を切る（408 レスポンスが flush される前に socket が消えると client が RST しか受け取れないため）。
   server-level でも **`requestTimeout = 15s`** / **`headersTimeout = 10s`** に縮めて Node 既定（300s / 60s）の slow-loris 余地を最小化
7. **MCP request** — 認証通過後のみ `transport.handleRequest()` へ。`res.on("close")` で SSE 漏れを防ぐ

`Authorization` ヘッダ生値は **どのログにも出力されない**（test で assert 済）。
監査用に **fingerprint = sha256(token).slice(0, 8)** だけが構造化ログに残る。

`src/mcp/http-tool-filter.ts` は HTTP transport 専用のラッパーで、stdio 側には影響しない:

- `MCP_HTTP_TOOL_DENYLIST` のツールを registry から `tool.remove()` で外す
- `discord_send_message` の `files[]` を `ALLOWED_WORKING_DIRS` 内に解決される path のみに制限（realpath 解決後の symlink も同じ check）
- `discord_webhook_send` の `webhook_url` を `https://discord.com/api/webhooks/` プレフィックスのみに制限

## Security Runbook

LAN expose を視野に入れた HTTP transport は loopback のみの bot より攻撃面が広い。以下の手順を遵守する。

### API key の rotation（推奨: 30〜90 日 / 漏洩時即時）

1. 新しいキーを生成: `openssl rand -hex 32`
2. `.env` の `MCP_API_KEY` を新キーに置換
3. daemon を再起動: Windows NSSM 環境は `nssm restart rhi-discord-bot`、開発機は `Ctrl+C` → `npm start`
4. 各クライアント側の `Authorization` ヘッダも同じ新キーへ更新:
   - Claude Code: `.claude.json` の MCP entry（後述 Client Registration Examples）
   - Codex: `~/.codex/config.toml` の MCP entry
   - 他 AI / curl スクリプト: 認証ヘッダ
5. `GET /health` で `clientReady:true` を確認 → 旧キーで `POST /mcp` が 401 を返すことを確認

### `MCP_BIND=0.0.0.0` への flip — LAN expose 操作手順（user 認可必須）

**この操作は production NSSM 設定 + `.env` 改変 + Windows firewall rule 追加 + API key rotation を伴う不可逆性のある変更のため、user 明示認可下のみ実行する。** Sprint 5 までは dry-run smoke (`scripts/smoke-http-mcp-w2-s4.mjs` の loopback 実行) で挙動 verify を完遂、本番 flip は AskUserQuestion gate を経て Sprint 6 で行う。

#### Pre-flight（実行前に必ず読む）

- **現状**: `MCP_HTTP_ENABLE=false` 既定で daemon は HTTP server を起動していない（flag off の間は 1 bit も挙動を変えない contract）
- **影響範囲**: LAN セグメント内の **認証鍵を持つ任意 host** から既定 38 tool（43 - denylist 5）を JSON-RPC で呼び出し可能になる。multi-AI workflow（Claude / Codex / Pi 共有作業）の基盤
- **攻撃面**: LAN 上の認証済み攻撃者を仮想敵 — token 漏洩 → 38 tool 全制御 → Discord guild 操作 / Mailgun / Notion へ被害伝播の経路
- **不可逆性**: rollback は容易（flag off + NSSM restart）。ただしその間に万一漏洩した API key は必ず invalidate

#### Step 1 — `.env` 更新

```bash
# .env に以下を追加 / 更新
MCP_HTTP_ENABLE=true
MCP_BIND=0.0.0.0
MCP_API_KEY=<openssl rand -hex 32 で新規生成した値>
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,<LAN-IP>,<LAN-host-name>
```

- `MCP_API_KEY` は **新規生成**: loopback-only → LAN expose の境界で旧 key は必ず invalidate（漏洩していなくても運用上のベストプラクティス）
- `MCP_ALLOWED_HOSTS` の `<LAN-IP>` は NIC の primary IP（例 `192.168.1.50`）、`<LAN-host-name>` は mDNS / NetBIOS 名（例 `your-host.local`）を **両方** 追加
- `.env` は `.gitignore` 配下。**`MCP_API_KEY` の生値は絶対に commit / log / Discord に貼らない**

#### Step 2 — Windows firewall rule 追加（PowerShell、Admin 権限）

```powershell
New-NetFirewallRule `
  -DisplayName "MCP HTTP 7800" `
  -Name "mcp-http-7800" `
  -LocalPort 7800 `
  -Protocol TCP `
  -Action Allow `
  -Profile Private `
  -Direction Inbound
```

- `-Profile Private` のみ: WAN 経路 (`Public`) には絶対に open しない
- AD 環境 (`Domain` profile) は本機 (WORKGROUP) では非該当。AD 配下の host で運用するなら追加検討
- 確認:
  ```powershell
  Get-NetFirewallRule -Name mcp-http-7800 | Format-List Name,Enabled,Profile,Direction,Action
  ```

#### Step 3 — NSSM restart（Admin 権限）

```powershell
nssm restart rhi-discord-bot
```

- restart 直後の起動 log で `HTTP MCP listening` 行が出ることを確認（NSSM stderr `AppStderr` で設定された path を参照）
- restart 完了後 5-10 秒待って Discord Gateway 再接続を確認（bot account `online` 状態 + 既存 channel への post 不能でないか）
- `HTTP MCP listening` 行が出ない場合: NSSM stderr 末尾 50 行を tail し、`MCP_API_KEY is required when MCP_HTTP_ENABLE=true` などの `requireEnv` error なら Step 1 の `.env` を再確認、port 競合なら `netstat -ano | findstr :7800` で占有 process を identify
- 反映確認: `netstat -an | findstr :7800` で `0.0.0.0:7800 ... LISTENING` が出れば flag + bind が反映済

#### Step 4 — Post-deploy verify（dry-run と同 assertion を実環境で再走）

**部分 fail 時の判断軸**: 4a / 4b fail = 基本機能が broken、**即 rollback**。4c のみ fail = security regression、**即 rollback**。4d のみ fail = loopback 不整合だが production は触っていないので **debug 可** (smoke script の差異を先に切り分ける)。

**4a. 認証経路の正常系**（別 PC から）

```bash
curl -sS \
  -H "Authorization: Bearer $RHI_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  http://<LAN-IP>:7800/mcp | jq '.result.tools | length'
# 期待: 38
```

**4b. Liveness probe**

```bash
curl -sS http://<LAN-IP>:7800/health
# 期待: {"status":"ok","uptime":<N>,"version":"<ver>","toolCount":38,"clientReady":true}
```

**4c. 防御層の抜き打ち confirm**

```bash
# Host check (DNS rebinding 防御)
# libcurl は URL の hostname と異なる Host header を黙って書き換えるため、--resolve で
# DNS を強制 mapping して evil.com 経由のリクエストを <LAN-IP> に送る (smoke script
# が node:http を使っているのと同じ理由、scripts/smoke-http-mcp-w2-s4.mjs L6-8 参照)
curl -sS -o /dev/null -w "%{http_code}\n" --resolve evil.com:7800:<LAN-IP> http://evil.com:7800/health
# 期待: 421

# 認証失敗 → 401
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer wrong-key" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  http://<LAN-IP>:7800/mcp
# 期待: 401

# 旧 key で 401 (rotation 完了の証拠)
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $OLD_KEY" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  http://<LAN-IP>:7800/mcp
# 期待: 401
```

**4d. Hardening smoke**（本機 loopback、production と衝突しない ephemeral port）

```bash
cd ~/workspace/projects/rhi-discord-bot
node scripts/smoke-http-mcp-w2-s4.mjs
# 期待: smoke[W2-S4]: 8/8 passed
```

`scripts/smoke-http-mcp-w2-s4.mjs` は ephemeral port + fake Discord client + 8 path assertion（tools/list 38 / `/health` 200 / 401 / Host normalisation / Host smuggling 421 / 5 fail → 429 + Retry-After / slow-loris 5s deadline + 408）を ~5 秒で走らせる。production NSSM (port 7800) と同居可能。

#### Rollback（incident 検出時 / abort）

1. `.env` で `MCP_HTTP_ENABLE=false` に戻す（または `MCP_BIND=127.0.0.1` のみ戻しても attack surface は閉じる）
2. `nssm restart rhi-discord-bot`
3. firewall rule 削除: `Remove-NetFirewallRule -Name "mcp-http-7800"`
4. 漏洩疑いがあれば `MCP_API_KEY` を再 rotate（Step 1 と同じ手順）
5. 運用 Discord channel（例 `#通知センター`）に rollback 通知（multi-AI dogfood 中の他 AI に状況を周知）

#### Dry-run（Sprint 5 scope、autonomous）

実 production を触る前に、上記 workflow の Step 4 assertion 群を **loopback の subprocess** で同義に走らせて挙動を verify できる。

```bash
# 本機の任意 user 権限（NSSM 不触）
MCP_HTTP_ENABLE=true MCP_API_KEY=dryrun-key MCP_HTTP_PORT=0 \
  node scripts/smoke-http-mcp-w2-s4.mjs
# 期待: smoke[W2-S4]: 8/8 passed
```

`MCP_HTTP_PORT=0` で ephemeral port を取り、production daemon (port 7800) と衝突しない。Sprint 5 はこの dry-run のみを autonomous で完遂し、production NSSM / `.env` / firewall は一切触らない。

### Tool denylist の意味と境界

`MCP_HTTP_TOOL_DENYLIST` の既定値は、LAN 上の認証済み攻撃者を仮想敵にして選定:

| ツール          | 既定 deny 理由                                                   |
| --------------- | ---------------------------------------------------------------- |
| `browser_eval`  | `agent-browser eval <script>` で任意 JS 実行 → 実質 RCE          |
| `browser_open`  | 任意 URL を agent-browser で開ける → SSRF / browser hijack 起点  |
| `browser_fill`  | ログイン中の web UI に任意フィールド注入 → セッション乗っ取り    |
| `gemini_review` | `--yolo` モードで file read / shell exec / web search が自動承認 |
| `gemini_search` | 同上 + 任意 web query で quota 消費                              |

これらを HTTP に公開したい場合は、**LAN 上の攻撃者モデル**を再評価した上で env で override する。
新しいツールを `src/mcp/tools/*.ts` に追加した時は、HTTP 経由で安全に呼べるかを別途検証し、必要なら denylist へ追記する
（stdio は影響なし）。

### Audit log

stderr に component 名付きで構造化出力される:

- `mcp-http` — listen / shutdown / MCP request / Host header / generic auth failure
- `mcp-http-filter` — denylist 適用 / 各 guard hit

NSSM 配下のサービスでは標準出力リダイレクトの設定に従う（プロジェクトの `nssm set <svc> AppStderr` 設定を確認）。
リクエストごとに `{ip, path, fingerprint}` が、認証失敗には追加で `{ua, reason}` が記録される。
**`Authorization` ヘッダの生値は redact contract により絶対に出力されない**（`src/mcp/__tests__/http-transport.test.ts` で assert 済）。

### Path-traversal / Webhook guard

- `discord_send_message` の `files[]` は `ALLOWED_WORKING_DIRS`（既定 CWD）配下の path のみ受理。`/etc/passwd` 等は EINVAL で reject。realpath 後の symlink も同じ check に通る
- `discord_webhook_send` の `webhook_url` は `https://discord.com/api/webhooks/` プレフィックス必須。任意外部 URL への SSRF を断つ

### 残課題（運用上の注意）

- `MCP_API_KEY` は **単一の shared secret**。複数クライアントを区別するには現状ログの fingerprint で識別するしかない。client 別の key 管理が必要になったら拡張検討
- `src/mcp/http-tool-filter.ts` は MCP SDK の private `_registeredTools` registry を直接触っている（公式 API なし）。将来の SDK 更新で API が変わった場合は defensive な throw で起動失敗するので、回帰 test で検知可能

## Client Registration Examples

### Claude Code (`~/.claude.json`)

```jsonc
{
  "mcpServers": {
    "rhi-discord": {
      "type": "http",
      "url": "http://127.0.0.1:7800/mcp",
      "headers": {
        "Authorization": "Bearer ${RHI_MCP_API_KEY}",
      },
    },
  },
}
```

`RHI_MCP_API_KEY` を環境変数として shell に export しておく（または直接 `Bearer xxxxxxxx...` を埋め込む）。
LAN 公開時は `url` の host 部分を `http://192.168.1.50:7800/mcp` 等の LAN IP に変更。

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.rhi-discord]
type = "http"
url = "http://127.0.0.1:7800/mcp"
authorization = "Bearer ${RHI_MCP_API_KEY}"
```

> Codex の正確な MCP entry schema は `~/.codex/config.toml.example` または公式 docs を参照。
> `Authorization` ヘッダの注入経路は client によって `headers` / `authorization` / `auth_header` 等の差異がある。

### 任意の curl クライアント

```bash
export RHI_MCP_API_KEY="$(grep '^MCP_API_KEY=' .env | cut -d= -f2)"
curl -sS \
  -H "Authorization: Bearer $RHI_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  http://127.0.0.1:7800/mcp | jq '.result.tools | map(.name)'
```

## Example Usage

### `tools/list`（公開ツール一覧の取得）

```bash
curl -sS \
  -H "Authorization: Bearer $RHI_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' \
  http://127.0.0.1:7800/mcp
```

返却 `tools` 配列の長さは既定 38（43 − denylist 5）。`browser_eval` / `gemini_review` 等が含まれないことが、
denylist が効いている確認になる。

### `discord_send_message`（チャンネルへの送信）

```bash
curl -sS \
  -H "Authorization: Bearer $RHI_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": {
          "name": "discord_send_message",
          "arguments": {
            "guild_id": "YOUR_GUILD_ID",
            "channel_id": "YOUR_CHANNEL_ID",
            "content": "Hello from HTTP MCP!"
          }
        },
        "id": 2
      }' \
  http://127.0.0.1:7800/mcp
```

`guild_id` / `channel_id` は Discord クライアントの「開発者モード → ID をコピー」で取得。
`MCP_ALLOWED_GUILD_IDS` を設定している場合は、その allowlist に含まれる guild のみ受理される。

### `/health`（liveness check、認証不要）

```bash
curl -sS http://127.0.0.1:7800/health
# => {"status":"ok","uptime":42,"version":"1.0.0","toolCount":38,"clientReady":true}
```

`clientReady` は `src/mcp/client-ready-probe.ts` の strict probe を経由しており、**`ws.status === Status.Ready` かつ `ws.ping >= 0`**（少なくとも 1 回 heartbeat round-trip が完了）の両方を満たす時のみ `true`。
discord.js の `client.isReady()` は初回 READY 後 destroy まで `true` のままだが、本 probe は **Gateway 再接続中（token rotation / websocket close / mid-reconnect）に `false` を返す**ため、ロードバランサや NSSM supervision からの liveness probe として実態を反映する。

## チャンネル応答モード

`config/channels.json` でチャンネルごとの応答モードと systemPrompt を設定。

| モード    | 動作               | 使用チャンネル例                       |
| --------- | ------------------ | -------------------------------------- |
| `auto`    | 全メッセージに応答 | #ai_chat, #案件管理, #経理             |
| `mention` | @メンション時のみ  | 案件チャンネル（10 個）, #通知センター |
| `none`    | 応答しない         | #general, #スウォーム報告              |

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
| puppeteer-core                 | PDF 請求書生成                                            |
| xlsx                           | Excel テンプレート操作                                    |
| zod                            | スキーマバリデーション                                    |
| vitest                         | ユニットテスト                                            |
| agent-browser                  | ブラウザ自動操作（Rust ネイティブ CLI）                   |
| Claude CLI                     | `claude -p`（StructuredIO stream-json）                   |
| Gemini CLI                     | `gemini -p` / `--yolo`（タスク委任）                      |

## プロジェクト構造

```
discord-claude-bot/
├── src/
│   ├── index.ts              # メインエントリ（Gateway Bot）
│   ├── mcp-standalone.ts     # MCP Standalone エントリ（REST-only）
│   ├── mcp-entry.ts          # 結合エントリ
│   ├── dns-fix.ts            # IPv6 DNS タイムアウト対策
│   ├── config.ts             # 環境変数・チャンネル設定・外部設定ファイル読込
│   ├── logger.ts             # 構造化 JSON ロガー
│   ├── types.ts              # StructuredIO NDJSON 型定義
│   ├── claude/               # Claude CLI 連携
│   │   └── __tests__/        # ユニットテスト
│   ├── discord/              # Discord 連携（コマンド・ハンドラ・画像添付）
│   ├── session/              # セッション管理・同時実行制限
│   │   └── __tests__/        # ユニットテスト
│   ├── response/             # 応答フォーマッタ・ストリーミング
│   │   └── __tests__/        # ユニットテスト
│   ├── invoice/              # 請求書生成・メール送信
│   ├── scripts/              # CLI スクリプト
│   └── mcp/                  # MCP Server（43 ツール: stdio + HTTP）
│       ├── server.ts         # createMcpServer() factory（tool 登録）
│       ├── http-transport.ts # HTTP transport（plain node:http、Bearer 認証 + Host check + rate limit + slow-loris guard）
│       ├── http-tool-filter.ts # HTTP 用 denylist + path-traversal guard + webhook URL guard
│       ├── client-ready-probe.ts # /health の clientReady strict probe（ws.status + ws.ping、Gateway 再接続中は false）
│       └── tools/
│           ├── messages.ts   # Discord メッセージ操作
│           ├── channels.ts   # Discord チャンネル操作
│           ├── guilds.ts     # Discord ギルド操作
│           ├── users.ts      # Discord ユーザー操作
│           ├── roles.ts      # Discord ロール操作
│           ├── events.ts     # Discord イベント操作
│           ├── webhooks.ts   # Webhook 操作
│           ├── gemini.ts     # Gemini CLI 委任
│           └── browser.ts    # agent-browser ブラウザ自動操作
├── config/
│   ├── channels.json                    # チャンネル別設定（16ch）
│   ├── invoice-defaults.example.json    # 請求書発行者テンプレート
│   └── notion-ids.example.json          # Notion DB ID テンプレート
├── scripts/
│   ├── schedule-runner.ps1   # スケジュール共通ラッパー（ログ・失敗通知）
│   ├── ensure-rhi-chrome.bat # Chrome CDP 起動
│   ├── smoke-http-mcp.mjs    # Wave 1 HTTP MCP smoke（auth + denylist + path guard）
│   ├── smoke-http-mcp-w2-s4.mjs # Sprint 4 hardening smoke（Host norm + slow-loris + rate-limit + timeouts、8/8 PASS 期待）
│   └── ...                   # その他セットアップスクリプト
├── schedules/                # スケジュールタスク（9 タスク）
│   ├── *.md                  # Claude CLI プロンプト（Notion MCP 指示書）
│   ├── run-*.bat             # Windows Task Scheduler 実行ファイル
│   ├── register-tasks.ps1    # 全タスク一括登録スクリプト
│   └── archived/             # アーカイブ済みスケジュール
├── docs/
│   ├── gemini-integration.md # Gemini 委任セットアップ
│   └── notion-view-setup.md  # Notion ビュー設定ガイド
├── .github/workflows/
│   └── ci.yml                # GitHub Actions CI（ビルド + テスト）
├── vitest.config.ts          # テスト設定
├── package.json
└── tsconfig.json
```
