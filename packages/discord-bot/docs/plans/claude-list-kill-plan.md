# /claude-list と /claude-exit 拡張 実装計画

> 関連: `docs/specs/claude-list-kill-spec.md`

## 1. ファイル分割

### 新規

```
src/claude-bridge/cse-sessions/
├── inspector.ts          # PowerShell process scan + parse
├── kill-policy.ts        # canKill() 純関数
├── formatter.ts          # Discord 表示整形
└── __tests__/
    ├── inspector.test.ts
    ├── kill-policy.test.ts
    └── formatter.test.ts
```

### 編集

```
src/claude-bridge/killer.ts        # killByPid() 追加
src/discord/commands.ts            # /clear desc 修正 + /claude-exit 拡張 + /claude-list 追加 + /help 更新
src/discord/client.ts              # slash command 登録 update
```

## 2. データ型

```ts
// inspector.ts
export interface ClaudeProcess {
  pid: number;
  parentPid: number;
  startedAt: Date;
  workingSetBytes: number;
  commandLine: string;
}

export interface ClassifiedSessions {
  hubPid: number | null;
  registry: Array<{ proc: ClaudeProcess; entry: ClaudeEntry }>;
  cse: Array<{ proc: ClaudeProcess; sessionId: string }>;
  unclassified: ClaudeProcess[];  // 私自身 (--dangerously-skip-permissions interactive) など
}

// kill-policy.ts
export type KillKind = "registry" | "cse";

export type KillDecision =
  | { allowed: true; kind: KillKind }
  | { allowed: false; reason: string };
```

## 3. inspector.ts ロジック

```ts
async function listClaudeProcesses(): Promise<ClaudeProcess[]> {
  // PowerShell: Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  //             Select ProcessId, ParentProcessId, CreationDate, WorkingSetSize, CommandLine |
  //             ConvertTo-Json
  // 1 件のときは object、複数のときは array で返るので両方に対応
}

function detectHubPid(procs: ClaudeProcess[]): number | null {
  // commandLine が "remote-control" を含み、かつ "--sdk-url" を含まないものが hub
}

function classify(procs: ClaudeProcess[], registry: ClaudeEntry[]): ClassifiedSessions {
  // 1. hub 検出
  // 2. cmdline に --sdk-url cse_xxx がある & parent==hub → cse
  // 3. registry.pid に一致 → registry (cse と同時マッチなら registry 優先)
  // 4. 残り → unclassified
}
```

CreationDate parse: PowerShell ConvertTo-Json は `/Date(milliseconds)/` 形式で返す。`/Date\((\d+)\)/` regex で millis 抽出 → `new Date(millis)`。

## 4. kill-policy.ts

```ts
export function canKill(
  pid: number,
  ctx: { botPid: number; registryPids: number[]; cseSessionPids: number[] }
): KillDecision {
  if (pid === ctx.botPid) return { allowed: false, reason: "bot self-kill 禁止" };
  if (ctx.registryPids.includes(pid)) return { allowed: true, kind: "registry" };
  if (ctx.cseSessionPids.includes(pid)) return { allowed: true, kind: "cse" };
  return { allowed: false, reason: "registry にも cse_session にも該当しない PID" };
}
```

## 5. formatter.ts

```ts
export function formatList(c: ClassifiedSessions): string {
  // ヘッダ: "🔧 Active Claude processes (N)"
  // 各行: [type] PID xxxx | name | meta | age | mem
  // 0 件: "現存する Claude プロセス無し。"
}

export function formatAge(startedAt: Date, now = new Date()): string {
  // "Nh Mm" 形式 (1 分未満は "<1m")
}

export function shortCseId(id: string): string {
  // "cse_01HewnjQGi9z..." → "cse_01HewnjQ"
}
```

## 6. killer.ts 拡張

新規 export:

```ts
export interface KillByPidResult {
  pid: number;
  kind: KillKind;
  succeeded: boolean;
  error?: string;
}

export async function killByPid(
  pid: number,
  ctx: { botPid: number; registryPids: number[]; cseSessionPids: number[] },
  registry: ClaudeRegistry
): Promise<KillByPidResult | { error: string }> {
  const decision = canKill(pid, ctx);
  if (!decision.allowed) return { error: decision.reason };
  try {
    await killPid(pid);  // 既存関数
    if (decision.kind === "registry") registry.remove(pid);
    return { pid, kind: decision.kind, succeeded: true };
  } catch (err) { ... }
}
```

