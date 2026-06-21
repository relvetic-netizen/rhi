# Channels Integration Spec (v3 — landed)

Status: **v3 — Phase 3 E2E verified**
Branch: `feat/channels-capability`

## 0. Research preview limitation (重要)

`--dangerously-load-development-channels server:relvetia-team` flag は **receiver claude session 起動時に必ず 1 回 interactive 確認 prompt を出す**:

```
WARNING: Loading development channels
--dangerously-load-development-channels is for local channel development only.
Please use --channels to run a list of approved channels.
Channels: server:relvetia-team
> 1. I am using this for local development
  2. Exit
Enter to confirm · Esc to cancel
```

**この prompt は per-session で永続化されない** (本日 [11:31] 実機 verify、accept 後の `~/.claude.json` diff = `numStartups` / `timestamp` のみ、channel approval entry 無し)。

帰結:

- receiver の **初回起動だけ** TTY 付き (= visible terminal) で手動 Enter 必要
- 一度 alive にすれば **channel 経由の dispatch は完全 autonomous** で動く (本 spec の Goal 1 を満たす)
- spawn-relay の `-WindowStyle Hidden` 経路では prompt 見えず hung する → `--enable-channels` の autonomous spawn は研究 preview 中は **不可**、graduation 後に再評価
- 当面の運用: **長期常駐 receiver を 1 回手動 setup → 以降 channels で push** = 半 autonomous workflow
- 完全 autonomous が要件なら **Path β** (SessionStart hook digest、本日 [02:14] 完全 verify 済) を併用

## 1. Goal

`relvetia-team` MCP server に **Channels capability** を統合し、`team_request_async` / `team_send_message` で投入された inbox entry を、receiver の **既 active claude session に runtime push** する。これにより Goal 1 (orchestrator → receiver の人手 prompt 不要 fully autonomous dispatch) を完成させる。

## 2. References

- 公式 docs: `https://code.claude.com/docs/en/channels-reference` (本 spec で完全要約)
- fakechat reference: `https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat`
- 既存 SDK: `@modelcontextprotocol/sdk@^1.29.0` (`McpServer` constructor は options を内部 `Server` に丸投げする = `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:25`)
- **既存 mailbox 実装の確認済 fact** (Codex P0 で発覚、本 spec の前提):
  - `src/mailbox.js:8` storage format = **JSONL append-only** (legacy JSON-array は最初の write で auto-migrate)
  - `src/mailbox.js:34` `parseInboxSafe(content, inboxPath)` = canonical parser、JSONL + legacy 両対応、欠損は `[]`
  - `src/mailbox.js:274-283` `writeToMailbox` が persist する entry shape:
    ```js
    { from, text, timestamp, read: false,
      ...(color ? {color}: {}),
      ...(summary ? {summary}: {}),
      ...(request_id ? {request_id}: {}),
      ...(in_reply_to ? {in_reply_to}: {}) }
    ```
  - **`id` field は存在しない**。dedupe には合成 key が必要。
  - hot path = `appendFile()` (line 305-308)、O_APPEND atomic で 4KB 未満は serialize される。rare full-rewrite path のみ lock + atomic rename 経由 (line 295-)。
  - `src/mailbox.js:267-272` 起動時 inbox file 不在時のパターン: `ensureDir(getInboxDir(team))` + `writeFile(inboxPath, '', { flag: 'wx' })` swallow EEXIST。
- 既存 MCP tool `team_send_message` schema (`src/index.js:201-`、Codex P1-2 で確認):
  - args: `{team_name, to, message, summary?, from='team-lead', requires_approval?}`
  - **`in_reply_to` 引数は存在しない**。reply correlation は本文 / `summary` 内に request_id を含める運用。

## 3. Architecture

