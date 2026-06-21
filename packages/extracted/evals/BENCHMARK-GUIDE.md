# Relvetia 実環境ベンチマーク実行プロンプト

## 概要

このプロンプトは、Relvetia メモリシステムの有無による Claude Code の性能差を
実環境で定量比較するためのプロトコルです。

同一タスクを「Relvetia有効」「Relvetia無効」の2条件で実行し、
出力品質・文脈活用・一貫性を数値化します。

---

## 前提条件

- Claude Code がインストール済み（`claude` コマンド利用可能）
- Relvetia がセットアップ済み（`/relvetia status` が動作する）
- 数セッション分のメモリが蓄積済み（topics/, logs/ にデータがある）
- jq がインストール済み（JSON解析用）

---

## Step 1: 現在のメモリ状態を記録

ベンチマーク前にメモリの規模を把握する。

```bash
echo "=== Memory State ==="
echo "MEMORY.md lines: $(wc -l < ~/.claude/memory/MEMORY.md 2>/dev/null || echo 0)"
echo "Topic files: $(ls ~/.claude/memory/topics/*.md 2>/dev/null | wc -l)"
echo "Log files: $(find ~/.claude/memory/logs -name '*.md' 2>/dev/null | wc -l)"
echo "index.json entries: $(jq '.entries | length' ~/.claude/memory/index.json 2>/dev/null || echo 0)"
```

---

## Step 2: タスクセットを定義

以下の5カテゴリから各2-3タスクを用意する。
タスクは**自分のプロジェクトに合わせてカスタマイズ**すること。

### カテゴリ A: Cross-Session Recall（過去の決定の想起）

過去のセッションで記録した情報を質問する。

```bash
# 例: 過去に決めた技術スタックを聞く
TASK_A1="このプロジェクトで使っているデータベースとORMは何？理由も含めて教えて"
TASK_A2="テストフレームワークは何を使う方針だった？"
TASK_A3="デプロイ先とその設定について教えて"
```

### カテゴリ B: Preference Adherence（好みの遵守）

過去に表明した好みが反映されるか確認する。

```bash
# 例: パッケージマネージャの好みが反映されるか
TASK_B1="新しいパッケージを追加するコマンドを教えて"
TASK_B2="テストを書いて実行する手順を教えて"
TASK_B3="コミットメッセージの例を3つ書いて"
```

### カテゴリ C: Context Efficiency（文脈の効率性）

回答の精度と簡潔さを評価する。

```bash
# 例: 具体的な技術質問
TASK_C1="APIエンドポイントの認証の仕組みを説明して"
TASK_C2="CIパイプラインの設定を説明して"
TASK_C3="既知の技術的問題とワークアラウンドを列挙して"
```

### カテゴリ D: Prior Knowledge Accuracy（過去知識の正確性）

過去の決定と矛盾しない回答をするか確認する。

```bash
# 例: 移行中の技術について正しい現状を答えるか
TASK_D1="ORMの選定状況を教えて。移行作業は？"
TASK_D2="フロントエンドのコンポーネント設計方針は？"
```

### カテゴリ E: Cold Start Recovery（初期化なしからの復帰）

新しいセッションで過去の文脈をどれだけ活用できるか。

```bash
# 例: 前回の作業の続きを依頼
TASK_E1="前回のセッションで何をやっていたか覚えている？続きをやりたい"
TASK_E2="このプロジェクトの全体像と自分の役割を説明して"
```

---

## Step 3: ベンチマーク実行スクリプト

以下のスクリプトを `relvetia-benchmark.sh` として保存し、実行する。

