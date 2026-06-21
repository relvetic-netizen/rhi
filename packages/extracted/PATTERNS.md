# RELVETIA 再利用可能な設計パターン

## 1. Dead Code Elimination (DCE) パターン

ビルド時にフィーチャーフラグで未使用コードを完全除去する。

```typescript
// Bunのbuild-time feature flagを使用
import { feature } from 'bun:bundle'

// 条件付きモジュールロード
const assistantModule = feature('RELVETIA')
  ? require('./assistant/index.js') as typeof import('./assistant/index.js')
  : null;

// 使用側 - Bunが定数畳み込みで除去
if (feature('RELVETIA') && assistantModule?.someMethod()) {
  // RELVETIA無効ビルドではこのブロック全体が消える
}
```

**ポイント**: `feature()` を最上位条件に置くことで、Bunの定数畳み込みが効く。
関数呼び出しを条件に使うと畳み込みが効かない。

## 2. Entitlement + Opt-In 分離パターン

権限チェック（使えるか）とユーザー選択（使うか）を分離する。

```typescript
// 権限: ユーザーがこの機能を使う資格があるか
function isBriefEntitled(): boolean {
  return getRelvetiaActive() ||
    isEnvTruthy(process.env.CLAUDE_CODE_BRIEF) ||
    getFeatureValue_CACHED_WITH_REFRESH('tengu_relvetia_brief', false, 5_MIN);
}

// 有効化: このセッションで実際に有効か
function isBriefEnabled(): boolean {
  return (getRelvetiaActive() || getUserMsgOptIn()) && isBriefEntitled();
}
```

**活用場面**:
- 段階的ロールアウト（一部ユーザーにのみ権限付与）
- キルスイッチ（権限を剥奪して即座に無効化）
- 開発テスト（環境変数で権限バイパス）

## 3. GrowthBook キャッシュ付きリフレッシュ

再起動なしでフィーチャーフラグを更新する。

```typescript
// 5分間キャッシュ、バックグラウンドで更新
function isRelvetiaCronEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON) &&
    getFeatureValue_CACHED_WITH_REFRESH(
      'tengu_relvetia_cron',
      true,     // デフォルト値（GB無効環境用）
      5 * 60 * 1000  // リフレッシュ間隔
    );
}
```

**設計判断**:
- デフォルト `true` → GB無効環境（Bedrock/Vertex）でも動作
- 環境変数が最優先 → ローカルオーバーライド可能
- GB無効時は即時キャッシュヒット（ネットワーク不要）

## 4. プラガブルスケジューラ

REPL/デーモンの異なるコンテキストで同じスケジューラコアを共有する。

```typescript
type CronSchedulerOptions = {
  onFire: (prompt: string) => void;        // REPLハンドラ
  onFireTask?: (task: CronTask) => void;   // デーモンハンドラ（フルタスク情報）
  onMissed?: (tasks: CronTask[]) => void;  // 見逃しタスク通知
  assistantMode?: boolean;                 // ゲートバイパス
  dir?: string;                            // 外部ディレクトリ指定
  lockIdentity?: string;                   // デーモン用安定ID
  getJitterConfig?: () => CronJitterConfig; // ライブ設定更新
  isKilled?: () => boolean;                // リモートキルスイッチ
  filter?: (t: CronTask) => boolean;       // タスクフィルタ
};
```

**設計の要点**:
- コールバック注入でコア/UI分離
- オプショナルパラメータで段階的な機能追加
- `dir` で bootstrap state への依存を断つ（SDK用）

## 5. ジッター分散 (Thundering Herd 防止)

多数のクライアントが同時刻にAPIを叩くのを防ぐ。

```typescript
// タスクIDからハッシュベースの決定論的ジッター生成
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}

// Recurring: 次回実行時刻 + 期間の10%以内のジッター (最大15分)
function jitteredNextCronRunMs(cron, fromMs, taskId, cfg) {
  const t1 = nextCronRunMs(cron, fromMs);
  const t2 = nextCronRunMs(cron, t1);
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  );
  return t1 + jitter;
}

// One-shot: 壁時計境界(:00, :30)で最大90秒早期実行
function oneShotJitteredNextCronRunMs(cron, fromMs, taskId, cfg) {
  const t1 = nextCronRunMs(cron, fromMs);
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1;
  const lead = cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs);
  return Math.max(t1 - lead, fromMs);
}
```

**ポイント**:
- UUIDベースで再起動しても同じジッター値（決定論的）
- Recurring は遅延方向、One-shot は早期方向（ユーザー期待に沿う）
- 運用中にジッター設定をGrowthBookで即時変更可能

## 6. ファイル監視 + ポーリングのハイブリッド

chokidarのファイル監視とsetIntervalの定期チェックを組み合わせる。