```
[sender session]                              [receiver session = claude --dangerously-load-development-channels server:relvetia-team]
                                              ├─ relvetia-team MCP subprocess (stdio)
team_request_async({to:agent_b, ...})  →     │   └─ writes inboxes/agent_b.json (JSONL appendFile)
                                              │       ↓ fs.watch (own agent file only)
                                              ├─ channels.js: parseInboxSafe → diff dedupe set → for each new entry:
                                              │       ↓ server.notification('notifications/claude/channel', {...})
                                              └─ Claude reads <channel source="relvetia-team" team="..." agent="agent_b" ...>text</channel>
                                                      ↓ auto-reply
                                                 team_send_message(team_name, to=<from>, from=<agent>, message=<reply>)
                                                 (correlate async via embedding request_id in message body or summary)
```

各 receiver claude session は `--dangerously-load-development-channels server:relvetia-team` で起動する必要がある (research preview の allowlist bypass)。`relvetia-team` MCP subprocess は `RELVETIA_TEAM` / `RELVETIA_AGENT` env vars を持ち (`spawn-relay.mjs` で渡す、Phase 2)、**自分の agent inbox file 1 つだけ** watch する。

## 4. Capability declaration

`src/index.js`:

```js
const server = new McpServer(
  { name: 'relvetia-team', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      // tools: {} は明示しない。McpServer wrapper が server.tool() 登録時に
      // auto-register する (mcp.js:62)。結果的に Channel server は two-way:
      // 既存 39 tools が reply path として機能する。
    },
    instructions: [
      'Inbox events arrive as <channel source="relvetia-team" team="<team>" agent="<you>" from="<sender>" [request_id="<id>"] [summary="<one-line>"] [kind="<kind>"] [async="true|false"]>body</channel>.',
      'The agent attribute is the recipient (you). The from attribute is the sender.',
      'To reply: call team_send_message with team_name=<team>, to=<from>, from=<agent>, message=<your reply>. team_send_message has no in_reply_to argument; for async correlation, embed the request_id in the reply text or summary so the original sender can match it.',
      'Channel events are real-time pushes. SessionStart digest still surfaces unread inbox at cold start; channel does NOT mark read=true, so SessionStart digest may overlap with channel events for the same entry — Claude should dedupe visually by request_id / content.',
    ].join(' '),
  },
)
```

`mcp.notification(...)` は low-level handle 経由: `server.server.notification(...)` (`mcp.js:13`).

## 5. Channel runtime — `src/channels.js` (new)

Single export: `initChannels(lowLevelServer, opts)` → returns `Promise<{ close, rescan }>`。

### 5.1 Initialization order (Codex P0-3)

**`initChannels` は `await server.connect(transport)` の AFTER に呼ぶ。** SDK の `notification()` は transport 未接続なら "Not connected" throw する。`src/index.js` 末尾は以下:

```js
const transport = new StdioServerTransport()
await server.connect(transport)
const channels = await initChannels(server.server, {})  // server.server is low-level Server
// (channels.close は process exit hook で呼ぶ — exit 時 watcher leak 防止)
```

### 5.2 Init flow

