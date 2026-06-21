# /claude-list と /claude-exit 拡張 仕様書

> 関連: `docs/specs/claude-list-kill-investigation.md` (調査プロンプト) / `docs/plans/claude-list-kill-plan.md` (実装計画)

## 1. 背景

Anthropic Code Session (cse_xxx) は `claude.ai/code` web UI から起動された Claude セッションで、ローカル PC 上では `claude.exe --sdk-url https://api.anthropic.com/v1/code/sessions/cse_xxx --session-id cse_xxx ...` の child として常駐する。parent は rhi-remote-control NSSM hub PID (typically 8568)。

これらのセッションを終了する手段が現状ほぼ無い:

- web UI の Stop ボタンは届かないことがある
- desktop app の `/exit` は SDK session に効かない
- 既存 `/claude-exit` は registry.json 登録済み PID (`/claude` で起動した detached) のみ対象、cse_session は対象外
- 結果: 古い cse_session が dangling → メモリ累積 (1 session ~330 MB)

## 2. ユーザー要望

- `/claude-list`: registry session + cse_session 両方を一覧、種別バッジ付き
- `/claude-exit`: 拡張 — 引数なし=全 kill / `<pid>` 引数=指定 PID kill (即 kill、confirm 不要)
- 旧 `/clear` の description は誤解を招くので修正 (機能不変)

## 3. 調査結果 (実機検証済 2026-04-26)

### 3.1 cse_session の transcript 保存場所

**ローカルには存在しない**。

検証手順:

- `find ~/.claude/projects -name "*.jsonl" | xargs grep -l "cse_01HewnjQGi9zStJVbDsgyZC3"` → 0 件 (current session jsonl の false positive を除く)
- `~/.claude/sessions/<PID>.json` も interactive (`kind=interactive`) のみ作成、cse_session 用 11160.json は存在せず

→ cse_session の会話内容は **Anthropic cloud のみで保持**。ローカル抽出可能なのは process command line 経由の cse_id, PID, age, working set memory のみ。

### 3.2 cse_session ID と PID の紐付け

PowerShell `Get-CimInstance Win32_Process -Filter "Name='claude.exe'"` の `CommandLine` から:

- `--session-id (cse_[a-zA-Z0-9_]+)` を regex 抽出
- `ParentProcessId == hub PID` で cse_session 判定 (hub PID は実行時 detect — `claude.exe ... remote-control` のプロセスを検索)

### 3.3 title / summary 抽出 — **不可能**

調査プロンプトの `(a)` 最初の user message / `(b)` 最後の assistant message / `(c)` 最後の user message は **全て cloud-only により実現不可**。`(d)` Anthropic API 経由のメタデータ取得は spec で「avoid」と明記。

→ 代替指標: PID + short cse_id (8 桁) + age (h/m) + working set MB + parent PID。

### 3.4 既存 `/clear` の挙動 (ユーザー認識誤りの訂正)

`/clear` (`commands.ts:199-227`) は **OS プロセスを kill しない**:

- persona モード channel → `clearGuildSession()` で in-memory persona session 破棄
- 通常 channel → `sessionManager.destroySession()` で channel-scoped session 破棄

いずれも Discord bot プロセス内部のオブジェクトのみ操作。**OS プロセスへの taskkill は一切無い**。

実際にプロセスを kill するのは `/claude-exit` (`commands.ts:666-681`) で、registry.json 登録 PID のみが対象。

→ `/clear` の slash command description「Clear the current Claude Code session」は **誤解を招く** ので、本仕様で description のみ修正 (機能は不変)。

## 4. 仕様

### 4.1 `/clear` (description のみ修正)

|             | before                                  | after                                                 |
| ----------- | --------------------------------------- | ----------------------------------------------------- |
| description | `Clear the current Claude Code session` | `Reset this channel's in-memory conversation context` |

機能は不変 (handleClear ロジック維持)。

### 4.2 `/claude-list` (新規)

権限: `allowedUserIds` に含まれる operator のみ。

挙動:

1. PowerShell で全 `claude.exe` プロセス scan
2. registry.json を読み、registry session を確定
3. cse*session を `(parent==hub) ∧ (cmdline matches --sdk-url ... cse*\*)` で判定
4. 種別バッジ付きで ephemeral 表示

