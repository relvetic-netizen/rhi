# Notion ビュー設定ガイド

API経由で追加済みのFormula/リレーションを活用するビューの設定手順。
ビューはNotion UIでのみ作成可能です。

## 追加済みプロパティ（API設定完了）

| DB | プロパティ | 型 | 用途 |
|---|---|---|---|
| Tasks | 残り日数 | Formula | 期限までの日数（期限なし=999） |
| Tasks | 緊急度 | Formula | 🔴期限超過/🟡本日明日/🟠要注意/🟢余裕あり |
| Tasks | ステータス | Status | 未着手/進行中/**レビュー待ち**/**ブロック**/完了 |
| 発行請求書 | 入金遅延日数 | Formula | 支払期限からの超過日数（入金済み=0） |
| 経費 | 会計年月 | Formula | "YYYY-MM"形式 |
| 受領請求書 | 関連案件 | Relation→Projects | 案件別原価トラッキング |
| 日報 | 完了タスク数 | Number | Bot日報生成時に自動入力 |

---

## Phase 1 ビュー（優先度: 高 — 6ビュー）

### 1. Tasks DB「🔥 今週期限Board」

1. Tasks DBを開く → `+ Add a view` → **Board**
2. ビュー名: `🔥 今週期限`
3. Layout: Board → Group by: **ステータス**
4. Filter:
   - `期限` **is on or before** → `1 week from now`
   - AND `ステータス` **is not** → `完了`
5. Sort: `期限` Ascending
6. Properties（表示ON）: ステータス, 期限, 担当, 案件, 緊急度
7. Properties（表示OFF）: メモ, 工数h, 工程, 残り日数

### 2. Tasks DB「📅 カレンダー」

1. `+ Add a view` → **Calendar**
2. ビュー名: `📅 カレンダー`
3. Calendar by: **期限**
4. Filter: `ステータス` **is not** → `完了`
5. Properties: 担当, 案件, 緊急度

### 3. Projects DB「🗂️ 案件カンバン」

1. Projects DBを開く → `+ Add a view` → **Board**
2. ビュー名: `🗂️ 案件カンバン`
3. Group by: **ステータス**
4. Filter: `ステータス` **is not** → `完了`
5. Sort: `優先度` Descending → `締切` Ascending
6. Properties: 締切, 優先度, カテゴリ, クライアント

### 4. 発行請求書DB「💰 未入金一覧」

1. 発行請求書DBを開く → `+ Add a view` → **Table**
2. ビュー名: `💰 未入金一覧`
3. Filter:
   - `ステータス` **is** → `送信済み`
   - OR `ステータス` **is** → `期限超過`
4. Sort: `入金遅延日数` Descending
5. Properties: 請求書番号, 取引先, 合計金額, 支払期限, 入金遅延日数, ステータス
6. Summary row: 合計金額の **Sum** を表示

### 5. 経費DB「🏷️ カテゴリ別」

1. 経費DBを開く → `+ Add a view` → **Board**
2. ビュー名: `🏷️ カテゴリ別`
3. Group by: **カテゴリ**
4. Filter: `会計年月` **is** → 今月（例: `2026-04`）
5. Summary: 各列の下部に金額の **Sum** を表示
6. Properties: 摘要, 金額, 日付

### 6. 日報DB「📝 最新Gallery」

1. 日報DBを開く → `+ Add a view` → **Gallery**
2. ビュー名: `📝 最新`
3. Card preview: **Page content**
4. Card size: **Small**
5. Sort: `作成日時` Descending
6. Properties: 日付, サマリー

---

## トップページ ダッシュボード化

RHI Operationsページに **Linked Database View** を追加して、上記ビューをダッシュボードとして表示。

### 手順

1. RHI Operationsページを開く
2. 「📋 案件管理」セクションの上（calloutの直後）にカーソルを置く
3. `/linked` と入力 → `Linked view of database` を選択
4. Tasks DBを選択 → 作成済みの「🔥 今週期限」ビューを選択
5. ブロック幅を Full width に設定
6. 同様に以下を追加:
   - 発行請求書 → 「💰 未入金一覧」
   - Projects → 「🗂️ 案件カンバン」
   - 日報 → 「📝 最新」
7. セクション順を以下に調整:
   ```
   🤖 callout
   ■ 🔥 今日のアクション（Tasks Linked View）
   ■ 💰 未入金（発行請求書 Linked View）
   ■ 📋 案件管理 → Projects/Tasks DB
   ■ 📁 プロジェクト詳細
   ■ 📝 レポート → 日報 Linked View + DB
   ■ 💰 経理 → 各DB
   ```

---

## Phase 2 ビュー（将来追加）

| DB | ビュー名 | 種類 | 用途 |
|---|---|---|---|
| Tasks | 📊 ガントチャート | Timeline | 開始日〜期限の可視化 |
| Tasks | 👤 担当者別 | Board (担当列) | 外注メンバーのワークロード |
| Projects | 📅 締切カレンダー | Calendar (締切) | 案件スケジュール俯瞰 |
| 経費 | 🧾 確定申告用 | Table | 勘定科目別、年次フィルター |
| 受領請求書 | 📥 未処理 | Table | 支払期限順、要対応一覧 |

---

## 外注メンバー向け共有ページ（将来）

1. 新規ページ「クリエイタータスクボード」を作成
2. Linked DB: Tasks → 担当者フィルター付きBoard
3. ページ権限: Can comment（編集不可）
4. 各外注メンバーにページを共有
