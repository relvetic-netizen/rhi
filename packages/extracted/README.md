# RELVETIA Extracted Code & Knowledge

Claude Code の未リリース自律デーモンモード「RELVETIA」から抽出した再利用可能なコードとノウハウ。
論文「Screening Is Enough」(arXiv:2604.01178) の Trim-and-Square を読み書き両面に適用。

## 構成

```
relvetia-extracted/
├── screening/             # Screening モジュール（読み出し + 書き込み）
│   ├── screening.ts         # TF-IDF + Trim-and-Square コアアルゴリズム
│   ├── noveltyScreening.ts  # 逆 Trim-and-Square（書き込み側新規性検出）
│   ├── memoryScreening.ts   # メモリ検索事前フィルタ
│   ├── messageScreening.ts  # コンテキスト圧縮スコアリング
│   ├── memorySearch.ts      # 4層検索 (index エントリ → 新規ファイル → 48h ログ行 → 全期間ログ行)。superseded_by 付きエントリは降格
│   ├── screeningConfig.ts   # Zod 設定スキーマ
│   ├── stopwords.ts         # ストップワードリスト
│   └── README.md            # モジュール詳細ドキュメント
├── scheduler/             # Cronスケジューラシステム
│   ├── cronScheduler.ts     # コア（ロック、ジッター、ファイル監視）
│   ├── cronTasks.ts         # タスクCRUD、永続化、見逃し検出
│   └── cronJitterConfig.ts  # GrowthBook連携ジッター設定
├── tools/                 # ツール実装
│   ├── BriefTool.ts         # SendUserMessage（権限/有効化分離）
│   ├── CronCreateTool.ts    # タスク作成
│   ├── CronDeleteTool.ts    # タスク削除
│   ├── CronListTool.ts      # タスク一覧
│   ├── MemorySearchTool.ts  # スクリーニング対応検索ツール
│   └── prompt.ts            # 動的プロンプト生成
├── memory/                # メモリシステム
│   └── dailyLog.ts          # 追記専用日次ログ
├── PATTERNS.md            # 10個の再利用可能な設計パターン
└── README.md              # このファイル
```

## Screening の二面性

| 方向 | 数式 | 用途 |
|---|---|---|
| **読み出し** | `α = [max(1 - r·(1-s), 0)]²` | メモリ検索、コンテキスト圧縮 |
| **書き込み** | `α = [max(1 - r·s, 0)]²` | 新規性検出、重複排除 |

同じ Trim-and-Square 関数を類似度の反転だけで両方向に使える。

## 主要な再利用ポイント

### 1. Screening (`screening/`)
- TF-IDF ベースのコサイン類似度（外部依存ゼロ）
- Trim-and-Square: 閾値以下は**厳密にゼロ**（完全拒絶）
- 読み出し: メモリ検索の事前フィルタ（typical ~10件入力 / 旧 200 件キャップは `MAX_FILES = 2000` の防御天井に降格、`MEMORY_SCAN_LEGACY_FULL=1` で旧挙動へロールバック可能）
- 書き込み: 逆Screeningで既知情報を除外して新規のみ記録
- 安全弁: 全件拒絶時はフォールバック

### 2. Cronスケジューラ (`scheduler/`)
- ファイル監視 (chokidar) + 1秒ポーリングのハイブリッド
- プロセス間ロック（複数セッション対応）
- ジッター分散（thundering herd 防止）
- 見逃しタスク検出・通知

### 3. メモリシステム (`memory/`)
- 追記専用の日次ログ (`logs/YYYY/MM/YYYY-MM-DD.md`)
- 夜間蒸留プロセス（ログ → トピック → MEMORY.md）
- MemorySearchTool: grep代替のスクリーニング対応検索

### 4. フィーチャーゲート (`tools/`)
- ビルド時 DCE (`feature('FLAG')`)
- ランタイム GrowthBook ゲート
- Entitlement/Enabled 分離
