# Gemini CLI Integration

Claude Code から Google Gemini 3.1 Pro にタスクを委任するための MCP ツール群。
Google AI Pro プラン（$20/月）の quota 内で動作する。

## セットアップ

```bash
# 1. Gemini CLI インストール
npm install -g @google/gemini-cli

# 2. Google アカウント認証（初回のみ、ブラウザが開く）
gemini auth login

# 3. 動作確認
gemini -p "hello" --output-format json

# 4. 環境変数（任意 — デフォルトで動く）
GEMINI_CLI_PATH=gemini          # CLI パス
GEMINI_MODEL=gemini-3.1-pro     # モデル
GEMINI_TIMEOUT_MS=120000        # タイムアウト（ms）
```

## MCP ツール一覧

### `gemini_query` — テキスト分析（ツール使用なし）

Gemini に読み取り専用のテキスト質問を送る。`--yolo` なし。

**適用シーン:**
- 抽象推論・新規問題解決
- 大学院レベルの科学的分析
- テキスト要約・翻訳
- 複雑なコード解説

**使用例（Claude Code から）:**
```
gemini_query で以下を分析して: [コード or テキスト]
```

### `gemini_review` — コードレビュー（`--yolo` モード）

Gemini が `read_file`, `run_shell_command`, `grep` 等のビルトインツールを使って
リポジトリを自律的に探索しレビューする。

**適用シーン:**
- git diff のレビュー
- アーキテクチャ分析
- import 追跡・依存関係分析
- セキュリティ監査

**使用例:**
```
gemini_review で最新の git diff をレビューして。バグとスタイルの問題を指摘して。
```

### `gemini_search` — Web 調査（`--yolo` モード）

Gemini が `google_web_search` を使ってリアルタイムの Web 情報を調査。

**適用シーン:**
- API ドキュメント・ライブラリの最新情報
- ベストプラクティスの調査
- エラーメッセージの解決策検索
- 技術トレンド調査

**使用例:**
```
gemini_search で Next.js 15 の migration guide を調べて。
```

## `--yolo` モードについて

`--yolo` フラグは Gemini CLI のビルトインツールを自動承認するモード。

| ツール | 説明 |
|---|---|
| `read_file` | ファイル読み取り |
| `write_file` | ファイル書き込み |
| `run_shell_command` | シェルコマンド実行 |
| `google_web_search` | Web 検索 |
| `grep` | ファイル内容検索 |

**セキュリティ配慮:**
- 環境変数は `GOOGLE_*`, `GEMINI_*`, `HOME`, `PATH` のみ Gemini に渡される
- Discord トークンや API キー等は Gemini プロセスに露出しない
- `cwd` パラメータで作業ディレクトリを制限可能

## Gemini 3.1 Pro の強み

Claude と Gemini の使い分け基準:

| タスク | 推奨モデル | 理由 |
|---|---|---|
| 抽象推論・新規問題解決 | **Gemini** | ベンチマークで優位 |
| 大学院レベル科学推論 | **Gemini** | GPQA Diamond で高スコア |
| コードレビュー | **Gemini** | 大コンテキスト（1M トークン）で広範囲を一度に分析 |
| Web リサーチ | **Gemini** | ビルトイン google_web_search |
| UI/UX デザイン | **Gemini** | 視覚的フィードバックが得意 |
| 堅牢なバックエンド実装 | **Claude** | ツール使用・コード生成の精度 |
| 複雑なリファクタリング | **Claude** | セッション継続・ファイル操作が安定 |
| システム設計・設計判断 | **Claude** | 長期的コンテキスト理解 |

## Quota 管理

**Google AI Pro プラン（$20/月）:**
- 公称: 1,500 リクエスト/日（Gemini CLI + Code Assist 合算）
- 実効: Pro モデルで 100〜200 回/日（1 エージェント呼び出しで内部的に複数リクエスト消費）
- `--yolo` モードはツール呼び出し分だけ追加消費される

**Quota 節約 Tips:**
- 単純な質問は `gemini_query`（ツールなし = 消費少）
- `gemini_review` / `gemini_search` は本当に必要な時だけ
- 大量の分析が必要な場合は Claude 側で前処理してから Gemini に渡す
- Quota 切れの場合は Claude にフォールバック

## 技術詳細

**実装:** `src/mcp/tools/gemini.ts`

Gemini CLI をサブプロセスとして起動し、stdin 経由でプロンプトを渡し、stdout の JSON を解析して返す。

```
spawn("gemini", ["--yolo", "--model", "gemini-3.1-pro", "--output-format", "json"])
  ↓ stdin: prompt
  ↓ stdout: JSON result
  ↓ parse → MCP text content
```

hampsterx/gemini-mcp-bridge のアプローチを参考に、外部依存なしで自前実装。
