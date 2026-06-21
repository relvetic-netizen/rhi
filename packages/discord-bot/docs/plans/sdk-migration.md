# Plan: persona 経路を Agent SDK in-process query() に切替

Status: **DRAFT (design only, no implementation)**
Author: Claude Opus 4.7 (delegated by relvetic, 2026-04-25)
Target window: memory v3 卒業 (2026-04-29) 以降の別 PR

## Why this is a small change, not a large one

最初の見立てでは「`claude -p` subprocess を捨てて SDK 化」は大規模リアーキとして提示していたが、コード調査の結果、**SDK 経路 (`AgentSession`) は既に実装済み**で、汎用 session 経路 (`src/session/session.ts`) では `USE_AGENT_SDK` フラグで切替可能。

**残作業は persona 経路 (`src/persona/spawn.ts`) を同じ bridge に乗せること**。それと、AgentSession 側に persona が必須としているフィールド (`workingDir`, `additionalDirs`, `env`, `model`) を honor する処理を足すこと。

## Current state (relevant facts)

- `ClaudeSubprocess` (`src/claude/subprocess.ts`) — `claude -p` を per-message で spawn。30min wall-clock timeout (commit `05a0eb6`)。
- `AgentSession` (`src/claude/agent-session.ts`) — `@anthropic-ai/claude-agent-sdk` の `query()` を in-process で iterate。**ClaudeSubprocess と同じ `"message"` / `"exit"` イベント**を emit。すでに `bypassPermissions` / `mcpServers` / `resume` 対応済み。
- `session/session.ts` は `config.useAgentSdk` で `ClaudeSubprocess` か `AgentSession` を選択 → **動作実績あり**。
- `persona/spawn.ts:53` は無条件に `new ClaudeSubprocess()`。**フラグを見ない**。
- `AgentSession.start(options)` は `options.workingDir` / `options.additionalDirs` / `options.env` / `options.model` を**受け取っても無視している** (`config.defaultWorkingDir` / `config.claudeModel` ハードコード)。persona は `PERSONA_DIR` cwd と `RELVETIA_INCLUDE_PERSONA=1` 等を必須としているため、ここを直さないと persona は SDK 経路に乗らない。

## Target state

- `AgentSession.sendUserMessage()` が `start()` で受け取った `workingDir` / `additionalDirs` / `env` / `model` を query options にそのまま渡す。
- `persona/spawn.ts` は `config.useAgentSdk` を見て `ClaudeSubprocess | AgentSession` を選ぶ。
- 既存 `ClaudeSubprocess` は当面残す。フラグ off で旧経路、on で SDK 経路。本番切替は段階リリース。
- `~/.claude/relvetia/persona/state/discord-sessions/{guildId}.json` の `sessionId` 形式は SDK の `resume` も同じ string を期待するため互換 (SDK 側のドキュメント要確認)。

## Concrete changes

### 1. `src/claude/agent-session.ts`

`start()` で受け取ったフィールドを保持し、`sendUserMessage()` で query options に展開:

```diff
 export class AgentSession extends EventEmitter {
+  private _workingDir: string | undefined;
+  private _additionalDirs: string[] = [];
+  private _extraEnv: Record<string, string> = {};
+  private _model: string | undefined;
   ...
   async start(options: ClaudeSubprocessOptions = {}): Promise<void> {
     this._alive = true;
     this._sessionId = "";
     this._systemPrompt = options.systemPrompt || "";
+    this._workingDir = options.workingDir;
+    this._additionalDirs = options.additionalDirs ?? [];
+    this._extraEnv = options.env ?? {};
+    this._model = options.model;
   }
   ...
   async sendUserMessage(content: string): Promise<void> {
     ...
     const options: Record<string, unknown> = {
       abortController: this._abortController,
       permissionMode: "bypassPermissions",
       allowDangerouslySkipPermissions: true,
       mcpServers: this.mcpServers,
       allowedTools: ["mcp__discord-bot__*"],
-      cwd: config.defaultWorkingDir,
-      model: config.claudeModel,
+      cwd: this._workingDir ?? config.defaultWorkingDir,
+      model: this._model ?? config.claudeModel,
+      additionalDirectories: this._additionalDirs,  // SDK option name TBD
+      env: { ...process.env, ...this._extraEnv },   // SDK option name TBD
       includePartialMessages: true,
     };
```

**SDK option names (`additionalDirectories`, `env`) は要確認** — `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` の `Options` 型を読んで正確な名前を当てる。`extraArgs` 経由で `--add-dir` を渡すルートにフォールバックする可能性もあり。