`killAllClaudes` を `killAllRegistryAndCse(registry, cseSessionPids)` に拡張。registry kill loop の後に cse PID を kill する loop を追加。

## 7. commands.ts 変更

### handleClaudeList (新規)

```ts
async function handleClaudeList(interaction): Promise<void> {
  if (process.platform !== "win32") {
    return interaction.reply({ content: "Windows 専用です (PowerShell 依存)", ephemeral: true });
  }
  const procs = await listClaudeProcesses();
  const classified = classify(procs, claudeRegistry.list());
  const text = formatList(classified);
  await interaction.reply({ content: "```\n" + text + "\n```", ephemeral: true });
}
```

### handleClaudeExit (拡張)

```ts
async function handleClaudeExit(interaction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const pidOpt = interaction.options.getInteger("pid");
  
  if (pidOpt !== null) {
    // 単一 kill
    const procs = await listClaudeProcesses();
    const classified = classify(procs, claudeRegistry.list());
    const ctx = {
      botPid: process.pid,
      registryPids: classified.registry.map(r => r.proc.pid),
      cseSessionPids: classified.cse.map(c => c.proc.pid),
    };
    const result = await killByPid(pidOpt, ctx, claudeRegistry);
    await interaction.editReply(formatKillByPid(result));
  } else {
    // 全 kill (registry + cse)
    const procs = await listClaudeProcesses();
    const classified = classify(procs, claudeRegistry.list());
    const result = await killAllRegistryAndCse(claudeRegistry, classified.cse.map(c => c.proc.pid));
    await interaction.editReply(formatKillReport(result));
  }
}
```

### /help embed update

`/claude-list` 行追加、`/claude-exit` 説明更新。

### /clear description 修正

slash command 登録ファイル (client.ts) で行うので commands.ts は handleClear 不変。

## 8. client.ts 変更

```ts
// /clear: line 62-64
{ name: "clear", description: "Reset this channel's in-memory conversation context" }

// /claude-exit: line 230-232 拡張
{
  name: "claude-exit",
  description: "Bot 起動の Claude セッションと cse_session を終了 (pid 指定で個別 kill)",
  options: [
    { name: "pid", description: "終了する PID (省略時は全 kill)", type: 4, required: false }
  ]
}

// /claude-list: 新規追加
{
  name: "claude-list",
  description: "registry セッションと cse_session を一覧表示",
}
```

## 9. テスト fixtures

`src/claude-bridge/cse-sessions/__tests__/fixtures/`:
- `wmic-3-processes.json` — hub + cse + interactive (今の実環境模倣)
- `wmic-empty.json` — 0 件
- `wmic-single.json` — 1 件 (object 返り)

## 10. デプロイ手順

1. `cd ~/workspace/projects/rhi-discord-bot && npm test` — 全 pass 確認
2. `npm run build` — TypeScript compile
3. `bash setup.sh` (or 該当 deploy script) — bot reload
4. Discord で `/claude-list` を実行、PID 11160 (現存 cse) が `[cse]` で出ること確認
5. `/claude-exit 11160` で kill、PowerShell で claude.exe 数が 1 減ること確認
6. `/claude-exit` (引数なし) で全 kill、registry + cse 全消滅確認
7. `/clear` 実行で claude.exe 数不変であること確認
8. PR 作成 → master merge

## 11. PR 構成

PR は 1 本にまとめる:

タイトル: `feat: /claude-list と /claude-exit 拡張で cse_session 管理可能に`

主な変更:
- Q1-Q5 調査結果と /clear 訂正を spec docs に明記
- inspector / kill-policy / formatter 新規モジュール (TDD)
- killer.ts に killByPid 追加
- /clear description 修正、/claude-exit に pid option 追加、/claude-list 新規
- /help 更新

## 12. リスクと緩和

| リスク | 緩和 |
|---|---|
| PowerShell call 失敗 (env 違い) | inspector で stderr capture + meaningful error |
| hub PID 検出失敗 (cmdline pattern 変更) | hub === null でも cse 判定は parent ID 集計で fallback (将来検討) — 今 phase は hub null なら cse 0 件で安全側 |
| WS memory 巨大値 (overflow) | bigint 化 or MB 表示は number で安全 (上限 ~9 PB) |
| cmdline UTF-8 / 日本語 | PowerShell `ConvertTo-Json` は UTF-8 出力、Node.js execFile encoding utf-8 で OK |
| registry zombie entry kill 試行 | taskkill exit 128 (already dead) も成功扱い (既存 killer の挙動) |