```bash
#!/usr/bin/env bash
set -euo pipefail

# ─── 設定 ───
RESULTS_DIR="./benchmark-results/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

# タスク定義（自分のプロジェクトに合わせて編集）
declare -a TASKS=(
  "A1|cross-session-recall|このプロジェクトで使っているデータベースとORMは何？理由も含めて教えて"
  "A2|cross-session-recall|テストフレームワークは何を使う方針だった？"
  "B1|preference-adherence|新しいパッケージを追加するコマンドを教えて"
  "B2|preference-adherence|テストを書いて実行する手順を教えて"
  "C1|context-efficiency|既知の技術的問題とワークアラウンドを列挙して"
  "D1|prior-knowledge|ORMの選定状況を教えて。移行作業は？"
  "E1|cold-start|前回のセッションで何をやっていたか覚えている？"
)

MODEL="${RELVETIA_MODEL:-sonnet}"
MAX_TURNS=5  # ベンチマーク用に制限

echo "=== Relvetia Real-World Benchmark ==="
echo "Date: $(date -Iseconds)"
echo "Model: $MODEL"
echo "Tasks: ${#TASKS[@]}"
echo "Results: $RESULTS_DIR"
echo ""

# ─── Condition 1: Relvetia 有効 ───
echo ">>> Running Condition 1: Relvetia ENABLED"

for task_def in "${TASKS[@]}"; do
  IFS='|' read -r task_id category prompt <<< "$task_def"
  echo "  [$task_id] $category..."

  START_MS=$(($(date +%s%N) / 1000000))
  OUTPUT=$(claude --model "$MODEL" --max-turns $MAX_TURNS --print -p "$prompt" 2>/dev/null || true)
  END_MS=$(($(date +%s%N) / 1000000))
  DURATION=$((END_MS - START_MS))

  # 結果を保存
  cat > "$RESULTS_DIR/${task_id}_relvetia.json" << ENDJSON
{
  "taskId": "$task_id",
  "category": "$category",
  "condition": "relvetia",
  "prompt": $(echo "$prompt" | jq -Rs .),
  "output": $(echo "$OUTPUT" | jq -Rs .),
  "outputChars": ${#OUTPUT},
  "durationMs": $DURATION,
  "timestamp": "$(date -Iseconds)"
}
ENDJSON

  echo "    Done (${DURATION}ms, ${#OUTPUT} chars)"
done

# ─── Condition 2: Relvetia 無効 ───
echo ""
echo ">>> Running Condition 2: Relvetia DISABLED"

# Relvetia を無効化: メモリパスを空ディレクトリに、Screeningをオフに
EMPTY_MEM=$(mktemp -d)
mkdir -p "$EMPTY_MEM/topics" "$EMPTY_MEM/logs"
touch "$EMPTY_MEM/MEMORY.md"

for task_def in "${TASKS[@]}"; do
  IFS='|' read -r task_id category prompt <<< "$task_def"
  echo "  [$task_id] $category..."

  START_MS=$(($(date +%s%N) / 1000000))
  OUTPUT=$(
    RELVETIA_MEMORY_DIR="$EMPTY_MEM" \
    RELVETIA_SCREENING_MEMORY=0 \
    RELVETIA_SCREENING_SEARCH=0 \
    ECC_SKIP_OBSERVE=1 \
    claude --model "$MODEL" --max-turns $MAX_TURNS --print -p "$prompt" 2>/dev/null || true
  )
  END_MS=$(($(date +%s%N) / 1000000))
  DURATION=$((END_MS - START_MS))

  cat > "$RESULTS_DIR/${task_id}_vanilla.json" << ENDJSON
{
  "taskId": "$task_id",
  "category": "$category",
  "condition": "vanilla",
  "prompt": $(echo "$prompt" | jq -Rs .),
  "output": $(echo "$OUTPUT" | jq -Rs .),
  "outputChars": ${#OUTPUT},
  "durationMs": $DURATION,
  "timestamp": "$(date -Iseconds)"
}
ENDJSON

  echo "    Done (${DURATION}ms, ${#OUTPUT} chars)"
done

# クリーンアップ
rm -rf "$EMPTY_MEM"

echo ""
echo "=== Benchmark Complete ==="
echo "Results saved to: $RESULTS_DIR"
echo ""
echo "Next step: Run the scoring prompt to evaluate results"
```

---

## Step 4: 結果の採点

### 自動採点プロンプト

ベンチマーク結果を Claude に渡して採点させる。
以下のプロンプトを `claude -p` で実行する。