### 2. `src/persona/spawn.ts`

`new ClaudeSubprocess()` を bridge factory に置き換え:

```diff
 import { ClaudeSubprocess } from "../claude/subprocess.js";
+import { AgentSession } from "../claude/agent-session.js";
+import { getMcpServerConfig } from "../mcp/agent-mcp-config.js";

 ...
 export async function ensureSession(...) {
   ...
-  const subprocess = new ClaudeSubprocess();
+  const subprocess = config.useAgentSdk
+    ? new AgentSession(getMcpServerConfig())
+    : new ClaudeSubprocess();
   await subprocess.start({ ... });
```

`PersonaSessionHandle.subprocess` の型は `ClaudeSubprocess | AgentSession` の union に。両者は同じ `"message"`/`"exit"` interface なので消費側 (`persona/index.ts` 等) は変更不要。

### 3. timeout の扱い

- ClaudeSubprocess の 30min `setTimeout(() => proc.kill("SIGTERM"))` は SDK 経路では **`AbortController.abort()`** に。
- 30min wall-clock を保つため、`AgentSession.sendUserMessage()` の冒頭で `setTimeout(() => this._abortController?.abort(), config.claudeSubprocessTimeoutMs)` を追加 (`exit` で clear)。

### 4. tests

- `src/claude/__tests__/agent-session.test.ts` (新規) — query() を mock して、`start({ workingDir, additionalDirs, env, model })` の値が options に渡されることを検証。
- `src/persona/__tests__/spawn.test.ts` の既存テストは `useAgentSdk: false` を前提にしているので、`useAgentSdk: true` 系のテストを並行で追加。
- 既存テストは壊さない。

## Migration phases

1. **Phase 1 (PR 1)**: AgentSession に options を honor させる。既存挙動は (subprocess 経路で) 完全保存。tests pass。
2. **Phase 2 (PR 2)**: persona/spawn.ts に flag bridge を追加。`USE_AGENT_SDK=true` で実機 dogfood (今日のような E2E)。
3. **Phase 3 (後日)**: フラグ off 経路の retire 判断。CLI subprocess の維持コスト次第。`resolve-cli.ts` / `ndjson.ts` / `ClaudeSubprocess` も削除候補。

各 PR は独立 mergeable。Phase 2 の dogfood で問題なければ Phase 3 に進む。

## Risks

| リスク                                                                                                              | 対策                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| SDK の `cwd` / `additionalDirectories` option 名が想定と違う                                                        | sdk.d.ts を読んで実装前に確定。間違えれば `extraArgs` 経由 fallback              |
| SDK の `resume` が persona の `sessionId` (string) と互換でない                                                     | Phase 1 dogfood で確認。互換でなければ persona 用に sessionId 形式変換層を入れる |
| `mcpServers` を毎ターン渡すが stdio subprocess (`mcp-standalone.js`) 経由 → MCP server プロセスが毎回 spawn される? | SDK 内で connection pool されるかドキュメント確認。されないなら起動コスト計測    |
| AgentSession に乗ると 30min timeout が AbortController 経由になる、grace 動作が違う                                 | Phase 2 dogfood で kill 経路の挙動 (Discord 表示) 確認                           |
| memory v3 が 4/29 卒業前に C-3 着手すると LongMemEval 評価が分離できない                                            | **4/29 以降に Phase 1 着手** (本 plan の前提)                                    |

## Open questions

1. SDK の `Options` 型で `cwd` / `additionalDirectories` / `env` / `model` の正確な field 名 (sdk.d.ts 要参照)
2. SDK の `resume` が ClaudeSubprocess `--resume` と完全互換か (sessionId 文字列の prefix / format)
3. persona の `additionalDirs` (`~/.claude`, `~/.claude/memory`, `~/.claude/relvetia`, etc.) を SDK 経由で全部通せるか
4. `mcp-standalone.js` を毎ターン spawn する方式と SDK の関係 — 1 process pool されるか、毎回 spawn か
5. `MCP_OPERATOR_ID` 等の env が `mcpServers` 設定経由で MCP server 子プロセスに伝わってるかの再確認

## Out of scope

- 18 個の slash command path (`/claude`, `/swarm`, etc.) は print mode を捨てる必要が薄いので**そのまま**。
- `session/session.ts` 経由の汎用 session は既に `USE_AGENT_SDK` で切替可能、本 plan の対象外。
- MCP server を SDK の type:"sse" / type:"http" に変える話は別 plan。