```js
import { parseInboxSafe } from './mailbox.js'
import { getInboxPath, getInboxDir, ensureDir } from './paths.js'
import { readFile, writeFile, watch } from 'node:fs/promises' // watch は callback 版を使うので 'node:fs'
import * as fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

export async function initChannels(server, opts = {}) {
  const team  = opts.team  ?? process.env.RELVETIA_TEAM
  const agent = opts.agent ?? process.env.RELVETIA_AGENT
  if (!team || !agent) {
    return { close: () => {}, rescan: async () => {} }  // sender-only / unset env: no-op
  }

  const instanceId = opts.instanceId ?? process.env.RELVETIA_AGENT_INSTANCE_ID ?? randomUUID()
  const inboxPath  = getInboxPath(team, agent)

  // Codex P0-2: defensive create (writeToMailbox uses same pattern at mailbox.js:267-272)
  await ensureDir(getInboxDir(team))
  try { await writeFile(inboxPath, '', { flag: 'wx' }) } catch (e) { if (e.code !== 'EEXIST') throw e }

  // Baseline: cold-start unread is SessionStart hook's responsibility (Q1).
  // We mark all PRE-existing entries as "already known" so they don't fire.
  const seen = new Set()
  const baseline = parseInboxSafe(await readFile(inboxPath, 'utf-8'), inboxPath)
  for (const entry of baseline) seen.add(dedupeKey(entry))

  let closed = false
  let watcher
  let pollTimer

  async function rescan() {
    if (closed) return
    let raw
    try { raw = await readFile(inboxPath, 'utf-8') }
    catch (e) { if (e.code === 'ENOENT') return; throw e }
    const entries = parseInboxSafe(raw, inboxPath)
    for (const entry of entries) {
      const key = dedupeKey(entry)
      if (seen.has(key)) continue
      seen.add(key)
      await emit(server, { team, agent, instanceId, entry })
    }
  }

  // Primary: fs.watch (low latency, ~10ms)
  try {
    watcher = fs.watch(inboxPath, { persistent: true }, () => { rescan().catch(logErr) })
  } catch (e) {
    logErr(e) // fall through to polling
  }

  // Codex P0-2 race + Windows fs.watch reliability: immediate rescan tick + 5s polling backup
  setImmediate(() => { rescan().catch(logErr) })
  pollTimer = setInterval(() => { rescan().catch(logErr) }, 5000).unref()

  function close() {
    if (closed) return
    closed = true
    if (watcher) try { watcher.close() } catch {}
    if (pollTimer) clearInterval(pollTimer)
  }
  return { close, rescan }
}

function dedupeKey(entry) {
  // Codex P0-1: mailbox entries have no `id`. Dedupe via composite key.
  if (entry.request_id) return `req:${entry.request_id}`
  if (entry.in_reply_to) return `rep:${entry.in_reply_to}:${entry.timestamp ?? ''}`
  const ts   = entry.timestamp ?? ''
  const from = entry.from ?? ''
  const text = entry.text ?? ''
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 8)
  return `gen:${ts}|${from}|${hash}`
}

async function emit(server, { team, agent, instanceId, entry }) {
  const meta = { team, agent, instance_id: instanceId }
  // Codex P1-3: skip empty optional fields. meta keys must be letters/digits/underscore only.
  if (entry.from)        meta.from        = String(entry.from)
  if (entry.request_id)  meta.request_id  = String(entry.request_id)
  if (entry.in_reply_to) meta.in_reply_to = String(entry.in_reply_to)
  if (entry.summary)     meta.summary     = String(entry.summary)
  if (entry.timestamp)   meta.timestamp   = String(entry.timestamp)
  // kind: derive from entry semantics (request_id present → request, in_reply_to → reply, else message)
  meta.kind = entry.request_id ? 'request' : entry.in_reply_to ? 'reply' : 'message'
  await server.notification({
    method: 'notifications/claude/channel',
    params: { content: entry.text ?? '', meta },
  })
}
```

### 5.3 Mark-read 戦略 (Codex P1-6)

channels.js は **`read=true` mark を行わない**。理由:

- mark-read は inbox file の rewrite path を経由 (line 192-220 の markMessagesAsRead) で重い
- SessionStart hook (`relvetia-inbox-injector.mjs`) は peek=true で digest を出すので、channel 経由で Claude が見た entry が cold-start で再表示される overlap は **実害なし** (Claude が visually dedupe by `request_id` / content)
- mark-read を入れると hook digest が空になり、cold-start 時に context が薄くなる退行が発生する

**Trade-off**: Claude は同じ entry を 2 回見る可能性 (channel push + 次セッション digest)。`instructions` で「dedupe by request_id / content」を明示する。完全 dedupe が必要なら Phase 1.5 で channel-delivered marker (別 file) を導入する。

## 6. Open questions — resolved

