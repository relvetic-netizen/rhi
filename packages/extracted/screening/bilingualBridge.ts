// Bilingual term bridge — cross-lingual token expansion for TF-IDF.
//
// TF-IDF requires vocabulary overlap to compute similarity. When a query
// is in English and the target document is in Japanese (or vice versa),
// there is zero overlap even for directly equivalent terms:
//   "database" vs "データベース" → cosine similarity = 0
//
// This module provides CJK→English bridges (unidirectional):
//   1. Katakana → English: technical terms that are transliterated
//   2. Kanji → English: common compound terms with English equivalents
//
// Applied during tokenization: katakana words and kanji compounds in
// text produce English tokens, enabling cross-lingual matching.
// English→CJK direction is intentionally omitted to avoid inflating
// English document vectors (which dilutes cosine similarity).
//
// The bridge is curated for software engineering vocabulary — the domain
// of the Relvetia memory system. This is NOT a general-purpose dictionary.

// ---------------------------------------------------------------------------
// Katakana word extraction
// ---------------------------------------------------------------------------

const KATAKANA_WORD_RE = /[\u30a0-\u30ff\u30fc]{3,}/g
const KANJI_COMPOUND_RE = /[\u4e00-\u9fff]{2,}/g

// ---------------------------------------------------------------------------
// Katakana ↔ English bridge
// ---------------------------------------------------------------------------

// Map: katakana word → English term(s)
// Only includes terms commonly used in software engineering contexts.
const KATAKANA_TO_ENGLISH = new Map<string, string[]>([
  // Infrastructure & platforms
  ['データベース', ['database']],
  ['サーバー', ['server']],
  ['サーバ', ['server']],
  ['クライアント', ['client']],
  ['クラウド', ['cloud']],
  ['コンテナ', ['container']],
  ['クラスタ', ['cluster']],
  ['クラスター', ['cluster']],
  ['キャッシュ', ['cache']],
  ['プロキシ', ['proxy']],
  ['ゲートウェイ', ['gateway']],
  ['ストレージ', ['storage']],
  ['インスタンス', ['instance']],
  ['インフラ', ['infrastructure']],
  ['ミドルウェア', ['middleware']],
  ['プロセス', ['process']],

  // Development
  ['フレームワーク', ['framework']],
  ['ライブラリ', ['library']],
  ['コンポーネント', ['component']],
  ['モジュール', ['module']],
  ['パッケージ', ['package']],
  ['フロントエンド', ['frontend']],
  ['バックエンド', ['backend']],
  ['テンプレート', ['template']],
  ['インターフェース', ['interface']],
  ['アーキテクチャ', ['architecture']],
  ['リファクタリング', ['refactoring']],
  ['リファクタ', ['refactor']],
  ['マイグレーション', ['migration']],
  ['デプロイ', ['deploy']],
  ['デプロイメント', ['deployment']],
  ['ビルド', ['build']],
  ['テスト', ['test']],
  ['デバッグ', ['debug']],
  ['コード', ['code']],
  ['スクリプト', ['script']],
  ['バッチ', ['batch']],

  // Quality & operations
  ['パフォーマンス', ['performance']],
  ['セキュリティ', ['security']],
  ['モニタリング', ['monitoring']],
  ['メトリクス', ['metrics']],
  ['ダッシュボード', ['dashboard']],
  ['ログ', ['log']],
  ['アラート', ['alert']],
  ['インシデント', ['incident']],
  ['バックアップ', ['backup']],
  ['リストア', ['restore']],
  ['スケーリング', ['scaling']],
  ['レイテンシ', ['latency']],
  ['レイテンシー', ['latency']],
  ['スループット', ['throughput']],

  // People & process
  ['メンバー', ['member']],
  ['チーム', ['team']],
  ['マネージャ', ['manager']],
  ['マネージャー', ['manager']],
  ['エンジニア', ['engineer']],
  ['レビュー', ['review']],
  ['レビュアー', ['reviewer']],
  ['スプリント', ['sprint']],
  ['タスク', ['task']],
  ['チケット', ['ticket']],
  ['プロジェクト', ['project']],
  ['ミーティング', ['meeting']],
  ['オンボーディング', ['onboarding']],

  // Auth & security
  ['トークン', ['token']],
  ['セッション', ['session']],
  ['パスワード', ['password']],
  ['クレデンシャル', ['credential']],

  // Data & API
  ['スキーマ', ['schema']],
  ['クエリ', ['query']],
  ['レスポンス', ['response']],
  ['リクエスト', ['request']],
  ['エンドポイント', ['endpoint']],
  ['ペイロード', ['payload']],
  ['バリデーション', ['validation']],

  // UI & frontend
  ['コンポーネント', ['component']],
  ['レンダリング', ['rendering']],
  ['アニメーション', ['animation']],
  ['レイアウト', ['layout']],
  ['ナビゲーション', ['navigation']],
  ['フォーム', ['form']],
  ['ボタン', ['button']],
  ['モーダル', ['modal']],
])