```typescript
// ファイル変更を検知して即座にリロード
watcher = chokidar.watch(path, {
  persistent: false,        // プロセスを維持しない
  ignoreInitial: true,      // 初回は無視
  awaitWriteFinish: { stabilityThreshold: 300 },  // 書き込み完了を待つ
  ignorePermissionErrors: true,
});
watcher.on('change', () => void load(false));

// 1秒ごとにタスク実行チェック
checkTimer = setInterval(check, 1000);
checkTimer.unref?.();  // このタイマーだけではプロセスを維持しない
```

## 7. プロセス間ロック

複数セッションが同じタスクを二重実行するのを防ぐ。

```typescript
// 起動時にロック取得を試みる
isOwner = await tryAcquireSchedulerLock(lockOpts);

// 取得できなければ定期的にプローブ（所有者がクラッシュした場合の引き継ぎ）
if (!isOwner) {
  lockProbeTimer = setInterval(() => {
    void tryAcquireSchedulerLock(lockOpts).then(owned => {
      if (owned) {
        isOwner = true;
        clearInterval(lockProbeTimer);
      }
    });
  }, 5000);
  lockProbeTimer.unref?.();
}
```

## 8. 追記専用メモリシステム

長期セッションでの知識管理パターン。

```
~/.claude/agents/<agent>/logs/YYYY/MM/YYYY-MM-DD.md  ← 追記専用
~/.claude/agents/<agent>/MEMORY.md                    ← 夜間蒸留結果
```

**ルール**:
- ログは追記のみ、書き換え・再整理禁止
- タイムスタンプ付きバレットエントリ
- 日付ロールオーバー時は新ファイルに切り替え
- 夜間の `/dream` スキルがログをトピック別に蒸留

**記録すべきもの**:
- ユーザーの修正・好み
- プロジェクトのコンテキスト（期限、インシデント、決定の根拠）
- 外部システムへのポインタ
- ユーザーが明示的に記憶を依頼したもの

## 9. Zod スキーマによる設定バリデーション

外部設定のバリデーションにZodを使い、不正値はデフォルトにフォールバック。

```typescript
const cronJitterConfigSchema = z.object({
  recurringFrac: z.number().min(0).max(1),
  recurringCapMs: z.number().int().min(0).max(HALF_HOUR_MS),
  oneShotMaxMs: z.number().int().min(0).max(HALF_HOUR_MS),
  oneShotFloorMs: z.number().int().min(0).max(HALF_HOUR_MS),
  oneShotMinuteMod: z.number().int().min(1).max(60),
  recurringMaxAgeMs: z.number().int().min(0).max(THIRTY_DAYS_MS)
    .default(DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs),
}).refine(c => c.oneShotFloorMs <= c.oneShotMaxMs);

function getCronJitterConfig(): CronJitterConfig {
  const raw = fetchFromRemote('config_key', DEFAULT, REFRESH_MS);
  const parsed = cronJitterConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CRON_JITTER_CONFIG;
}
```

**ポイント**:
- `.default()` で既存設定との後方互換性
- `.refine()` でフィールド間の整合性チェック
- `safeParse` + フォールバックで不正設定をサイレントに無視

## 10. Screening（絶対閾値フィルタリング）

論文「Screening Is Enough」(arXiv:2604.01178) のTrim-and-Square活性化関数を
テキスト関連性フィルタリングに適用する。Softmaxの相対評価（合計=1制約）による
希薄化問題を解決し、無関係なアイテムを**完全にゼロ**にする。

```typescript
// Trim-and-Square: 論文の核心メカニズム
// α = [max(1 - r·(1 - s), 0)]²
// s < 1 - 1/r のとき厳密にゼロ（完全拒絶）
function trimAndSquare(similarity: number, r: number): number {
  const raw = 1 - r * (1 - similarity);
  const trimmed = Math.max(raw, 0);
  return trimmed * trimmed;
}

// TF-IDFコサイン類似度 + Trim-and-Squareでスクリーニング
function screenItems<T>(
  items: T[],
  getText: (item: T) => string,
  query: string,
  config: ScreeningConfig,
): ScoredItem<T>[] {
  const idfMap = buildIdfMap(items.map(getText).concat([query]));
  const queryVec = tfidfVector(query, idfMap);
  return items
    .map(item => ({
      item,
      score: trimAndSquare(
        cosineSimilarity(queryVec, tfidfVector(getText(item), idfMap)),
        config.sharpness,
      ),
    }))
    .filter(s => s.score > 0)  // 閾値以下は完全除外
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxResults);
}
```

**適用場面**:
- メモリ検索の事前フィルタ（200件 → ~30件、Sonnet呼び出し前のノイズ除去）
- コンテキスト圧縮の関連性スコアリング（時系列だけでなく関連性で判断）
- 全文検索のgrepリプレース（キーワード一致ではなく関連性閾値）

**設計判断**:
- TF-IDF（埋め込みモデル不要、純粋な数学、外部依存ゼロ）
- 事前フィルタ（Sonnet置換ではない: "CI/CD" vs "デプロイ"の意味的類似はSonnetが捕捉）
- 安全弁: 全件拒絶時はフォールバックで全件返却（サイレントな情報損失を防止）
- Zod設定スキーマ（パターン#9）で閾値をランタイム変更可能
