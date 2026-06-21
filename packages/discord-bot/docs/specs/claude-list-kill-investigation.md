# /claude-list と /claude-kill 実装 調査プロンプト

> 次セッション開始時にこのファイルの内容をそのまま prompt として貼り付けて開始する。
> 設計→実装→test→review→merge の full cycle で進める。

---

## 背景

2026-04-26 夜、WT zombie kill 検証中に判明した課題:

`claude.ai/code` の web UI で開いた Anthropic Code Session (cse_xxx ID) は、ローカル PC 上で `claude.exe --sdk-url https://api.anthropic.com/v1/code/sessions/cse_xxx --session-id cse_xxx --print --replay-user-messages` の child として常駐する (parent は rhi-remote-control NSSM hub PID 8568)。

**これらのセッションを終了する手段が現状ほぼ無い**:

- web UI 側で「Stop」ボタンが session API に届くか不明 (届かないこともある観測)
- デスクトップアプリの `/exit` 命令は SDK session には届かないか効かない
- rhi-discord-bot の既存 `/claude-exit` は **`/claude` 経由で起動した detached PID 専用** (registry.json に登録された PID のみ kill)、cse_session は registry 外なので対象外
- 結果: 古い cse_session が dangling → メモリ累積 (1 session ~330 MB) のリスク

## 目的

rhi-discord-bot に以下 2 コマンド追加:

### `/claude-list`

現存する cse_session を **会話の中身がわかる形で** 一覧表示。出力例:

```
1. PID 11160  | cse_01HewnjQGi9z... | 19.3h | 328 MB
   Topic: "今夜は Layer 5 fix を進めてくれ..."
   Last : "両 PR main merge 完了..." (2026-04-26 01:34)

2. PID 24800  | cse_02ABwxyz1234... | 3.2h | 215 MB
   Topic: "Notion DB 整理を手伝って"
   Last : "テーブルの schema を確認します" (2026-04-26 14:12)
```

「topic」「last」が分かれば、kill していいか即判断できる。何の情報が一番判別に役立つかは調査次第:

- (a) 最初の user message (会話のトピック)
- (b) 最後の assistant message (現在の文脈)
- (c) 最後の user message (進行中タスク)
- (d) cse_session のメタデータ (Anthropic API 側に title 等あれば)

### `/claude-kill <PID>`

指定 PID の cse_session を taskkill。安全装置:

- whitelist 検証: PID が `claude.exe --sdk-url cse_*` パターンの child of hub であることを確認、それ以外は拒否
- Discord で confirm reaction (✅/❌) 30 秒以内、operator (MCP_OPERATOR_ID) のみ反応可
- kill 結果を return (成功/失敗 + 残存 cse_session 数)

## 必読ファイル (この順序で)

1. `~/.claude/CLAUDE.md` (行動原則)
2. `~/.claude/memory/MEMORY.md` (現状コンテキスト)
3. `~/.claude/memory/logs/2026/04/2026-04-26.md` の `[14:54]` 〜 `[17:44]` エントリ (今回の WT kill 経緯 + cse_session 構造発見)
4. **rhi-discord-bot 側**:
   - `~/workspace/projects/rhi-discord-bot/src/discord/commands.ts` (slash command 登録の場所、`/claude` `/claude-exit` の実装)
   - `~/workspace/projects/rhi-discord-bot/src/claude/launcher.ts` (claude detached spawn のロジック)
   - `~/workspace/projects/rhi-discord-bot/src/claude/registry.ts` (PID 登録、`/claude-exit` の kill 対象選定)
   - `~/workspace/projects/rhi-discord-bot/src/claude/killer.ts` (taskkill /T /F の実装)
   - `~/workspace/projects/rhi-discord-bot/.env` の `MCP_OPERATOR_ID` (HITL gate)
5. 既存 `/claude` `/claude-exit` 関連 commits (rhi-discord-bot master): `12c47cd` 周辺

## 調査が必要な事項 (next session で潰す)

### Q1: cse_session の transcript はどこに保存されるか?

