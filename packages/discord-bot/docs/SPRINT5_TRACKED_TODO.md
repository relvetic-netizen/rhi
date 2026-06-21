# Sprint 5 Tracked TODOs — HTTP MCP transport follow-ups

Wave 2 Sprint 5 (PR for `docs/mcp-http-lan-flip-w2-s5` branch) で deferred された hardening / test / CI items の追跡 file。
本 sprint は **docs reflow + LAN flip dry-run runbook 整備** を主目的とし、以下の TODO は scope 外として別 PR で順次扱う。

各 TODO は **root issue / why deferred / suggested approach / acceptance criteria** を持つ。
完了時は本 file から該当エントリを削除（または ✅ + commit hash 添付）し、commit message で reference する。

source: Wave 2 Sprint 4 `/impl-qa` review で identify された P1 findings の subset。
related: master HEAD `96a286b` (PR #22 merge commit、Sprint 4 完了状態) / Sprint 4 final source `src/mcp/http-transport.ts` `src/mcp/http-tool-filter.ts`。

---

## TODO A — `rateBuckets` module-singleton → per-handle closure refactor

**Source**: impl-qa Axis 5 (Code Convention) finding 3a, P1。
**Issue**: `src/mcp/http-transport.ts` の `rateBuckets` は module top-level の `Map<string, RateBucket>`。`startHttpMcpServer` を同一 process で 2 回 call すると state を共有してしまう。production では 1 server / process が前提だが、test parallelism や将来の multi-listener scenario には footgun。
**Why deferred**: Sprint 4 は behaviour-preserving hardening が主目的、refactor は scope creep を避けて分離。`_resetRateLimitForTest` / `_sweepRateLimitForTest` / `_rateLimitBucketCountForTest` の test export 経路があるため、現状の test parallelism は安全。
**Suggested approach**:
- `rateBuckets` を `startHttpMcpServer` closure 内に hoist
- `checkRateLimit` / `recordAuthFailure` / `sweepRateBuckets` も closure scope の helper として閉じる
- `_*ForTest` export を `_makeRateLimitForTest()` factory 化、各 handle が独自 instance を返す
- 既存 test を新 API に migrate（既存 test は 5+ ファイル）
**Acceptance criteria**:
- `npm test` 全 pass、`scripts/smoke-http-mcp-w2-s4.mjs` 8/8 PASS
- 同一 process で `startHttpMcpServer` を 2 回 call → 各 server が独立 bucket Map を持つ test 追加
- module-level `Map` の grep 不在

---

## TODO B — IP-rotation rate-limit unit test

**Source**: impl-qa Axis 4 (Test Coverage) finding, P1。
**Issue**: 現状 rate-limit test は同一 IP の 5 fail → 6 回目 429 を verify するが、**100 distinct IP** が認証失敗を起こした時に bucket Map が膨張 → 60s 後の periodic sweep で 0 に戻る path が直接 unit test では cover されていない。`scripts/smoke-http-mcp-w2-s4.mjs` も同一 IP path のみ。
**Why deferred**: Sprint 4 で `_sweepRateLimitForTest` を export 済、test は追加するだけだが test data shape の helper 整備が小さくない (100 IP の dispatch loop + 時刻 mock)。
**Suggested approach**:
- `recordAuthFailure` を test export（または既存 internal-API export を活用）
- 100 distinct synthetic IPs に対して `recordAuthFailure` を 1 回ずつ call
- `_rateLimitBucketCountForTest()` が ~100 を返す確認
- `_sweepRateLimitForTest(Date.now() + RATE_WINDOW_MS + 1)` を call
- `_rateLimitBucketCountForTest()` が 0 に戻る確認
**Acceptance criteria**:
- 新 test ファイル or 既存 `src/mcp/__tests__/http-transport.test.ts` に 1-2 ケース追加
- `npm test` 全 pass（baseline 335 + 新 test 分）

---

## TODO C — Chunked-no-Content-Length body bypass test

**Source**: impl-qa Axis 4 (Test Coverage) finding, P1。
**Issue**: 1MB body cap は `Content-Length` header > 1MB を見て 413 を pre-reject + stream byte counter で post-validate する 2 段構成。後者の path は **`Transfer-Encoding: chunked` で `Content-Length` が無いリクエスト** で発火するが、unit test では cover されていない。
**Why deferred**: vitest 経由の `fetch()` は chunked encoding を直接 emit しない。raw `net.Socket` で chunked frame を組み立てる helper が必要で、scope の小さい test の割に setup が大きい。`scripts/smoke-http-mcp-w2-s4.mjs` の slow-loris case が部分的に raw socket を扱うので、参考実装あり。
**Suggested approach**:
- `net.connect` で raw socket を開く
- `Transfer-Encoding: chunked` header で POST `/mcp` を書く（`Content-Length` は付けない）
- 1KB chunks を `1.5MB / 1024 ≈ 1500 frames` 書き出す
- response status code が 413 になることを確認（mid-stream abort）
- socket は server destroy で close
**Acceptance criteria**:
- 新 test ファイル or `src/mcp/__tests__/http-transport.test.ts` に 1 ケース追加（chunked + no Content-Length）
- `npm test` 全 pass

---

## TODO D — README §Security Runbook に reverse-proxy 注意を追記

**Source**: impl-qa Axis 5 (Code Convention / Documentation) finding 1b, P1。
**Issue**: 本 server は `req.socket.remoteAddress` で client IP を取る（plain `node:http`、`X-Forwarded-For` は信頼していない）。これは intentional な選択だが README は明示していない。reverse-proxy（nginx / Caddy / Cloudflare）越しに deploy すると、**全 LAN client が proxy の IP に見える** ので、5/min/IP rate-limit が事実上 proxy 単位の 5/min DoS 入り口になる。
**Why deferred**: Sprint 5 の docs reflow が大型なので、reverse-proxy 注意は独立 commit で扱う方が cl-discipline §2 (small CL) に整合。
**Suggested approach**:
- README §Security Runbook に新サブセクション「Reverse-proxy 配下で運用する場合」追加
- 内容:
  - `X-Forwarded-For` は **信頼していない**（spoof 可能、middleware で正規化していない）
  - reverse-proxy 越しに deploy すると LAN client は proxy IP に集約され、rate-limit が proxy 単位の DoS 経路になる
  - 推奨: proxy 段で別途 rate-limit / WAF を入れる、または middleware で `socket.remoteAddress` を上書きする実装を将来追加検討
**Acceptance criteria**:
- README diff 30-50 行程度
- 既存 audit log section との整合（IP source を明示）

---

## TODO E — `MAX_BUCKETS` 定数 + LRU eviction

**Source**: impl-qa Axis 5 (Code Convention / Resilience) finding 1b, P1。
**Issue**: `rateBuckets` Map は periodic sweep（60s 間隔）で expired entry を消すが、**1 分以内に IPv4 全空間相当の botnet 攻撃** を受けると、sweep が間に合わずに Map が爆発 → process OOM。実害 likelihood は低い (LAN 限定運用) が、Sprint 6 で `MCP_BIND=0.0.0.0` flip 後に WAN への偶発露出（firewall rule misconfig）があると現実化し得る。
**Why deferred**: 防御層として効くが、TODO A の refactor と同時にやるのが自然（rateBuckets を closure 化した上で `MAX_BUCKETS` 定数を導入）。
**Suggested approach**:
- `MAX_BUCKETS = 10_000` 定数追加
- `recordAuthFailure` で `rateBuckets.size > MAX_BUCKETS` の時 oldest entry (resetAt 昇順) を drop
- `Map` は insertion order を保つので、`Map.prototype.keys()` で iterate → 最初の N 件 drop
- LRU 完全実装より単純な FIFO で十分（rate-limit の semantic 上、古い entry が消えても害は小）
**Acceptance criteria**:
- 既存 rate-limit test に「10_001 distinct IP で auth fail → Map size ≤ 10_000」テスト追加
- `npm test` 全 pass

---

## TODO F — CI check `npm ls @modelcontextprotocol/sdk` で duplicate tree fail-fast

**Source**: impl-qa Axis 5 (Code Convention / CI) finding 4a。
**Issue**: Sprint 4 で `@modelcontextprotocol/sdk` を `1.29.0` exact pin + `overrides` block で transitive dedup したが、CI で duplicate tree を検出する step が無い。将来 transitive dep が別 version を要求した時、`npm install` は成功するが `_registeredTools` private API access が unstable になる silent break risk。
**Why deferred**: 防御策として価値はあるが、CI YAML 編集は独立 PR で扱う方がレビュー単位が明確。
**Suggested approach**:
- `.github/workflows/ci.yml` の build-and-test job に 1 step 追加:
  ```yaml
  - name: Check single MCP SDK version in tree
    run: |
      if npm ls @modelcontextprotocol/sdk --all 2>&1 | grep -E "deduped|extraneous" -v | grep -c "@modelcontextprotocol/sdk@" | awk '{exit ($1==1 ? 0 : 1)}'; then
        echo "OK: single MCP SDK version"
      else
        echo "FAIL: multiple MCP SDK versions in tree"
        npm ls @modelcontextprotocol/sdk --all
        exit 1
      fi
  ```
- または npm の built-in `npm ls @modelcontextprotocol/sdk` の exit code を見る
**Acceptance criteria**:
- CI が duplicate tree のときに fail する
- 現状 (`1.29.0` 単一) では pass する
- 既存 test job との依存関係が壊れない

---

## 完了の記録

各 TODO 完了時は本 file の該当エントリに `**Status**: ✅ COMPLETED in <commit-hash> (<PR#>)` を追記し、次の distill タイミングで本 file から削除（git history に残るので worry なし）。
