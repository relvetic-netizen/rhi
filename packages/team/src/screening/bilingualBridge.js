// Bilingual term bridge — cross-lingual token expansion for TF-IDF.
//
// TF-IDF requires vocabulary overlap to compute similarity. When a query
// is in English and the target document is in Japanese (or vice versa),
// there is zero overlap even for directly equivalent terms.
//
// CJK→English direction only: katakana words and kanji compounds in text
// produce English tokens, enabling cross-lingual matching. English→CJK is
// intentionally omitted to avoid inflating English document vectors.
//
// Vendored from upstream relvetia/screening/bilingualBridge.ts (see UPSTREAM.md).
// Logic-identical port; only TypeScript type annotations were stripped.

const KATAKANA_WORD_RE = /[゠-ヿー]{3,}/g
const KANJI_COMPOUND_RE = /[一-鿿]{2,}/g

const KATAKANA_TO_ENGLISH = new Map([
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

  ['トークン', ['token']],
  ['セッション', ['session']],
  ['パスワード', ['password']],
  ['クレデンシャル', ['credential']],

  ['スキーマ', ['schema']],
  ['クエリ', ['query']],
  ['レスポンス', ['response']],
  ['リクエスト', ['request']],
  ['エンドポイント', ['endpoint']],
  ['ペイロード', ['payload']],
  ['バリデーション', ['validation']],

  ['コンポーネント', ['component']],
  ['レンダリング', ['rendering']],
  ['アニメーション', ['animation']],
  ['レイアウト', ['layout']],
  ['ナビゲーション', ['navigation']],
  ['フォーム', ['form']],
  ['ボタン', ['button']],
  ['モーダル', ['modal']],
])

const KANJI_TO_ENGLISH = new Map([
  ['管理', ['management']],
  ['管理者', ['responsible', 'administrator']],
  ['担当', ['responsible', 'assigned']],
  ['担当者', ['responsible', 'assignee']],
  ['責任', ['responsible']],
  ['承認', ['approval']],

  ['監視', ['monitoring']],
  ['運用', ['operations']],
  ['障害', ['incident', 'failure']],
  ['復旧', ['recovery']],
  ['対応', ['handle']],

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

  ['認証', ['authentication']],
  ['認可', ['authorization']],
  ['権限', ['permission']],
  ['暗号', ['encryption']],

  ['参加', ['onboarding', 'join']],
  ['新規', ['new']],
  ['採用', ['hire', 'recruit']],

  ['集計', ['aggregation']],
  ['分析', ['analysis']],
  ['統計', ['statistics']],
  ['保存', ['save', 'store']],
  ['取得', ['fetch', 'retrieve']],

  ['品質', ['quality']],
  ['性能', ['performance']],
  ['効率', ['efficiency']],
  ['改善', ['improvement']],
  ['最適化', ['optimization']],
])

/**
 * Extract bilingual bridge tokens from text. CJK→English direction only.
 *
 * @param {string} text - Raw text to extract bridge tokens from
 * @param {string[]} _asciiTokens - Unused (kept for API compatibility)
 * @returns {string[]} - Additional English tokens from CJK content
 */
export function extractBridgeTokens(text, _asciiTokens) {
  const extra = []

  const katakanaMatches = text.match(KATAKANA_WORD_RE)
  if (katakanaMatches) {
    for (const kata of katakanaMatches) {
      const english = KATAKANA_TO_ENGLISH.get(kata)
      if (english) {
        extra.push(...english)
      }
    }
  }

  const kanjiMatches = text.match(KANJI_COMPOUND_RE)
  if (kanjiMatches) {
    for (const compound of kanjiMatches) {
      for (let len = compound.length; len >= 2; len--) {
        for (let start = 0; start <= compound.length - len; start++) {
          const sub = compound.slice(start, start + len)
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

  return [...new Set(extra)]
}