| # | Question | Resolution |
|---|----------|-----------|
| Q1 | 起動時 init で既存 unread を inject? new entry のみ? | **new entry のみ runtime push**。cold inject は SessionStart hook digest 担当。**overlap 可能性は明示的に accept** (§5.3、Claude が visual dedupe)。完全 dedupe は Phase 1.5。 |
| Q2 | reply tool は専用新設? `team_send_message` 流用? | **既存 `team_send_message` 流用**。`in_reply_to` 引数は存在しないので async 相関は本文/summary に request_id 埋込み運用。`from=<agent>` 必須 (default は team-lead で sender identity 壊れる、Codex P1-2)。 |
| Q3 | mailbox watch lease TTL? | **不要**。各 receiver subprocess は自分の agent inbox file 1 個のみ watch、他 agent 触らない → 競合なし。 |
| Q4 | 複数 active session 同時受信時の dispatch | **同 agent name 2 セッション禁止 ops contract** + **observability 追加** (Codex P1-7): `RELVETIA_AGENT_INSTANCE_ID` (env or random) を meta に含めて duplicate を観測可能化。Phase 1.5 で fan-out 識別子化。 |
| Q5 | Permission relay (`claude/channel/permission`) を MVP に含める? | **含めない**。relvetia-team の trust boundary (内部 mailbox、認証 reply path 無し) と整合せず別 design 必要。**ただし extension point は明記** (Codex P1-8): 後付けは `setNotificationHandler(PermissionRequestSchema, ...)` 追加で可能、capability に `claude/channel/permission: {}` 1 行追加するだけ。trusted sender allowlist は別途。 |
| Q6 | chokidar の Windows path 罠 | **chokidar 不採用**。`fs.watch` (Node built-in) で 1 file watch、`path.resolve(os.homedir(), '.claude', ...)` で Windows native absorb。 |

## 7. handoff からの設計逸脱 — 明示

handoff Phase 1 推奨 vs 本 spec 採用:

1. **chokidar → fs.watch**: 各 receiver は自分 1 file のみ watch、recursive 不要、新 dep avoid、Windows rename drop は 5s polling backup で absorb (Codex P1-4)。
2. **reply tool 専用追加なし → 既存 `team_send_message` 流用** (Q2)。
3. **permission relay deferral**: capability extension point は残す (Q5)。
4. **lease 不要、ops contract で multi-session 禁止 + instance_id 観測** (Q4)。

これらは user 承認済 (本 v2 で承認継続)。

## 8. Phase 1 — capability + channel runtime (実装 checklist)

- [ ] `src/index.js`: `McpServer` constructor に options block 追加 (`capabilities.experimental['claude/channel']: {}` + `instructions`)。`tools: {}` は **書かない** (auto-register 任せ)。
- [ ] `src/index.js`: `await server.connect(transport)` の **後** に `await initChannels(server.server, {})` 呼出 (Codex P0-3)。process exit hook で `channels.close()` 呼ぶ。
- [ ] `src/channels.js` 新設、`initChannels(lowLevelServer, opts)` export。
- [ ] `src/__tests__/channels.test.js` 新設、§13 の 12 case を実装。
- [ ] `npm test` 全 pass (現 201 → 213 想定、+12)。
- [ ] `node scripts/sync-readme.mjs --check` pass (tool count 変動なし、preset 変動なし、capability 追加は drift detection scope 外)。

## 9. Phase 2 — `spawn-relay.mjs` 拡張

`~/.claude/scripts/relvetia/spawn-relay.mjs`:

- `normalizeArgs()` に `enableChannels: boolean` (default `false`、BC) 追加。
- `enableChannels=true` のとき claude binary args に `'--dangerously-load-development-channels', 'server:relvetia-team'` insert (`--name` 後、`--print` 前)。
- `RELVETIA_AGENT_INSTANCE_ID` を `--env-json` で渡せるようにする (default は spawn 時 random UUID)。
- 既存 `claudeName` / `initialPrompt` / `--print + handoff prompt` 経路と互換性維持。
- CLI flag `--enable-channels` 追加 (boolean)。
- `spawn-relay.test.js` に dry-run case 追加。

