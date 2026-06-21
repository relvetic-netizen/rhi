# relvetia-team — context 消費削減 P1 実装計画 (v3.1)

## 経緯
- **v1**: default limit + byte budget cap + screening。内部 8 軸 `/plan-qa` で P0×4 検出。
- **v2**: `consumeInbox` atomic 化で race 解消を試みた。**Codex 独立 review が P0×3 を発見**(consumeInbox vs writeToMailbox の lockless append race / 巨大 item 全文回収の偽約束 / `requires_approval` cap 例外の二重破綻)。
- **v3 (F+)**: 設計思想を「race を解消」から「**race を増幅しない**」に転換。Pi×2 critique 反映。
- **v3.1**: v3 を `/plan-qa` 再走 → P0×4 + 3 軸独立収束で「`requires_approval` fix を別 issue 化」+「Intl.Segmenter 採用」+「IDF/RRF/emitEvent を素朴化」+「notice 位置先頭化」+「`before` 計測手段(`RELVETIA_CAP_DISABLE` env)」+「MCP InMemoryTransport E2E」を反映。

## GEHV
- **Goal**: relvetia-team MCP tool 戻り値の context 消費を構造的に bound する。**80KB/call(`team_get_session`)を最小サーフェスで解消** + briefing/search の無条件 dump を screening で絞る。
- **Evidence**: 調査レポート + 対象 5 src + screening 4 ファイル + Codex P0×3 + Pi×2 critique + plan-qa v3 8 軸並列。
- **Harness**: `npm test`(`node --test`)+ **byte 計測 harness**(`RELVETIA_CAP_DISABLE=1` で cap bypass → before/after 同一 fixture)+ **MCP `InMemoryTransport` E2E**(`structuredContent` が envelope に乗ることを assert)+ **golden fixture**(upstream commit hash 埋込で drift 検知)+ **race regression stress test**(PR-2 merge gate)。
- **Verification**: 全 test green の commit hash + `sync-readme.mjs --check` PASS + byte report JSON を `gh pr edit --body-file` で PR 説明に自動転記 + `/plan-qa` ACCEPT。

---

## 0. 現状の確定事実

| 対象 | 現状 | 問題 / 制約 |
|---|---|---|
| `team_get_session` → `getItems()` (sessions.js:27) | `limit` opt あるが default なし。未指定で全履歴 | **80KB/1call 実測** |
| `team_read_inbox` → `readUnreadMessages()` + `markMessagesAsRead()` | 別 lock の 2 操作 | **`writeToMailbox` hot path append は LOCKLESS**(mailbox.js:285-309、O_APPEND の perf 最適化、p99 1259ms → single-digit の根拠)。`markMessagesAsRead` の read-rewrite との pre-existing race。本 P1 では**増幅しない**ことを最優先制約 |
| `team_build_briefing` → `buildBriefing()` (briefing.js:52) | finding 15 + knowledge 20 + essential/consistency 群は**上限なし無条件 dump**。`topics_of_interest` は finding のみ素朴 substring filter | 1-3k tokens / call |
| `team_search_memory` → `searchMemory()` (memory.js:274) | boolean matcher → timestamp sort → default limit 50。**関連度ランキングなし** | 50 件 × 大 content で context bloat |

### 呼び出し元(plan-qa Axis 3 検証済)

| 関数 | production caller | test caller(直接) | 計画での扱い |
|---|---|---|---|
| `readUnreadMessages` | `index.js:138/259`・`prompt-template.js:37` | `mailbox.test.js:72,78,90`・`guardrails.test.js:152` | **完全不変** |
| `markMessagesAsRead` | `index.js:266` | `mailbox.test.js:88,100,101,110`・`sessions.test.js:28,47` | **完全不変** |
| `getItems` | `index.js:496` | `sessions.test.js:31,39,49,59,65,77,93` | **不変**(handler 内で戻り値 clone-truncate のみ) |
| `buildBriefing` | `index.js:1123`・`briefing.js:147`(primeAgent) | `briefing.test.js` 多数 | internal で screening 追加、シグネチャ不変 |
| `searchMemory` | `index.js:1056` | `memory.test.js` 多数 | internal で screening 追加、シグネチャ不変 |
| `writeToMailbox` | `mailbox.js` 内 + 全 send 系 | 多数 | **v3.1 では完全不変**(v3 の `requires_approval` 永続化 1 行 fix を**別 issue に分離**) |