// ---------------------------------------------------------------------------
// Kanji compound ↔ English bridge
// ---------------------------------------------------------------------------

// Map: kanji compound → English term(s).
// Covers common software engineering and workplace terms.
//
// IMPORTANT: Each entry is limited to at most 2 translations to prevent
// document vector norm inflation. Too many synonyms dilute cosine similarity,
// pushing matches below the screening threshold. The first term should be
// the most common/direct translation.
const KANJI_TO_ENGLISH = new Map<string, string[]>([
  // Roles & responsibility
  ['管理', ['management']],
  ['管理者', ['responsible', 'administrator']],
  ['担当', ['responsible', 'assigned']],
  ['担当者', ['responsible', 'assignee']],
  ['責任', ['responsible']],
  ['承認', ['approval']],

  // Monitoring & operations
  ['監視', ['monitoring']],
  ['運用', ['operations']],
  ['障害', ['incident', 'failure']],
  ['復旧', ['recovery']],
  ['対応', ['handle']],

  // Development
  ['変更', ['change']],
  ['修正', ['fix']],
  ['追加', ['add']],
  ['削除', ['delete', 'remove']],
  ['更新', ['update']],
  ['実装', ['implement']],
  ['実行', ['execute', 'run']],
  ['設計', ['design']],
  ['検索', ['search']],
  ['検証', ['validate', 'test']],
  ['確認', ['verify', 'check']],
  ['設定', ['config']],
  ['構築', ['build', 'setup']],
  ['接続', ['connect']],
  ['移行', ['migration']],
  ['導入', ['onboarding', 'adopt']],
  ['依頼', ['request', 'assign']],

  // Auth & security
  ['認証', ['authentication']],
  ['認可', ['authorization']],
  ['権限', ['permission']],
  ['暗号', ['encryption']],

  // People & team
  ['参加', ['onboarding', 'join']],
  ['新規', ['new']],
  ['採用', ['hire', 'recruit']],

  // Data
  ['集計', ['aggregation']],
  ['分析', ['analysis']],
  ['統計', ['statistics']],
  ['保存', ['save', 'store']],
  ['取得', ['fetch', 'retrieve']],

  // Quality
  ['品質', ['quality']],
  ['性能', ['performance']],
  ['効率', ['efficiency']],
  ['改善', ['improvement']],
  ['最適化', ['optimization']],
])


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract bilingual bridge tokens from text.
 *
 * CJK→English direction only: scans text for katakana words and kanji
 * compounds, returning their English equivalents as additional tokens.
 *
 * Why CJK→English only (not bidirectional)?
 * Adding CJK bigrams to English documents inflates their token vectors,
 * diluting cosine similarity and causing relevant documents to drop below
 * the screening threshold. CJK→English bridge is sufficient: Japanese
 * documents gain English tokens that match English queries directly.
 *
 * Example:
 *   "木村さんがデータベース管理者" produces extra tokens:
 *   ["database", "management", "admin", "manage", "administrator", "responsible", ...]
 *
 * @param text - Raw text to extract bridge tokens from
 * @param _asciiTokens - Unused (kept for API compatibility)
 * @returns Additional English tokens from CJK content
 */
export function extractBridgeTokens(
  text: string,
  _asciiTokens: string[],
): string[] {
  const extra: string[] = []

  // 1. Katakana → English
  const katakanaMatches = text.match(KATAKANA_WORD_RE)
  if (katakanaMatches) {
    for (const kata of katakanaMatches) {
      const english = KATAKANA_TO_ENGLISH.get(kata)
      if (english) {
        extra.push(...english)
      }
    }
  }

  // 2. Kanji → English (exact match + substring with negation filter)
  // Try full compound first, then substrings of length ≥ 2.
  // Skip substrings that start with a negation prefix (非/不/未/無),
  // which inverts meaning: "非対応" (not-compatible) ≠ "対応" (compatible).
  const kanjiMatches = text.match(KANJI_COMPOUND_RE)
  if (kanjiMatches) {
    for (const compound of kanjiMatches) {
      for (let len = compound.length; len >= 2; len--) {
        for (let start = 0; start <= compound.length - len; start++) {
          const sub = compound.slice(start, start + len)
          // Skip if original compound starts with negation prefix
          // and the sub-match starts after it
          if (start > 0) {
            const prefix = compound[start - 1]
            if (prefix === '非' || prefix === '不' || prefix === '未' || prefix === '無') {
              continue
            }
          }
          const english = KANJI_TO_ENGLISH.get(sub)
          if (english) {
            extra.push(...english)
          }
        }
      }
    }
  }

  // Deduplicate bridge tokens to minimize norm inflation.
  return [...new Set(extra)]
}