## 10. Phase 3 — E2E verify

1. **fresh team 作成** (Codex P1-9): `team_create({channel-e2e-test, members:[receiver-a]})`。phone-test の既存 inbox を流用すると hook digest path との切り分けが曖昧になる。
2. **receiver spawn**: `--enable-channels` + env `{RELVETIA_TEAM:channel-e2e-test, RELVETIA_AGENT:receiver-a}` + `RELVETIA_AGENT_INSTANCE_ID=test-instance-1`。phone /code main で session 出現確認。
3. **idle 確認**: receiver は initial prompt 処理後 idle。
4. **MCP debug log 監視** (Codex P1-9): receiver session の `~/.claude/debug/<sid>.txt` を tail 開始。
5. **sender push** (本 sender session から):
   ```js
   team_request_async({
     team_name: 'channel-e2e-test',
     to: 'receiver-a',
     prompt: 'Reply with the literal token CHANNEL_<random8>',
   })
   ```
6. **assertions** (3 軸全部成立して **完遂**):
   - (a) MCP debug log に `notifications/claude/channel` line + token 含む `content` (channel 経路の証拠、hook digest path との切り分け)
   - (b) receiver jsonl `~/.claude/projects/.../<sid>.jsonl` に `<channel source="relvetia-team" ...>` tag arrive
   - (c) sender side inbox (`channel-e2e-test/inboxes/<sender>.json`) に receiver からの reply (token echo) が落ちる、`from=receiver-a`、本文に request_id 含む
7. **cleanup**: receiver kill、team 削除。

## 11. Phase 4 — commit + PR + log