### CLAUDE.md / README.md の更新対象行(plan-qa Axis 3 検証済)

| tool | CLAUDE.md | README.md |
|---|---|---|
| `team_read_inbox` | L40 | L90 |
| `team_get_session` | L54 | L105 |
| `team_search_memory` | L80 | L126 |
| `team_build_briefing` | L81 | L127 |

注: `sync-readme.mjs:31` の regex は `` /`([^`(\s]+)\(/ `` で **tool 名のみ check、signature 行は不問**。tool 数(38)も不変なら drift なし。

### 環境制約
- Node ESM、no build step、test = `node --test`、zod ^4.3.6(v4 は `.default()` が `.optional()` と併用しても OK)、`@modelcontextprotocol/sdk ^1.29.0`、`proper-lockfile`、tracing.js の `emitEvent` 既存。
- **Node v20+ は `Intl.Segmenter` 標準**(plan-qa Axis 4 確認、grapheme-cluster safe truncate の唯一の標準解)。

---

## 1. 設計原則(1 条主軸 + 補足)

**主軸**: **handler layer でのみ truncate / cap し、disk・mailbox state・marking 経路は触らない。**

補足:
- 全 capped response は machine-readable(`structuredContent.truncated`)+ **可視 notice を先頭行**に出す(plan-qa Axis 5 FM-2 — LLM が末尾 notice を見落として rabbit hole 化するため)。
- 「多数小 message 累積」bound と `markMessagesAsRead` race fix は**本 P1 でやらない**、**deferred 明示**。
- truncation は `Intl.Segmenter` の grapheme 境界(plan-qa Axis 4)。

---

## 2. PR-1 — 80KB elephant 解消

### 2.1 `team_get_session` byte cap

**sessions.js**: 完全不変。

**index.js handler(:485-510)**:
- zod: `limit: z.number().int().min(0).max(1000).optional()`(`.max` で巨大数防止)、`.default()` は付けず handler で明示分岐(count-limit precedence を読みやすく)。`limit=0`=無制限の escape hatch は廃止(plan-qa Axis 4/7、非慣行)。
- handler 処理順:
  1. `items = await getItems(...)` 既存通り。
  2. **count-limit precedence**: 明示 `limit` は尊重(`getItems` 内で適用済)。
  3. **byte cap**: `Buffer.byteLength(formattedText, 'utf8')` 計測。`SESSION_RETURN_BUDGET_BYTES = 24_000`(handler 近傍 const、研究 doc リンク comment)超過時、**最古から item 単位で drop**(最新優先)。
  4. **巨大単独 item**: 1 件目が単独で budget 超 → その item の `text` を `truncateSafe()`(§2.4)で truncate して return clone に格納(disk 不変)。
  5. **可視 notice を出力の先頭行に**:
     ```
     [NOTICE: showing K of N items (M bytes / budget 24KB). Use team_get_session(limit=N) for explicit limit, or query inbox files directly for full text.]
     <session_item ...>...</session_item>
     ...
     ```
  6. `structuredContent: { truncated: true, omitted_count: N }` を tool result に付与(field を 2 個に縮減、plan-qa Axis 7)。
  7. cap 発火時 `emitEvent('memory.capped', { layer: 'session', team_name, agent_name, before_bytes, after_bytes, omitted_count })`(統一 1 種、Axis 7)。

### 2.2 `team_read_inbox` per-item truncation(handler layer のみ)

**`readUnreadMessages` / `markMessagesAsRead` / mailbox 内部は完全に触らない**。

**明示的に解消しない**(NC4 honest scope):
- **多数小 message 累積 case**: 100 件 × 500 bytes = 50KB が全部返り全部 mark される(現状と同じ)。bound には `consumeInbox` 的 redesign が必要 → **deferred PR-3**。

**index.js handler(:250-277)**:
- zod: 変更なし(`team_name`, `agent_name`, `peek`)。**`limit` パラメータも追加しない**(mark path 不変の制約で count limit は data loss を呼ぶ)。
- handler:
  1. `unread = await readUnreadMessages(team, agent)` 既存通り(guardrail 既存通り適用済)。
  2. 整形ループで各 `m.text` を `truncateSafe(m.text, INBOX_PER_ITEM_BUDGET_BYTES)`(8_000)に通す(clone 上、disk 不変)。
  3. **可視 notice を先頭行に**(truncate 発生時):
     ```
     [NOTICE: K of N message bodies truncated to fit 8KB/item. Original disk content unchanged.]
     <teammate_message ...>...</teammate_message>
     ```
  4. `structuredContent: { truncated: true, omitted_count: K }`(2 field)。
  5. **mark path 完全不変**: `if (!peek) await markMessagesAsRead(team, agent)` 従来通り。
  6. truncate 発火時 `emitEvent('memory.capped', { layer: 'inbox', team_name, agent_name, items_truncated })`。

### 2.3 `truncateSafe`(Intl.Segmenter ベース、handler 近傍 inline)

`src/index.js` 上部または handler 直前に **inline 配置**(plan-qa Axis 7 — 別ファイル不要、~15 行):
```js
const _segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function truncateSafe(text, maxBytes, marker = '…[truncated]') {
  if (typeof text !== 'string' || text.length === 0) return text ?? ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes > maxBytes) return ''
  const targetBytes = maxBytes - markerBytes
  let acc = 0, cut = 0, lastNewlineCut = -1
  for (const { segment, index } of _segmenter.segment(text)) {
    const bytes = Buffer.byteLength(segment, 'utf8')
    if (acc + bytes > targetBytes) break
    acc += bytes
    cut = index + segment.length
    if (segment === '\n' && acc >= targetBytes * 0.9) lastNewlineCut = cut
  }
  return text.slice(0, lastNewlineCut > -1 ? lastNewlineCut : cut) + marker
}
```

利点(plan-qa Axis 4 反映):
- **grapheme cluster safe**: ZWJ emoji / combining mark / surrogate pair を全て守る。
- code-point 手回しより簡潔・標準準拠・lastNewlineIdx の off-by-one(plan-qa Axis 5 FM-4)も解消。
- `Intl.Segmenter` は ICU の有限状態機械、80KB でも実用速度。

**head-tail truncation**(構造的破壊軽減、plan-qa Axis 5 FM-3)は P2 候補。本 PR は head のみ(JSON/code block が中央で切れる可能性は notice + structuredContent で signaling 済)。

### 2.4 byte 計測 harness(plan-qa Axis 6 P0-1/P0-2)

**`RELVETIA_CAP_DISABLE=1`** env: handler の cap ロジックを完全 bypass(dev-only path)。同一 fixture で before/after を取得可能。

`src/__tests__/byte-measurement.test.js`(新規):
1. **80KB 級 fixture** を `src/__tests__/fixtures/large-session.jsonl` に作成(明示: item 12 件 × 平均 6.7KB、JST 日本語 message body 中心)。
2. `RELVETIA_CAP_DISABLE=1` で `team_get_session` を呼び `before_bytes` 取得。
3. cap 有効で同呼出し `after_bytes` 取得。
4. assert: `after_bytes <= SESSION_RETURN_BUDGET_BYTES` + `before_bytes > 80_000`。
5. `console.log(JSON.stringify({ before, after, reduction_pct }))` → CI で `vitest --reporter=json` で capture → `gh pr edit --body-file` で PR 説明に転記(plan-qa Axis 6 — 手動転記禁止)。

`src/__tests__/mcp-envelope.test.js`(新規、plan-qa Axis 6 P0-2):
- `@modelcontextprotocol/sdk` の `InMemoryTransport` で MCP server 起動。
- `client.callTool('team_get_session', ...)` で全 CallToolResult を取得。
- assert: `result.structuredContent.truncated === true` + `result.content[0].text.startsWith('[NOTICE:')`。
- これで「handler 内のオブジェクトが MCP envelope に乗る」ことを E2E で証明。

### 2.5 PR-1 のテスト一覧

| ファイル | test 内容 |
|---|---|
| `src/__tests__/truncate-safe.test.js`(新規、inline 化に伴い test 用 export) | null/undefined/non-string/empty → return as-is / マルチバイト・ASCII・混在で maxBytes 遵守 / marker > maxBytes で空文字 / ZWJ emoji `👨‍👩‍👧` を分断しない / newline 境界優先 |
| `byte-measurement.test.js`(新規) | §2.4 |
| `mcp-envelope.test.js`(新規) | §2.4 |
| `sessions.test.js`(拡張) | 明示 limit 不変 / 未指定+巨大 history で byte cap 発火・最古 drop / 巨大単独 item で text 切り詰め + disk 不変再 read 確認 / `structuredContent.truncated` 露出 / **先頭 notice** assert |
| `mailbox.test.js`(拡張) | per-item truncate: 巨大単独 message → 切り詰めて返す / `markMessagesAsRead` が**従来通り全件**呼ばれる(回帰)/ disk 上 `text` field 不変 / **`emitEvent('memory.capped', ...)` 発火** assert |
| `guardrails.test.js` / `prompt-template.test.js`(確認のみ) | 既存挙動不変 |

`sync-readme.mjs --check`: tool 数 + tool 名 不変、test 数のみ要更新(CLAUDE.md `## MCP Tools (38 total)` の N と test 数の表記があれば)。

### 2.6 PR-1 規模見積

net add ~150 行(v3 の ~200 から削減:`src/text-utils.js` 廃止 / `requires_approval` fix 削除 / structuredContent 5→2 field / emitEvent 5→1 種)。

---

## 3. PR-2 — briefing / search の bound + screening

### 3.1 `team_build_briefing` + screening

**現状の盲点**: `topics_of_interest` 未指定時の 15+20 dump がそのまま残る。

**briefing.js `buildBriefing()`**:
- `topics_of_interest` 指定時: §3.3 の screening で finding+knowledge をランキング → 既存 maxResults (15/20) → 出力 byte cap。
- 未指定時: **現状の recent-N 維持**。**output 全体への絶対 byte cap は本 PR で固定値を入れず、PR-1 の byte-measurement harness で現行 briefing p99 を実測してから判断**(plan-qa Axis 7 — 発火しない cap はコードと test を腐らせる)。実測で `>= 24KB` の発火可能性が確認できれば PR-2 内で cap 追加、それ以下なら未追加で merge。
- essential / consistency 群は screening 対象外のまま(状態系)。
- cap 発火時 `emitEvent('memory.capped', { layer: 'briefing', ... })`(統一 1 種、§2 と同じ event 名)。

### 3.2 `team_search_memory` + screening

**memory.js `searchMemory()`**:
- boolean matcher(`makeMatcher`)は**ハードフィルタとして残す**(NOT 演算子等は screening で表現不可)。
- matcher 通過後の survivors を `screenItems`(§3.3)で**関連度ランキング** → `maxResults` 適用。`boostRecency` 有効で recency 混合。
- **IDF コーパスは素朴な単一 corpus で start**(plan-qa Axis 7 — RRF + scope 別 IDF は observed leak が出てから):
  - 全 survivors を 1 コーパスで IDF 構築 → screening → score sort → final `slice(limit)`。
  - cross-corpus score scale 比較不能の懸念(Codex)は単一 IDF で構造的に解消(全て同 IDF base)。
  - scope 別 IDF + RRF は **deferred**(observed leak 例で追加)。
- **空クエリ / トークン 0 件クエリ**: screening スキップ、現状の timestamp sort 維持。
- default limit: `z.number().default(20).max(200)`(v3 通り)。
- 結果 list を formatted 化後 `SEARCH_RETURN_BUDGET_BYTES = 16_000` で再 cap、score 上位を残す。
- 発火時 `emitEvent('memory.capped', { layer: 'search', excluded_count, omitted_count })`。

**index.js handler(:1047-1054)**: `limit` の default を 20 に、`.max(200)` 追加。description に「関連度順(screening)」追記。

### 3.3 screening vendoring(`src/screening/`)

**ポート対象**(`relvetia-extracted/screening/` → `relvetia-team/src/screening/`):
- `screening.ts` → `screening.js` — **明示 export list**:
  - **ポートする**(TF-IDF 核): `tokenize`, `buildIdfMap`, `tfidfVector`, `cosineSimilarity`, `trimAndSquare`, `sharpnessFromThreshold`, `recencyFactor`, `screenItems`(8 関数)
  - **ポートしない**: `screenItemsBM25`, `bm25Score`, `buildBm25CorpusStats`, `setBm25Diagnostics`, `setScreeningDiagnostics`, 全 `*Stats` 型, `Bm25*` 型(P1 未使用、Codex 確認済)
- `stopwords.ts` / `stemmer.ts` / `bilingualBridge.ts` → 各 `.js`(自己完結確認済、Pi×2 が日英混在用途で full core 支持)
- `screeningConfig.ts` は**ポートせず**、定数を `src/screening/config.js` プレーン JS:
  ```js
  export const SEARCH_THRESHOLD = 0.10
  export const SEARCH_MAX_RESULTS = 20
  export const BRIEFING_THRESHOLD = 0.10
  export const BRIEFING_FINDING_MAX = 15
  export const BRIEFING_KNOWLEDGE_MAX = 20
  export const RECENCY_HALF_LIFE_MS = 7 * 24 * 3600 * 1000
  ```

**変換スコープ**: 型注釈 + `export type` + generic 関数宣言 `<T>` + `items[i]!` 非 null assertion + `satisfies` + `as const` を除去(plan-qa Axis 4/Codex P1)。

**`src/screening/UPSTREAM.md`**(`skills/engineering/UPSTREAM.md` 既存形式準拠、plan-qa Axis 8 #2):
- upstream パス、ポート日、**license 状態**(同一作者 private workspace、外部公開不可)
- ポートした関数 list / 除外した関数 list
- **fixture 再生成手順**(下記 §3.4)

### 3.4 golden fixture(忠実性 contract、plan-qa Axis 6 P0-3)

**`tsx` を CI/devDep に常設しない**(plan-qa Axis 7 — 1 回生成して commit)。

手順を `UPSTREAM.md` に明記:
1. fixture 再生成が必要な時のみ `npx -p tsx@<exact-pin> tsx scripts/gen-screening-fixture.mjs` を手動実行(`tsx` は `npx -p` で one-shot 取得、package.json には足さない)。
2. script は upstream `~/workspace/relvetia/relvetia-extracted/screening/screening.ts` を import、代表 25 ケース(ASCII / 純 CJK / 日英混在 / 空 / 閾値境界 / recency / N≤1 コーパス / stopwords のみ)で `input → expected` を JSON 化。
3. **fixture 先頭に upstream commit hash + 生成日 + schema version**(plan-qa Axis 6 P0-3):
   ```json
   {
     "_meta": {
       "upstream_commit": "abc123def",
       "upstream_path": "relvetia-extracted/screening/screening.ts",
       "generated_at": "2026-05-16T12:00:00+09:00",
       "schema_version": 1
     },
     "cases": [...]
   }
   ```
4. `src/__tests__/screening.test.js` は vendored JS で再生し `expected` と deep-equal。
5. **CI step で `git -C ~/workspace/relvetia/relvetia-extracted rev-parse HEAD` と fixture の upstream_commit を照合 → 不一致なら warn**(blocking ではない、手動再生成 trigger 用)。

### 3.5 race regression stress test(plan-qa Axis 6 P1-4、PR-2 merge gate)

`src/__tests__/race-regression.test.js`(新規):
```
Promise.all([
  writeToMailbox × 50,
  team_read_inbox handler call × 30,
  markMessagesAsRead × 20,
]) を 100 iteration 走らせ、
書いた message 数 == (read 集合 + 未読残) を invariant として assert。
```
これで「v3.1 が pre-existing race を増幅していない」ことの数値根拠を残す。pre-existing race そのものは PR-3 で扱う。

### 3.6 PR-2 のテスト

| ファイル | test |
|---|---|
| `src/__tests__/screening.test.js`(新規) | §3.4 fixture 再生 deep-equal / 空クエリ→[] / 閾値以下→除外 / maxResults cap / N≤1 安全弁 |
| `briefing.test.js`(拡張) | topics 未指定→recent-N 維持 + briefing p99 byte 実測ログ / topics 指定→screening 経由 finding+knowledge / トークン 0 件→screening skip / essential 群無削減 |
| `memory.test.js`(拡張) | 空クエリ→timestamp 順維持 / 非空→screening 順 / boolean NOT がハードフィルタ / **単一 IDF コーパス**(RRF なし)/ limit default 20 / byte cap 発火 |
| `race-regression.test.js`(新規) | §3.5 |

### 3.7 PR-2 規模見積

net add ~900 行(v3 の ~1100 から削減:`tsx` devDep 不要 / scope 別 IDF + RRF を素朴 IDF に置換 / structuredContent + emitEvent 縮減)。

---

## 4. Deferred(別 PR / 別 issue、本 P1 では touch しない)

明示宣言:
- **`requires_approval` 永続化 fix**: cap exemption を v3.1 で実装しない以上、consumer が無い dead code persistence(plan-qa Axis 3/6/7 強収束で **PR-1 から削除**)。cap exemption や priority display を実装する別 issue と同時に bundle すべき。
- **`team_status` に `pending_approvals` 件数追加**(plan-qa Axis 8 #8): approval queue の sticky blocking 可視化、本 P1 とは別関心事。
- **`scope=all` の personal log 境界明文化 / `include_personal_logs` flag**(plan-qa Axis 8 #3): ACL 議論、別 PR。
- **PR-3 race fix**: `markMessagesAsRead` と `writeToMailbox` lockless append の race の構造的 fix(B compare-and-merge or 限定 lock 拡張)。専用 stress test + p99 benchmark。
- **多数小 message 累積 bound**: `consumeInbox` 的 redesign(read+cap+mark atomic)。
- **scope 別 IDF + RRF**: observed leak 実例が出てから(plan-qa Axis 7)。
- **buildBriefing 絶対 byte cap (32KB 等)**: 現行 briefing p99 実測(PR-1 harness)で発火可能性が示されたら追加(plan-qa Axis 7)。
- **head-tail truncate**: 巨大単独 item の構造破壊軽減(plan-qa Axis 5 FM-3)、P2。
- **searchMemory 閾値足切り**: 安全弁付き absolute threshold cutoff、P2。
- **MCP cursor pagination**: tool 戻り値の正式 page 分割、P2。
- **`structuredContent` vendor prefix (`_relvetia_`)**: MCP spec 衝突回避、P2(plan-qa Axis 4/8)。
- **`emitEvent` attrs に message body 含めない契約明記**: tracing.js 規約追加、P2(plan-qa Axis 8 #4)。

---

## 5. リスクと対応(v3.1)

| 項目 | v3 での扱い | v3.1 での対応 |
|---|---|---|
| 新規 rewrite path | v2 で consumeInbox → Codex P0 / v3 で廃止 | **継承**(handler layer のみ) |
| disk 上 mutation | v2 で disk 破壊 → Codex P0 / v3 で clone only | **継承** |
| silent truncation | v1/v2 で notice のみ → Pi G6 / v3 で signaling | **notice を先頭行に**(Axis 5 FM-2)+ `structuredContent.truncated` 2 field |
| 多数小 message 累積 | 認識なし | **deferred 明示** |
| multibyte 破断 | v2 で byte cap → Axis 5 P0 / v3 で code-point | **Intl.Segmenter で grapheme 境界**(Axis 4) |
| context 削減の測定 | v1/v2 で test green のみ → Axis 6 P0 / v3 で harness 言及 | **`RELVETIA_CAP_DISABLE` env で before/after 同一 fixture**、JSON report 自動転記 |
| screening MCP envelope 露出 | 認識なし | **MCP `InMemoryTransport` で E2E test**(Axis 6 P0-2) |
| screening ポート忠実性 | v2 で手移植 → Codex P1 / v3 で tsx fixture | **fixture に upstream commit hash 埋込**(Axis 6 P0-3)、tsx は CI 常設せず手動再生成 |
| screening IDF leak | v2 で同一コーパス → Codex P1 / v3 で scope 別 + RRF | **素朴単一 IDF**(YAGNI、Axis 7) |
| screening license | v2 で参照のみ → Axis 8 P1 / v3 で UPSTREAM.md | **継承**、既存 vendoring 慣行形式と整合 |
| `requires_approval` data corruption | v2/v3 で 1 行 fix | **削除 + 別 issue 化**(consumer なし dead code、Axis 3/6/7 強収束) |
| pre-existing race 増幅 | 認識なし | **race regression stress test を PR-2 merge gate に**(Axis 6 P1-4) |
| approval queue 滞留 | v2 で cap exemption → Codex P0 / v3 で廃止 | **deferred**(`team_status` の `pending_approvals` 件数追加、Axis 8 P1) |
| over-instrumentation | v3 で emitEvent 5 種 / structuredContent 5 field | **emitEvent 1 種(`memory.capped`)+ structuredContent 2 field**(Axis 7) |
| `src/text-utils.js` 過剰 | v3 で新規モジュール | **handler 近傍 inline**(Axis 7) |
| `tsx` devDep 常設 | v3 で `npm install --save-dev tsx` | **`npx -p` で one-shot 取得、devDep に足さない**(Axis 7) |

---

## 6. PR 分割

**2 PR** + **deferred PR-3**:

- **PR-1**(80KB elephant 解消、~150 行 net add):
  - `index.js`: `team_get_session` handler / `team_read_inbox` handler / `truncateSafe` inline
  - `src/__tests__/`: `truncate-safe.test.js` 新規 + `byte-measurement.test.js` 新規 + `mcp-envelope.test.js` 新規 + `sessions.test.js` 拡張 + `mailbox.test.js` 拡張
  - byte report → PR 説明自動転記の CI step(`vitest --reporter=json` + `gh pr edit --body-file`)
  - `CLAUDE.md` + `README.md` 該当行更新
  - **race 増幅ゼロ、screening 非依存**
- **PR-2**(briefing/search bound + screening、~900 行 net add):
  - `src/screening/` 4 ファイル + `config.js` + `UPSTREAM.md`
  - `scripts/gen-screening-fixture.mjs`(手動実行用、CI 不要)+ `src/__tests__/fixtures/screening-golden.json`(upstream commit hash 埋込)
  - `src/__tests__/screening.test.js` 新規 + `race-regression.test.js` 新規 + `briefing.test.js` + `memory.test.js` 拡張
  - `briefing.js` + `memory.js` の screening integration、`index.js` の 2 tool handler
  - `CLAUDE.md` + `README.md` 該当行更新
  - **PR-1 と独立**(`truncateSafe` を PR-2 でも使うなら PR-1 base に rebase 必須、両 PR がほぼ同時期なら `truncateSafe` を本 PR-2 内で先に inline 化、PR-1 merge 後に共通化 refactor は不要)
- **deferred PR-3**(別 issue):
  - `markMessagesAsRead` race fix + 多数小 message 累積 bound + 関連 stress test + p99 benchmark
  - `requires_approval` 永続化 fix も同 issue に bundle(cap exemption / priority display の consumer 実装と同時)

**PR-1/PR-2 が共有する file**: `index.js` / `CLAUDE.md` / `README.md`。PR-1 merge 後 PR-2 を rebase 前提。

---

## 7. 未決事項

- screening ポート範囲: full core 維持(Pi×2 が日英混在用途で支持)。Axis 7 の bilingualBridge/stemmer 除外は不採用(memory が日英混在、port は機械的、分割で work 倍増)。
- budget 初期値の test fixture: §2.4 byte-measurement.test.js で「80KB → ≤24KB」を必達条件として確認、必要なら microbench で微調整。
- buildBriefing の絶対 byte cap: PR-1 harness で p99 実測 → 発火可能性が示されたら PR-2 内で追加、未満なら未追加 merge。
- `Intl.Segmenter` の Node version 要件: relvetia-team の Node 最低要件確認(v20+ 想定で v3.1 採用、v18 要件なら code-point fallback 用意)。

---

## 8. DON'T(handoff + v3 + v3.1 累積)

- P0(`alwaysLoad` 削除)はやり直さない。
- Bun/Zig 書き換えに手を出さない。
- **`consumeInbox` を新設しない**。
- **`markMessagesAsRead` を触らない**(本 P1 では完全不変)。
- **`writeToMailbox` の hot path append を lock に入れない**(Approach A は dead)。
- **disk 上 message text を truncate しない**(返却 clone のみ)。
- **silent truncation を作らない**(structuredContent + 先頭 notice 必須)。
- **`requires_approval` 永続化 fix を本 P1 に同梱しない**(consumer なし dead code)。
- **scope 別 IDF + RRF を本 P1 で導入しない**(observed leak で trigger)。
- **`tsx` を devDependency に足さない**(`npx -p` で one-shot)。
- **`emitEvent` attrs に message body / payload を含めない**(P2 で規約化、本 P1 でも実装時に守る)。
- relay 機構(`relvetia-relay-trigger.mjs` 等)に触らない(user 担当)。
- 不可侵ファイル(`~/.claude/CLAUDE.md`, `~/workspace/relvetia/CLAUDE.md`, `MEMORY.md`, `settings.json`, screening の閾値定数の意味)は Read のみ。
- screening の BM25 系・2 段階 Sonnet パイプライン・noveltyScreening・diagnostics callback はポートしない(Codex P1 明示)。
- 巨大単独 item の全文回収を「`team_get_session` で」と主張しない(両方で truncate)。