表示フォーマット (monospace code block):

```
🔧 Active Claude processes (3)

[registry] PID 18488  | claude-1     | cwd=C:\Users\youruser           | 2h 15m
[cse]      PID 11160  | cse_01HewnjQ | parent=8568 (hub)               | 19h 32m | 336 MB
[cse]      PID 24800  | cse_02ABwxyz | parent=8568 (hub)               |  3h 12m | 215 MB
```

0 件: `現存する Claude プロセス無し。`

### 4.3 `/claude-exit` (拡張)

権限: `allowedUserIds` に含まれる operator のみ (既存と同じ)。

option:

- `pid` (integer, optional) — 指定すると単一 PID のみ kill

挙動:

| パターン   | 動作                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 引数なし   | registry 全 PID + cse_session 全 PID を kill (既存 `killAllClaudes` 拡張)。registry.clear()。confirm 無し。 |
| `pid` 指定 | kill-policy で検証 → 許可なら taskkill /T /F、registry に居れば `registry.remove(pid)`。confirm 無し。      |

description (after): `Bot 起動の Claude セッションと cse_session を終了 (pid 指定で個別 kill)`

### 4.4 kill-policy

```
canKill(pid, { botPid, registryPids, cseSessionPids }):
  if pid == botPid: deny ("bot self-kill 禁止")
  if registryPids.includes(pid): allow (kind="registry")
  if cseSessionPids.includes(pid): allow (kind="cse")
  else: deny ("registry にも cse_session にも該当しない PID")
```

- `botPid` は Discord bot の Node.js プロセス PID (`process.pid`)
- hub PID は kill 対象から自動除外される (registry にも cse 判定にも該当しない)
- self-kill 防止は bot 自身のみ。registry に登録された Claude (interactive 含む) は user 明示指定で kill 可能

### 4.5 種別判定優先順位

同一 PID が registry と cse 両方にマッチした場合: **registry を優先**。実用上ほぼ起き得ないが定義しておく。

## 5. UX

- 全コマンド ephemeral 応答 (operator 以外に見えない)
- `/claude-list` は monospace code block で揃える
- `/claude-exit <pid>` の応答: `Killed PID {pid} (kind={registry|cse})` or `Failed: {reason}`
- `/claude-exit` (引数なし) の応答: 既存 `formatKillReport` を cse 対応に拡張 (`Killed N: ...` に種別を含める)

## 6. プラットフォーム

**Windows only** (`process.platform === "win32"`)。Unix 版 inspector は本仕様スコープ外 (今後の課題)。Unix で `/claude-list` 実行時はエラー応答: `Windows 専用です (PowerShell 依存)`。

## 7. 非目標 (今回扱わない)

- web UI の Stop ボタン挙動改善
- desktop app の /exit 修正
- cse_session の自動 idle kill (cron)
- Anthropic API 経由 session 終了
- registry.json の zombie entry 自動削除 (別 issue)
- README/env.example/Unix inspector — OSS readiness は別 PR
- リポジトリ命名 (`rhi-discord-bot` → 汎用名) は別 issue

## 8. テスト方針

### 単体テスト (vitest)

- `inspector.test.ts`: PowerShell stdout fixture を mock → parse 結果検証 (cse_session/registry/hub の分類、edge case = empty / malformed)
- `kill-policy.test.ts`: 純関数の全分岐 (allow registry / allow cse / deny self / deny unknown / 同時マッチ優先順位)
- `formatter.test.ts`: 整形 (age 0/h/m、cse_id 短縮、0 件、混在)

### 動作確認 (deploy 後 Discord)

- `/claude-list` で current 3 プロセス (hub 8568 / cse 11160 / interactive 18488) のうち、registry+cse 該当 (18488 + 11160) のみ表示されること
- `/claude-exit 11160` で cse_session が確実に消滅 (PowerShell で確認)
- `/claude-exit` (引数なし) で registry+cse 全消滅
- `/clear` は OS プロセスを kill しないこと (PowerShell で claude.exe 数不変を確認)