- **relvetia-team** (`feat/channels-capability` branch):
  - 1 commit `feat(channels): integrate claude/channel capability for runtime inbox push`
  - 内容: spec / channels.js / channels.test.js / index.js 修正 / package.json (deps 変動なし)
  - **PR 作成** (recent activity が #17-#21 で PR 文化 confirmed)、master merge → master push
- **~/.claude**:
  - 1 commit `feat(spawn-relay): add --enable-channels flag for channels-aware receivers`
  - 内容: spawn-relay.mjs / spawn-relay.test.js
  - master push
- **memory log**:
  - `[HH:MM] [done][channels-mvp] Goal 1 完遂 — relvetia-team commit <hash> + PR <#> merged + ~/.claude commit <hash>、Phase 3 (a)+(b)+(c) 全 assertion 成立`
- **handoff**:
  - record a completion note with the verified commit hash + PR URL

## 12. Risks / DON'T

1. 不可侵ファイル touch 禁止 (`CLAUDE.md`, `MEMORY.md`, `index.json`, `stats.json`, `concepts/graph.json`, `settings.json`, `screeningConfig.ts`)
2. 既存 39 tools の signature 変更しない、削除しない
3. `spawn-relay.mjs` default 動作壊さない (`enableChannels=false` で既存挙動)
4. Discord webhook (channel ID `<DISCORD_CHANNEL_ID>`) を削除しない
5. 既存 inbox-injector hook (SessionStart / UserPromptSubmit) を削除しない (cold start 担当)
6. Windows `fs.watch` の rename drop → 5s polling backup を **必ず** 併設
7. `meta` key は letters/digits/underscores only — hyphen / dot を使うと silently dropped (snake_case 強制)
8. **channel 配信時に `read=true` mark しない** (§5.3、SessionStart hook digest との contract)
9. Permission relay (`claude/channel/permission`) を MVP に含めない、ただし extension point は残す (Q5)
10. **同 agent name 2 セッション同時起動禁止**、`RELVETIA_AGENT_INSTANCE_ID` で観測可能化
11. **`team_send_message` には `in_reply_to` 引数なし** — 過去の handoff の reply 説明に従わない

## 13. Test plan (Codex P1-5 拡張、12 case)

| # | Test | Where | Verification |
|---|------|-------|-------------|
| T1 | baseline 計算 (parseInboxSafe 経由) | unit | 起動時の既存 entry が seen Set に入る |
| T2 | dedupeKey: request_id branch | unit | `req:<id>` |
| T3 | dedupeKey: in_reply_to branch | unit | `rep:<id>:<ts>` |
| T4 | dedupeKey: generic branch (no id) | unit | `gen:<ts>|<from>|<sha8>` |
| T5 | JSONL append (writeToMailbox 経由 integration) | integration | actual hot path で append → notification 1 回 fire |
| T6 | legacy JSON-array → migrate → notification | integration | first write が migrate trigger、新 entry のみ notification |
| T7 | missing inbox file 起動 | unit | `wx` flag で empty 作成、最初の write を拾う |
| T8 | multiple entries in one read window | unit | 1 watch event で複数新 entry → 各 notification 順次 fire |
| T9 | duplicate suppression (rescan idempotence) | unit | 同 entry に対して 2 回 rescan → 1 回しか emit しない |
| T10 | meta omit empty optional | unit | `request_id` undefined → meta から omit (空文字列にしない) |
| T11 | env 未設定 no-op | unit | `RELVETIA_TEAM=''` → init 即 return、watcher 起動せず |
| T12 | teardown idempotence | unit | `close()` 2 回呼んでも throw しない、watcher unref |

E2E (Phase 3) は §10 で別途。`npm test` 全 pass = 201 既存 + 12 新規 = 213/213。

## 14. Out of scope (本 task では実装しない、別 task)

- Permission relay (`claude/channel/permission`)、ただし §6 Q5 で extension point 残す
- Multi-session fan-out (同 agent 2 instance 並行受信)
- chokidar 移行 (fs.watch で MVP)
- Plugin 化 (research preview の `--dangerously-load-development-channels` 運用継続)
- Channels の team / agent 単位 enable/disable 設定 (現状: `--enable-channels` 全か無か)
- channel-delivered marker (完全 dedupe、§5.3 trade-off 解消)
- Async reply の `in_reply_to` 引数を `team_send_message` に追加 (現状: 本文 / summary 埋込み運用)

## 15. Mailbox shape contract (formal)

本 spec は以下を `mailbox.js` の **public contract** として依存する。変更時は本 spec の §5 dedupeKey + emit を必ず更新する。

```ts
// JSONL one entry per line
type MailboxEntry = {
  from: string                  // sender agent name
  text: string                  // primary body (maps to <channel> tag content)
  timestamp: string             // ISO 8601, set by writeToMailbox
  read: boolean                 // false on write, mutated by markMessagesAsRead
  color?: string                // optional, sender member color
  summary?: string              // optional, 5-10 word preview
  request_id?: string           // present for team_request / team_request_async
  in_reply_to?: string          // present for team_reply (sync replies)
  // future fields: ANY new field MUST NOT break parseInboxSafe (object shape preserved)
}
```

## 16. Permission relay extension point (Q5、後付け path)

Phase 1.5 / 2.0 で permission relay を追加する場合、以下 3 点だけで MVP 拡張可能:

1. `src/index.js` capability に `experimental['claude/channel/permission']: {}` 追加
2. `src/channels.js` に `setNotificationHandler(PermissionRequestSchema, handler)` 追加 (handler は permission_request の 4 field を chat 系 inbox に送る、別 channel 経由で人が verdict 返す)
3. inbound verdict (chat → mailbox 経由 or 別 path) の regex parse → `notifications/claude/channel/permission` notification 発火

trusted sender allowlist は別 design (relvetia-team 内部 trust boundary だけでは不十分、外部 chat platform の sender ID 検証が必要)。

