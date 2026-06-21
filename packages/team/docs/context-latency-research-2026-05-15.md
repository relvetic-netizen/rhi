# relvetia-team — context 消費 / latency 調査レポート

調査日: 2026-05-15
調査者: Claude (Opus 4.7) + 並列 Explore subagent ×2 + Context7 + Pi
動機: relvetia-team の context 消費量・速度に問題を感じる、という user 報告。「Bun/Zig に書き換えれば速くなるか?」への回答も兼ねる。

---

## TL;DR

**context は「常時 hot に載せる」のをやめる。index だけ hot + 必要時 fetch、subtask は isolated context、tool 戻り値は budget cap。**

これは Claude Code ハーネス実装 / kairos 旧実装 / OpenAI・Anthropic Agent SDK の **3 者が独立に同じ結論に到達**している。そして **runtime(Bun/Zig)とは完全に直交** — 速くするのはアーキテクチャであって言語ではない。Bun 移行は latency に多少効くが、context 消費は 1 トークンも減らない。Zig 全面書き換えはボトルネック(CPU ではない)に対して的外れ。

---

## 1. relvetia-team の実測値

### Schema 注入(常時かかる固定税)

| 項目 | 実測値 |
|---|---|
| tool 数 | 38 |
| tool list JSON(整形済) | 43,745 bytes |
| tool 定義の正味内容 | 26,967 bytes(うち description 5,109 bytes) |
| context 注入コスト概算 | 約 7,300〜11,800 tokens |

`team-cli.sh __list_tools__` で MCP server が emit する実 JSON を測定。MCP 接続中は使っても使わなくても毎セッション払う。

per-tool 上位: `team_run_evaluated_task`(1,318 B)/ `team_create_task`(1,284 B)/ `team_search_memory`(1,271 B)。上位 10 tool で全体の 42%。

### Tool 戻り値(呼び出しごと、データ依存)

| tool | 挙動 | 実測リスク |
|---|---|---|
| `team_get_session` | **全履歴を返す(デフォルト limit なし)** | team-lead inbox が notion-reorg-v3 で **80,161 bytes ≈ 21,600 tokens** — 1 回の呼び出しでこれが返る |
| `team_read_inbox` | 未読を全部返す | inbox 肥大時に青天井 |
| `team_build_briefing` / `team_prime_agent` | finding 15 + knowledge 20 + essential 群(**上限なし**)| 1 回 ~1〜3k tokens |
| `team_search_memory` | デフォルト limit 50 件 | 件数次第で大きい |
| `team_status` | members + counts のみ | 小さい(問題なし)|

真の爆弾は `team_get_session` と肥大した team-lead inbox。履歴管理機構がない。

---

## 2. 4 ソース横断: context 管理の手法

| 手法 | Claude Code ハーネス | kairos(旧実装)| Agent SDK | relvetia-team 現状 |
|---|---|---|---|---|
| **Deferred tool loading** | `defer_loading:true` で API がトークン計上から除外。`isMcp:true`→全 MCP 自動 defer。MCP 記述が context の 10% 超で ToolSearch 自動有効化 | — | — | **未適用**。team_* 38 tool が upfront 注入。Context7/Gmail/Notion は deferred 済(← 非対称、要調査) |
| **自動 compaction** | `effectiveContextWindow − 13k` で発火、要約後 top-5 file(50k budget)+ plan + skill 再注入 | 夜間 distillation で生ログ→topic 圧縮 | `SDKCompactBoundaryMessage`(`trigger:auto`)| なし |
| **多層メモリ + screening** | — | 生ログ→topic→500行 index。TF-IDF screening が 200→30 file を 10-100ms で絞る(API 不使用)| — | briefing は無条件 dump、search は default limit 50 |
| **subtask の context 隔離** | `createSubagentContext()` で別 messages 配列・別 AbortController。親には yield された Message のみ | `claude -p` subprocess、毎回 fresh | subagent は独自 context、親に `result` 文字列のみ | `team_request`/`team_invoke` がこれ相当(○) |
| **read-only agent の context 削減** | Explore/Plan は claudeMd + gitStatus を剥がす(「5-15 Gtok/週 節約」)| — | subagent に `tools` 制限 | — |
| **戻り値の budget cap** | compact 後の file 再注入も 50k/25k budget | screening で件数制限 | — | `team_get_session` は全履歴(80KB 実測) |
| **handoff vs agents-as-tools** | — | — | handoff=全履歴渡す(重)/ `asTool()`=生成入力のみ(軽)| `team_handoff`(重)と `team_request`(軽)に対応 — SDK 設計が後者を裏付け |

