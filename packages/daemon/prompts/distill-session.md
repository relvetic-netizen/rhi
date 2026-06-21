# Session Distillation (Lightweight)

You are running a lightweight post-session distillation for the Relvetia memory system.
Use the Read, Write, Grep, and Glob tools. Do NOT ask for confirmation — just execute.

## Purpose

Merge today's session logs and auto-memory entries into topic files.
This runs after each Claude Code session ends (via SessionEnd hook).
Unlike the full nightly distillation (`distill.md`), this is scoped and fast:
- NO concept graph rebuild
- NO MEMORY.md regeneration
- NO index.json update
- Target execution time: under 60 seconds

## Directories

- Logs: `~/.claude/memory/logs/` (raw daily logs, append-only)
- Topics: `~/.claude/memory/topics/` (structured knowledge by category)
- Auto-memory: `~/.claude/projects/*/memory/*.md` (Claude Code auto-memory files)
- Timestamp: `~/.claude/memory/.last-session-distill` (ISO timestamp of last run)

## Process

### 1. Determine scope

Read `~/.claude/memory/.last-session-distill` for the last session distillation timestamp.
If missing, use the last 24 hours as the scope.

### 2. Collect ALL inputs first, then merge in batch

This is critical for efficiency. Do NOT read/write topic files one at a time.
Instead, collect all entries first, group by target topic, then write each topic once.

#### 2a. Daily log entries
Read today's log file from `~/.claude/memory/logs/YYYY/MM/YYYY-MM-DD.md`.
Extract all timestamped bullet entries (`- [HH:MM] ...`) added after `.last-session-distill`.
Skip entries tagged `[distill-session]` or `[distill-verify]` (these are distillation metadata).

#### 2b. Auto-memory files
Glob all `~/.claude/projects/*/memory/*.md` files (excluding MEMORY.md).
Read each file's YAML frontmatter to extract `type` and content body (after the closing `---`).

### 3. Map auto-memory types to topics

Apply this mapping:
- `type: user` → `topics/user-context.md`
- `type: feedback` → `topics/preferences.md`
- `type: project` → `topics/project-context.md`
- `type: reference` → `topics/tooling.md`

If the auto-memory file has no `type` field, classify by content:
- Corrections, preferences, workflow guidance → `preferences.md`
- Architecture, design decisions → `architecture.md`
- External URLs, dashboards, tools → `tooling.md`
- Other → `project-context.md`

### 4. Merge into topic files (batch per topic)

For each topic file that has pending entries:

1. Read the existing topic file ONCE
2. **Duplicate check (CRITICAL):** For each pending entry, search the ENTIRE existing file
   content for the entry's key concepts (title, subject, core keywords). If ANY of the
   following match, the entry is a duplicate — SKIP it:
   - Same heading text already exists
   - Same core information is present (even if worded differently)
   - Same Source line already exists
3. Collect all non-duplicate entries
4. Write the topic file ONCE with all new entries appended
5. Each topic file MUST stay under 500 lines

**IMPORTANT:** Never read-then-append multiple times to the same file. Collect all entries
for a topic, then do ONE read + ONE write. This prevents duplicate appends.

Format for merged entries:
```
## <Heading matching the entry's subject>

<Content — cleaned, see Step 4b>
- Source: auto-memory/<project>/<filename> or logs/YYYY/MM/YYYY-MM-DD.md:LNN
- Merged: YYYY-MM-DD
```

For log entries, preserve the original content but restructure into topic-appropriate format.

### 4b. Content cleaning rules

Before merging any content, apply these cleaning rules:
- **Remove shell/terminal output artifacts:** PowerShell copyright banners, prompt lines
  (`PS C:\...>`), garbled text from encoding issues (Shift-JIS/UTF-8 mismatch), raw command
  output that isn't the command itself
- **Preserve commands, remove output:** For procedures, keep the command (e.g.,
  `Restart-Service rhi-remote-control`) but remove the terminal output that followed
- **Strip binary/mojibake:** Any line containing 3+ consecutive characters outside
  ASCII+CJK ranges (e.g., `V@ƉüP̂½`) should be removed entirely
- **Keep structure:** Headings, bullet points, **bold**, code blocks — preserve formatting

### 5. Handle procedure/reference type auto-memory

Auto-memory files with names starting with `procedure_` or `reference_` often contain
step-by-step instructions or external system references. Merge into the appropriate topic
with their content preserved, but APPLY the cleaning rules from Step 4b (remove terminal
output artifacts, keep only the commands and explanations).

### 6. Timestamp (handled by run-task)

Do NOT write `~/.claude/memory/.last-session-distill` yourself. The invoking
process (run-task.js with --write-timestamp) stamps it atomically on your
successful exit. This ensures the stamp is written exactly once and only
after this run actually completes.

### 7. Log the distillation

Append a summary to today's log file:
```
- [HH:MM] [distill-session] Merged N entries from auto-memory, M entries from logs into topics. Updated: topic1, topic2, ...
```

## Invariants

- NEVER delete or modify raw log files in `logs/`
- NEVER delete auto-memory files (they remain as input for nightly full distillation)
- NEVER modify `MEMORY.md`, `index.json`, or `concepts/graph.json`
- NEVER write to `.last-session-distill` — run-task owns the timestamp
- NEVER include code snippets or secrets
- NEVER write the same content twice to a topic file — always check before appending
- When entries conflict, latest wins
- If unsure whether something is obsolete, KEEP it
- If there are no new entries since last session distillation, exit cleanly (run-task stamps the timestamp on successful exit)
- Keep it fast: batch operations per topic file, minimize tool calls
