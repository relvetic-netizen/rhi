/**
 * RELVETIA Daily Log Memory System (extracted from claude-code/src/memdir/memdir.ts)
 *
 * 長期セッション用の追記専用メモリシステム。
 * MEMORY.md をリアルタイムに書き換えるのではなく、日次ログファイルに追記し、
 * 夜間の蒸留プロセスで MEMORY.md に集約する。
 *
 * ディレクトリ構造:
 *   <memoryDir>/
 *   ├── MEMORY.md                    # 蒸留済みインデックス（自動生成）
 *   └── logs/
 *       └── YYYY/
 *           └── MM/
 *               └── YYYY-MM-DD.md   # 日次ログ（追記専用）
 *
 * ログエントリの例:
 *   - [10:23] ユーザーは bun を npm より好む
 *   - [14:05] デプロイ期限は4/15、staging環境で先にテスト必要
 *   - [16:30] Slack #incidents チャネルでアラート監視中
 */

import { join } from 'path'

// 記録すべきでないもの（元コードの WHAT_NOT_TO_SAVE_SECTION に相当）
const WHAT_NOT_TO_SAVE = [
  '## What NOT to log',
  '- Code snippets or file contents (they are in the repo)',
  '- Transient implementation details (variable names, line numbers)',
  '- Anything derivable by reading the codebase',
  '- Secrets, credentials, or tokens',
]

/**
 * 日次ログのシステムプロンプトを生成する。
 *
 * 元の実装ポイント:
 * - パスはパターンとして記述（`YYYY-MM-DD`）。実際の日付はプロンプトキャッシュ
 *   を壊さないよう、コンテキストの `currentDate` から導出させる。
 * - 日付ロールオーバー: 深夜を跨ぐ長期セッションでは、新しい日のファイルに
 *   切り替える。`date_change` アタッチメントで通知。
 */
export function buildAssistantDailyLogPrompt(memoryDir: string): string {
  const logPathPattern = join(memoryDir, 'logs', 'YYYY', 'MM', 'YYYY-MM-DD.md')

  const lines: string[] = [
    '# auto memory',
    '',
    `You have a persistent, file-based memory system found at: \`${memoryDir}\``,
    '',
    "This session is long-lived. As you work, record anything worth remembering by **appending** to today's daily log file:",
    '',
    `\`${logPathPattern}\``,
    '',
    "Substitute today's date (from `currentDate` in your context) for `YYYY-MM-DD`. When the date rolls over mid-session, start appending to the new day's file.",
    '',
    'Write each entry as a short timestamped bullet. Create the file (and parent directories) on first write if it does not exist. Do not rewrite or reorganize the log — it is append-only. A separate nightly process distills these logs into `MEMORY.md` and topic files.',
    '',
    '## What to log',
    '- User corrections and preferences ("use bun, not npm"; "stop summarizing diffs")',
    '- Facts about the user, their role, or their goals',
    '- Project context that is not derivable from the code (deadlines, incidents, decisions and their rationale)',
    '- Pointers to external systems (dashboards, Linear projects, Slack channels)',
    '- Anything the user explicitly asks you to remember',
    '',
    ...WHAT_NOT_TO_SAVE,
    '',
    '## MEMORY.md',
    '`MEMORY.md` is the distilled index (maintained nightly from your logs) and is loaded into your context automatically. Read it for orientation, but do not edit it directly — record new information in today\'s log instead.',
    '',
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. **Preferred**: Use the `MemorySearch` tool for relevance-based search.',
    '   It uses screening (absolute threshold filtering) to return only genuinely',
    '   relevant results — irrelevant files are completely excluded, not just ranked lower.',
    '2. **Fallback**: If MemorySearch is unavailable, use grep:',
    '```',
    `grep -rn "<search term>" ${memoryDir} --include="*.md"`,
    '```',
    '3. Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
  ]

  return lines.join('\n')
}
