# Screening Module

論文 **"Screening Is Enough"** (arXiv:2604.01178, Ken M. Nakanishi) の
Trim-and-Square メカニズムをテキスト関連性フィルタリングに適用したモジュール。

## 核心アイデア

従来の Softmax Attention は相対評価（重み合計=1）のため、無関係な Key にも
必ず非ゼロの重みが漏れる（**希薄化/dilution問題**）。
Screening は各 Key を**絶対閾値で独立評価**し、無関係なものは**完全にゼロ**にする。

```
α_ij = [max(1 - r·(1 - s_ij), 0)]²
```

- `s_ij < 1 - 1/r` → α = **厳密にゼロ**（完全拒絶）
- 閾値以上 → 二次曲線で滑らかに立ち上がり
- Softmax 正規化なし → 集約は単純な重み付き和

## モジュール構成

```
screening/
├── screening.ts            # コアアルゴリズム (TF-IDF + Trim-and-Square + CJK bigram)
├── noveltyScreening.ts     # 逆 Trim-and-Square（書き込み側新規性検出）
├── semanticSelector.ts     # Stage 2: Claude Sonnet 意味的選択 (claude -p, Max対応)
├── findRelevantMemories.ts # 2段階パイプライン (TF-IDF → Sonnet)
├── screeningLog.ts         # opt-in 診断ログ基盤 (JSON Lines, stderr)
├── stopwords.ts            # 英語ストップワードリスト（外部依存なし）
├── screeningConfig.ts      # Zod 設定スキーマ + ベンチマーク最適化済みデフォルト値
├── memoryScreening.ts      # メモリ検索の事前フィルタアダプタ
├── messageScreening.ts     # コンテキスト圧縮用メッセージスコアリング
├── memorySearch.ts         # スクリーニング対応全文検索
└── README.md               # このファイル
```

## コア関数

### `screening.ts`

| 関数 | 説明 |
|---|---|
| `tokenize(text)` | テキストをトークン化（ASCII: 単語分割、CJK: bigram 分割） |
| `buildIdfMap(docs)` | コーパスからIDF辞書を構築 |
| `tfidfVector(text, idfMap)` | TF-IDFスパースベクトルを計算 |
| `cosineSimilarity(a, b)` | スパースベクトル間のコサイン類似度 [0, 1] |
| `trimAndSquare(similarity, r)` | 論文のTrim-and-Square活性化関数 |
| `sharpnessFromThreshold(threshold)` | 閾値からシャープネスパラメータ `r` を導出 |
| `recencyFactor(ageMs, halfLifeMs)` | 指数減衰による鮮度ブースト |
| `screenItems(items, getText, query, config)` | **メインAPI**: アイテムをスクリーニング |
| `setScreeningDiagnostics(cb)` | 類似度統計の診断コールバック登録 |

### CJK bigram トークナイザ

日本語・中国語テキストをキャラクター bigram に分割（IR の標準手法、外部依存ゼロ）:

```
"データベース" → ["デー", "ータ", "タベ", "ベー", "ース"]
"東京都" と "東京" → 共有 bigram "東京" → 類似度 > 0
```

英語は従来通り単語分割。混在テキスト（例: `"PostgreSQL データベース migration"`）も正しく処理。

### `screenItems` の使い方

```typescript
import { screenItems, type ScreeningConfig } from './screening.js'

const config: ScreeningConfig = {
  threshold: 0.15,   // この類似度以下を完全拒絶 (r ≈ 1.18)
  maxResults: 30,    // 返却件数上限
  boostRecency: true,
  recencyHalfLifeMs: 7 * 24 * 3600 * 1000,
}

const results = screenItems(
  documents,
  doc => doc.content,           // テキスト抽出関数
  'database migration schema',  // クエリ（日本語も可）
  config,
  doc => Date.now() - doc.createdAt,  // 鮮度計算（オプション）
)
// → score > 0 のアイテムのみ、スコア降順で返却
```

### 2段階パイプライン (`findRelevantMemories`)

```typescript
import { findRelevantMemories } from './findRelevantMemories.js'

// TF-IDF (Stage 1) + Sonnet (Stage 2) の2段階検索
const relevant = await findRelevantMemories(
  'データベース移行の手順',
  '~/.claude/memory',
  { enableSonnet: true },  // false でオフライン/高速モード
)
// → 最大5件の関連メモリ（意味的に正確）
```

Stage 2 は `claude -p` 経由で Sonnet を呼び出すため **Claude Max プランの範囲内**で
追加 API 料金は発生しない。

## 適用先

### 1. メモリ検索 (`findRelevantMemories.ts` — 2段階パイプライン)

```
scanMemoryFiles() → screenMemories() → selectWithSonnet(claude -p)
  ~10件 (typical)       ~10件                   最終5件
  (Stage 1: TF-IDF)                    (Stage 2: Sonnet意味的選択)
```