### key file refs（ハーネス: `~/workspace/relvetia/ClaudeCLI288/src/`）
- `tools/AgentTool/runAgent.ts:700` — `createSubagentContext()` で context 隔離
- `tools/AgentTool/forkSubagent.ts` — fork 子はバイト同一プレフィックスで cache 共有
- `services/compact/autoCompact.ts:63` — `AUTOCOMPACT_BUFFER_TOKENS` = 13,000
- `services/compact/compact.ts:1415` — compact 後の top-5 file 再注入(50K budget)
- `tools/ToolSearchTool/prompt.ts:62` — `isDeferredTool()` ロジック、`isMcp:true`→defer
- `utils/toolSearch.ts:49` — MCP 記述が context の 10% 超で auto-enable

### kairos refs（`C:\tmp\claude-test-repo\`、旧世代実装）
- `kairos-extracted/screening/screening.ts` — Trim-and-Square(TF-IDF + 絶対閾値)
- `kairos-extracted/memory/residualIndex.ts` — index.json で圧縮元を追跡・再 fetch 可能
- `kairos-daemon/src/executor.ts:123` — `child_process.execFile()` で `claude -p` subprocess 隔離
- screening は純粋計算、200 file ≈ 10-100ms、embedding API 不使用

---

## 3. latency の手法

- **prompt caching + 安定プレフィックス**: `cache_control:ephemeral`、fork subagent はバイト同一 API リクエストプレフィックスで cache 共有、cache-break 検出器が >5% read 低下を検知（`claude.ts:358`, `promptCacheBreakDetection.ts`）
- **streaming 中の並列 tool 実行**: `StreamingToolExecutor` が応答ストリーム中に concurrency-safe tool を並列実行（`StreamingToolExecutor.ts:40`）
- **deferred tool が TTFT を縮める**: 初期プロンプトが小さい = first-token が速い
- **subprocess の新鮮さ**（kairos）: daemon task ごとに fresh `claude -p`、REPL bloat なし
- **hot path に API を置かない**（kairos）: TF-IDF は純粋計算、embedding API 呼ばない

---

## 4. relvetia-team への適用（優先度付き）

### P0 — deferred tool 化の実現可能性調査【最大効果・コードゼロの可能性】
本 session で Context7/Gmail/Notion は deferred なのに **team_* 38 tool は upfront 注入**されている。ハーネスの `isDeferredTool()` は `isMcp:true`→defer のはず。なぜ relvetia-team だけ upfront なのか — 登録方法（local stdio server）/ 設定 / 閾値の問題を切り分ければ、**~12k tokens がコード変更ゼロで回収できる可能性**。
→ **調査中**（本レポート時点で並列委託済み）。

### P1 — `team_get_session` / `team_read_inbox` に default limit + 戻り値 budget cap
実測の 80KB-in-one-call を構造的に潰す。ハーネスの「50k budget」発想を移植。コード変更・中規模。

### P1 — briefing / search に screening 導入
`relvetia-extracted/screening/` に TF-IDF screening モジュールが既存（kairos 由来）。briefing の無条件 dump を screening 経由に。

### P2 — Bun 移行
latency に多少効く（プロセス起動・file I/O）が、P0/P1 に比べ桁違いに小さい。runtime 移行は後回し。

### 非推奨 — Zig 全面書き換え
ボトルネックは CPU でなく「常時注入トークン + 無制限戻り値」。労力に対しリターンなし。

---

## 5. 出典

- relvetia-team 実測: `team-cli.sh __list_tools__` + `~/.claude/teams/` ランタイムデータ計測（2026-05-15）
- Claude Code ハーネス: `~/workspace/relvetia/ClaudeCLI288/src/`（explore-1m subagent 調査）
- kairos 旧実装: internal archived repo（Explore subagent 調査）
- OpenAI Agents SDK: Context7 `/websites/openai_github_io_openai-agents-js`
- Claude Agent SDK: Context7 `/nothflare/claude-agent-sdk-docs`