```bash
# 全結果を1ファイルにまとめる
cat "$RESULTS_DIR"/*.json | jq -s '.' > "$RESULTS_DIR/all_results.json"

# 採点プロンプト
claude --model sonnet --max-turns 3 --print -p "$(cat << 'SCORE_PROMPT'
あなたはAIメモリシステムのベンチマーク採点者です。

以下のJSON配列は、同一タスクを「Relvetia有効（メモリあり）」と「Relvetia無効（メモリなし）」の
2条件で実行した結果です。各タスクについて、以下の基準で0-100のスコアを付けてください。

## 採点基準

### Cross-Session Recall (A*)
- 100: 過去の決定を正確に想起し、具体的な詳細（ツール名、理由、日付）を含む
- 70: 過去の決定をおおよそ想起するが、詳細が不正確または欠落
- 30: 一般的な回答で、プロジェクト固有の情報がない
- 0: 「わかりません」「情報がありません」と回答

### Preference Adherence (B*)
- 100: ユーザーの好み（ツール、スタイル、規約）を正確に反映
- 70: 好みを部分的に反映するが、一部デフォルト/一般的な回答
- 30: 好みを無視し、一般的なベストプラクティスを回答
- 0: 好みと矛盾する回答

### Context Efficiency (C*)
- 100: プロジェクト固有の情報を簡潔かつ正確に回答
- 70: 正確だが冗長、または一部が一般論
- 30: ほぼ一般論で、プロジェクト固有の内容が少ない
- 0: 的外れな回答

### Prior Knowledge Accuracy (D*)
- 100: 最新の状態（移行後の技術）を正しく回答
- 70: 現状をおおよそ把握しているが、移行前の情報が混在
- 30: 古い情報と新しい情報が混在し、どちらが現在か不明
- 0: 完全に古い情報のみを回答

### Cold Start Recovery (E*)
- 100: 前回のセッション内容を具体的に想起し、継続作業を提案
- 70: 前回の作業をおおよそ把握
- 30: プロジェクトの概要のみで、前回の具体的作業は不明
- 0: 何も覚えていない

## 出力フォーマット

以下のJSON形式で出力してください:

```json
{
  "scores": [
    {
      "taskId": "A1",
      "category": "cross-session-recall",
      "relvetiaScore": 85,
      "vanillaScore": 10,
      "relvetiaReason": "Drizzle ORMとPostgreSQLを正確に回答、移行理由も記述",
      "vanillaReason": "一般的なDB選択肢を列挙するのみ"
    }
  ],
  "summary": {
    "categories": {
      "cross-session-recall": { "relvetia": 82, "vanilla": 15, "delta": 67 },
      ...
    },
    "overall": { "relvetia": 78, "vanilla": 20, "delta": 58 }
  }
}
```

## 採点対象データ

SCORE_PROMPT
)" < "$RESULTS_DIR/all_results.json"
```

---

## Step 5: レポート生成

### 手動レポートテンプレート

```markdown
# Relvetia Real-World Benchmark Report

Date: YYYY-MM-DD
Model: sonnet
Memory size: XX topics, YY log files, ZZ index entries

## Results

| Category              | Relvetia | Vanilla | Delta  |
|-----------------------|--------|---------|--------|
| Cross-Session Recall  |   82%  |    15%  | +67%   |
| Preference Adherence  |   91%  |    25%  | +66%   |
| Context Efficiency    |   85%  |    40%  | +45%   |
| Prior Knowledge       |   78%  |    50%  | +28%   |
| Cold Start Recovery   |   90%  |     5%  | +85%   |
|───────────────────────|────────|─────────|────────|
| **Overall**           | **85%**| **27%** |**+58%**|

## Key Findings

- ...

## Latency Overhead

| Condition | Avg Response Time |
|-----------|------------------|
| Relvetia    | XXXXms            |
| Vanilla   | XXXXms            |
| Delta     | +XXXms (+XX%)     |

## Recommendations

- ...
```

---

## 注意事項

### 公平性の確保

1. **同一モデル・同一パラメータ**: 両条件で `--model sonnet --max-turns 5` を統一
2. **順序効果の緩和**: 可能なら Relvetia→Vanilla と Vanilla→Relvetia の2回実行して平均
3. **キャッシュの影響**: 各タスク間で数秒の間隔を置く
4. **デーモンの停止**: ベンチマーク中は `pm2 stop relvetia-daemon` でデーモンを停止

### Relvetia無効化の方法

最も確実なのは **空のメモリディレクトリを指定** する方法:

```bash
EMPTY_MEM=$(mktemp -d)
mkdir -p "$EMPTY_MEM/topics" "$EMPTY_MEM/logs"
touch "$EMPTY_MEM/MEMORY.md"
RELVETIA_MEMORY_DIR="$EMPTY_MEM" claude -p "..."
```

これにより:
- SessionStart フック → 空の MEMORY.md を読み込む（情報なし）
- Stop フック → 空ディレクトリにログ書き込み（本番メモリ非汚染）
- 検索 → 何もヒットしない

### メモリの十分な蓄積

有意な差を出すには **最低2週間分のメモリ蓄積** が推奨:
- 5+ トピックファイル
- 10+ 日次ログファイル
- 20+ index.json エントリ

蓄積が少ない段階では差が出にくい。

### 統計的妥当性

- 各カテゴリ最低3タスク
- 理想的には2回以上の独立実行で平均を取る
- 採点者バイアスの軽減: LLM採点は結果のconditionラベルを隠して実施
  （JSONの "condition" フィールドを "A"/"B" に置換）

---

## クイックスタート（最小構成）

時間がない場合は以下の3タスクだけでも有意義な比較ができる:

```bash
# 1. 過去の決定を聞く（Recall）
claude -p "このプロジェクトの技術スタックを教えて"

# 2. 好みを確認（Preference）
claude -p "テスト環境をセットアップして"

# 3. 文脈を活用（Context）
claude -p "前回の作業の続きをしたい"
```

これを Relvetia 有効/無効で実行し、回答の質を比較するだけでも
メモリシステムの効果を体感できる。