Stage 1 の入力件数は **2026-05-23 の MAX_FILES 構造修正後** に大きく変わった:
default `CorpusManifest` で `.backup` / `.staging` / `tmp-*` を除外し、
`.last-distill` 以降に更新されたファイルだけを mtime gate で残すため、
本番 memoryDir (~270 ファイル) でも入力は通常 0〜30 件、典型値 ~10 件。
旧 200 件キャップは load-bearing ではなくなり、`MAX_FILES = 2000` の
防御天井に降格 (`MEMORY_SCAN_LEGACY_FULL=1` で旧 200 キャップへ
ロールバック可能)。

Stage 1: TF-IDF + CJK bigram で高速事前フィルタ（ベンチマーク最適化済み）。
Stage 2: `claude -p` 経由で Sonnet に意味的選択を依頼（Max プラン内）。
Stage 2 失敗時は Stage 1 結果にフォールバック（常に結果を返す）。

### 2. コンテキスト圧縮 (`messageScreening.ts`)

会話メッセージを現在のタスクコンテキスト（直近ユーザーメッセージ）に対して
スコアリング。低関連性メッセージを特定し、圧縮時の積極的要約候補にする。

**安全制約**: tool_use/tool_result ペアと直近Nメッセージは絶対に除外しない。

### 3. メモリ全文検索 (`memorySearch.ts`)

grep の代替。キーワード一致ではなくTF-IDF類似度で検索し、
閾値以下のファイルは完全に除外。`MemorySearchTool` として公開。

## 設定

`screeningConfig.ts` は `cronJitterConfig.ts` パターンに従う:

- Zod スキーマで境界チェック
- `safeParse` + デフォルトフォールバック
- GrowthBook 連携可能（REPL コンテキスト）
- `setScreeningConfig()` でテスト時オーバーライド

## テスト

```bash
cd relvetia-daemon
npm run test                                       # 全テスト (138件)
npx vitest run test/screening.test.ts              # コアアルゴリズム + CJK (45件)
npx vitest run test/screening-integration.test.ts  # 統合テスト (25件)
npx vitest run test/novelty-screening.test.ts      # 新規性スクリーニング (19件)
npx vitest run test/semantic-selector.test.ts      # Sonnet セレクタ解析 (14件)
npx vitest run test/benchmark-threshold.test.ts    # ベンチマーク (1件)
```

## 設計上の判断

| 判断 | 理由 |
|---|---|
| TF-IDF + CJK bigram（埋め込みなし） | 外部依存ゼロ、200文書で十分高速、日本語・中国語対応 |
| Trim-and-Square（単純カットではなく） | 閾値以下は厳密にゼロ、遷移帯域で滑らかな二次曲線 |
| 2段階パイプライン（TF-IDF → Sonnet） | TF-IDFは語彙重複のみ捕捉。意味ギャップはSonnetが解決 |
| `claude -p`（直接API ではなく） | Max プラン内で追加料金ゼロ。Sonnet失敗時はStage 1にフォールバック |
| 安全弁（全件拒絶→全件返却） | サイレントな情報損失を防止 |
| Recency boost（オプション） | 同一トピックの新しい記憶を優先（指数減衰） |
| ベンチマーク駆動の閾値最適化 | 36件 × 16クエリで precision/recall/safety valve を計測して決定 |

## Novelty Screening（書き込み側）

### `noveltyScreening.ts`

読み出し側の逆: 既存メモリと**類似度が高い観察を厳密にゼロ**にして記録しない。

```
読み出し: α = [max(1 - r·(1-s), 0)]²   → 類似度高い = 通過
書き込み: α = [max(1 - r·s, 0)]²       → 類似度低い = 通過（新規）
```

| 関数 | 説明 |
|---|---|
| `trimAndSquareNovelty(sim, r)` | 逆 Trim-and-Square（高類似度→ゼロ） |
| `splitIntoObservations(text)` | テキストを文単位に分割 |
| `screenForNovelty(obs, memory, config)` | 既存メモリに対して新規性スクリーニング |

### 使い方

```typescript
import { splitIntoObservations, screenForNovelty } from './noveltyScreening.js'

const observations = splitIntoObservations(claudeResponse)
const novel = screenForNovelty(observations, existingMemoryTexts, {
  threshold: 0.25,    // この類似度以上を冗長として拒絶 (r = 4.0)
  maxObservations: 10,
})
// → 既知の情報は完全にゼロ、新規な観察のみ返却
```

### 適用先

- **Stopフック** (`relvetia-observe.sh`): 毎ターンの自律記録
- **SessionEnd蒸留** (`relvetia-session-distill.sh`): セッション要約の重複排除

### テスト

```bash
cd relvetia-daemon
npx vitest run test/novelty-screening.test.ts  # 19件
npx vitest run                                  # 全115件
```