- `claude.exe --sdk-url cse_xxx` 起動時、ローカル `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` に書く?
- それとも cloud (Anthropic) 側のみで、ローカルには断片的な実行ログだけ?
- `Get-Content` か `grep -l "cse_01HewnjQGi9zStJVbDsgyZC3" ~/.claude/projects/*/*.jsonl` で実 file 探す
- ローカルに無いなら、Anthropic API 側で session メタデータ取得できるか調査 (`api.anthropic.com/v1/code/sessions/cse_xxx` 等) — 多分 auth 要

### Q2: cse_session ID と PID の紐付け

- `Get-CimInstance Win32_Process -Filter "Name='claude.exe'"` の `CommandLine` から `cse_[a-zA-Z0-9]+` を regex 抽出 (確認済、これは確実)
- bot 側 PowerShell 呼び出し OR child_process.exec で wmic / Get-CimInstance を spawn
- 既存 launcher.ts / killer.ts が PowerShell 使ってないなら新規追加

### Q3: title / summary 抽出方法

- ローカル transcript ある場合:
  - jsonl の最初の `role: "user"` line → first user message
  - 最後の `role: "user"` line → last user message
  - 最後の `role: "assistant"` line → last assistant message
  - jsonl は 1 line = 1 message の JSON、`grep -m 1 '"role":"user"'` 等で抽出可
  - 文字数制限 (Discord 2000 文字制約) → 各 100-150 文字に truncate
- cloud 側のみ (ローカル無い) 場合:
  - Anthropic SDK / API で session 詳細取得できるか確認
  - 取得不可なら fallback: PID + cse_xxx + age + memory のみ表示 (title 無し)

### Q4: kill の安全性

- 既存 killer.ts の `taskkill /T /F` で十分か、それとも graceful exit (SIGTERM 相当) を試すべきか
- kill 後 hub (PID 8568) 側の状態確認 (capacity が 4-1=3 に戻る等)
- self-kill 防止: bot 自身の PID と同じものは絶対 kill しない

### Q5: Discord UX

- `/claude-list` が空 (cse_session 0 個) のとき何を表示するか
- 1 session に対して inline button 「kill」を出す案 (PID 入力不要) vs `/claude-kill <PID>` 引数式
- confirm reaction の timeout (30秒で expire?)
- channel: 既存 `/claude` `/claude-exit` と同じ channel scope に従う (operator-only?)

## 設計上の決め事 (事前合意)

- 既存 registry.json の枠組みは **触らない** (registry は `/claude` spawn 専用)。cse_session は別のトラッキング層
- cse_session の検出は **runtime に毎回 process scan** (永続化しない、process tree が source of truth)
- bot 側コードは TS、PowerShell 呼び出しは `child_process.exec` で
- **不可侵ファイル** (~/.claude/CLAUDE.md, MEMORY.md, settings.json 等) は読取のみ
- **Anthropic API への直接 call は避ける** (auth + rate limit、ローカル process scan で済むなら不要)

## 成果物

- `~/workspace/projects/rhi-discord-bot/docs/specs/claude-list-kill-spec.md` に仕様書
- `~/workspace/projects/rhi-discord-bot/docs/plan/claude-list-kill-plan.md` に実装計画 (task 分割 + PR 分割)
- 実装 PR: bot master に新規 commit、tests pass、deploy 後 Discord で動作確認
- 今夜時点では Anthropic Code Session の動作把握ぐらいで止まってる、ローカル transcript 書込みの有無等は実調査必須

## 非目標 (今回は触らない)

- web UI 側の Stop ボタン挙動改善 (Anthropic 側仕様、コントロール外)
- デスクトップアプリの /exit 修正 (同上)
- cse_session の自動 idle kill (cron / scheduled task で定期削除) — 慎重判断必要、別途検討
- Anthropic API 経由での session 終了 (Q3 で API 利用可と判明したら別 PR で追加検討)

## 関連 memory log entry (引用元)

- 2026-04-26 [14:54-17:44] WT 1.4GB zombie kill 検証で cse_session 構造発見、ゴースト累積懸念の発端

---

## 次セッションの最初の一行

「rhi-discord-bot に /claude-list と /claude-kill <PID> を実装する。docs/specs/claude-list-kill-investigation.md を読んで Q1-Q5 を調査してから設計→実装→test→PR まで full cycle で進める。」
