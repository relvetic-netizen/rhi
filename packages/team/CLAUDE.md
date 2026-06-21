# Project: relvetia-team

File-based multi-agent collaboration system for Claude Code. Enables multiple Claude Code instances to collaborate via MCP tools, file-based mailboxes, and shared task lists.

## Project Status
- See `../CLAUDE.md` for top-level project memory
- See `../.claude/memory-bank/progress/relvetia-team.md` for detailed progress

## Key Paths

```
~/.claude/teams/{team}/config.json          # Team state (members, roles, status, turnLimits)
~/.claude/teams/{team}/inboxes/{agent}.json  # Per-agent message inbox
~/.claude/teams/{team}/guardrails.json      # Optional input/output guardrails
~/.claude/teams/{team}/traces.jsonl         # Append-only span trace log
~/.claude/teams/{team}/turn-counts.json     # Per-agent message counters
~/.claude/teams/{team}/approvals.json       # HITL approval queue
~/.claude/teams/{team}/pending-requests.json # Request/reply registry
~/.claude/teams/{team}/cross-team-requests.json # Cross-team invocation registry
~/.claude/teams/{team}/notes/{agent}.jsonl  # Tier 2: per-agent episodic notes
~/.claude/teams/{team}/knowledge.jsonl       # Tier 3: curated team knowledge
~/.claude/tasks/{team}/{id}.json            # Individual task files
~/.claude/tasks/{team}/.highwatermark       # Prevents task ID reuse
~/.claude/tasks/{team}/.lock                # Task directory lock file
~/.claude/swarm-hooks.mjs                   # Optional user-defined lifecycle hooks
```

## MCP Tools (52 total) — see `scripts/sync-readme.mjs` for drift check

> Drift policy: tool count / test count must match `src/index.js` / `npm test` output. Run `node scripts/sync-readme.mjs --check` to verify (also runs in `npm test` pre-step).

### Team Management
- `team_create(team_name, members[], description?)` — Creates team with auto `team-lead`. Members: `name`, optional `role`, `prompt`, `model`.
- `team_status(team_name)` — Members with activity, unread counts, task summary.
- `team_delete(team_name)` — Removes all data + kills tmux session.
- `team_list()` — Lists all teams.

### Messaging (Any Agent → Any Agent)
- `team_send_message(team_name, to, message, summary?, from?)` — Writes to recipient's inbox. `to="*"` for broadcast. **Any agent can message any other agent.**
- `team_read_inbox(team_name, agent_name, peek?)` — Returns unread messages. Marks read unless `peek=true`. Each message body is capped to ~8KB in the response (disk content unchanged); when truncation fires the reply leads with `[NOTICE:...]` and the MCP envelope carries `structuredContent: { truncated, omitted_count }`.
- `team_member_active(team_name, agent_name, is_active)` — Update active/idle flag.

### Tasks (Shared, Any Agent Can Update)
- `team_create_task(team_name, subject, description?, owner?, blocked_by?)` — Auto-incrementing ID.
- `team_update_task(team_name, task_id, status?, owner?, description?)` — Status: `pending` | `in_progress` | `completed`.
- `team_list_tasks(team_name, status?, owner?)` — Filter by status or owner.
- `team_delete_task(team_name, task_id)` — Removes task.
- `team_complete_task(team_name, task_id, result?, force?)` — Validates `result` against `resultSchema` (if set) and enforces `blockedBy` dependencies before marking completed.

### Handoffs (Phase 2)
- `team_handoff(team_name, to, reason, payload?, input_filter?, task_id?, from?)` — Delivers a structured `<handoff>` envelope, optionally transfers task ownership, flips activity flags, emits a trace event. `input_filter`: `{ name: 'truncate'|'last_n_lines'|'remove_code_blocks'|'none', ... }`.

### Sessions (Phase 2)
- `team_get_session(team_name, agent_name, limit?, since?, unread_only?)` — Full history including read messages. Output is capped to ~24KB; oldest items are dropped (or the single returned item is truncated) when the byte budget is exceeded, with a leading `[NOTICE:...]` line and `structuredContent: { truncated, omitted_count }` in the MCP envelope. Set `RELVETIA_CAP_DISABLE=1` to bypass (dev/harness only). `limit` is now constrained to `0..1000`.
- `team_session_pop(team_name, agent_name)` — Remove and return the most recent item (undo/retry).
- `team_session_clear(team_name, agent_name)` — Clear all items.

### Turn Limits (Phase 3)
- `team_set_turn_limit(team_name, agent_name?, limit)` — Per-agent or team-default cap on outbound messages. Pass `limit=null` to remove.
- `team_reset_turns(team_name, agent_name?)` — Reset counter.
- `team_get_turn_counts(team_name)` — Current counts.

### HITL Approval (Phase 3)
Pass `requires_approval=true` to `team_send_message` or `team_handoff` and the message is held in a pending queue instead of delivered. team-lead receives a notice and resolves it with:
- `team_list_approvals(team_name, status?)` — pending/approved/rejected/all.
- `team_approve_message(team_name, approval_id, approver?)` — delivers the held message.
- `team_reject_message(team_name, approval_id, approver?, reason?)` — notifies sender.

### Agents-as-Tools (Phase 3)
Bounded request/response subtasks — the caller BLOCKS until the callee replies or timeout.
- `team_request(team_name, to, prompt, timeout_ms?, from?)` — sends a tagged request, polls caller's inbox for `in_reply_to=request_id`, returns the reply (or times out).
- `team_reply(team_name, request_id, response_text, from)` — callee writes the response; requester is auto-resolved from the pending-requests registry.
- `team_request_async(team_name, to, prompt, summary?, from?, urgency_hint_ms?)` — fire-and-forget variant of `team_request`. Returns immediately with `request_id` (prefix `areq_`). Recipient may reply via `team_send_message` (optional, no auto-resolution). Does NOT touch `pending-requests.json`. For orchestrators dispatching parallel work without blocking. Broadcast `to="*"` not supported in v1.

### Memory / Briefing (Phase 5) — cross-session knowledge
Three-tier memory: inbox (ephemeral) / per-agent notes (episodic) / team knowledge (curated).
- `team_note(team, agent, kind, content, topic?, task_id?, tags?)` — agent writes a structured note. `kind` ∈ `finding | decision | assumption | open_question | next_step | gotcha`.
- `team_remember(team, content, topic?, source_agent?, tags?)` — promote a fact to team-wide knowledge.
- `team_list_notes(team, agent, kind?, topic?, since?, limit?)` — browse an agent's notebook.
- `team_search_memory(team, query, scope?, agent?, kind?, limit?)` — boolean search across Tier 2 + Tier 3 (and optionally relvetia logs). Non-empty queries are reordered by TF-IDF + recency screening; the boolean matcher (`-token`, quoted phrase, OR) stays a hard filter. `limit` defaults to 20 (max 200); the formatted response is byte-capped at ~16KB with a leading `[NOTICE:...]` and `structuredContent: { truncated, omitted_count }`.
- `team_build_briefing(team, agent, topics_of_interest?, finding_days?)` — preview a structured briefing (state + consistency + recent findings + team knowledge + open tasks). When `topics_of_interest` is supplied, findings and knowledge are substring-filtered then reordered by TF-IDF + recency screening (essential / consistency groups are never filtered).
- `team_prime_agent(team, agent, ...)` — same as build_briefing but ALSO delivers it to the agent's inbox as a `past-self` message (called at session resume).
- `memory_search(query, maxResults?, scoreStrategy?)` — screening-aware search over relvetia persistent memory (`~/.claude/memory/`, override via `RELVETIA_MEMORY_DIR`). Uses the same TF-IDF + Trim-and-Square + 5-stage retrieval engine as the saga 5 baseline-v3 (Path A loose Recall@5 ≥94% / MRR ≥0.93); items below the absolute screening threshold are completely excluded. Distinct from `team_search_memory` (which is a boolean matcher over team notes/knowledge + an optional relvetia log bridge); both co-exist with zero overlap (saga 6 §3.4). Read-only.
- `memory_remember(content, tags?)` — append a single timestamped line to today's relvetia daily log (`~/.claude/memory/logs/YYYY/MM/YYYY-MM-DD.md`, JST minute precision). The only one of the four saga 8 memory tools (`memory_search` / `memory_remember` / `memory_log_recent` / `memory_status`) that mutates the relvetia memory dir; the other three are read-only. NOTE: pre-existing `team_remember(also_log_to_relvetia=true)` is a separate coexisting write path via the same `appendRelvetiaLog` (server-wide = 2 relvetia-log writers, not 1). memory_remember writes ONLY to the daily log file (stats.json / index.json / MEMORY.md / concepts/graph.json never touched — invariant enforced by `relvetia-memory-tools.test.js` production-invariant sentinel + contract-claim sentinel). Tags serialise as a `[tag1][tag2]` prefix. Set `$RELVETIA_MEMORY_DIR` for test isolation.
- `memory_log_recent(days?, limit?)` — read structured entries from the relvetia daily logs within the last `days` days (default 1 = today only, max 30), newest-first, capped at `limit` (default 100, max 500). Each line is parsed into `{ date, time, content, tags, file, topic, timestamp }`. Read-only; chronological tail without relevance ranking (distinct from `memory_search`).
- `memory_status()` — summarise relvetia memory state: MEMORY.md line count, `topics/*.md` file count (recursive), `logs/YYYY/MM/*.md` file count, log date range (`firstDate / lastDate / totalDays`), `index.json` entry count, last distillation timestamp (parsed from "Last distilled:" line in MEMORY.md, fallback `.last-distill` mtime). Read-only; equivalent to `/relvetia status` slash command.
- `daemon_status()` — probe the `relvetia-daemon` PM2 process state + scheduler lock file health. Reads `pm2 jlist` (JSON; graceful when pm2 binary absent → `pm2State='unknown'`) and the lock file at `$RELVETIA_DIR/.claude/.scheduler.lock` (default `~/.claude/relvetia/.claude/.scheduler.lock`). Returns `{ pm2State: online|stopped|errored|unknown, lockFile: {exists,pid,alive}, uptime, restartCount, recentRestart }`. Read-only.

`team_complete_task` now appends a reminder to record notes. `team_evaluate_task` auto-promotes items in the judge's `promote_to_knowledge[]` array.

Storage:
- `~/.claude/teams/{team}/notes/{agent}.jsonl` — append-only per-agent notes
- `~/.claude/teams/{team}/knowledge.jsonl`    — append-only curated team knowledge

### Clone / Evaluator / Cross-Team (Phase 4)
- `team_clone_member(team_name, from_name, to_name, overrides?)` — Agent.clone() equivalent. Produces a member with the source's fields + any overrides (role, prompt, model, color, cwd).
- `team_evaluate_task(team_name, task_id, evaluator, timeout_ms?, from?)` — sends the task subject + description + result to a judge agent via team_request, appends the verdict to the task. A JSON block like `{"passed": bool, "score": number}` in the judge's reply is parsed into structured fields.
- `team_invoke(source_team, source_agent, target_team, target_agent, prompt, timeout_ms?)` — cross-team agents-as-tools. Wraps the prompt in a `<cross-team-request>` envelope containing source metadata, polls the source inbox for the reply.
- `team_cross_reply(source_team, source_agent, request_id, from_team, from_agent, response_text)` — callee writes the response back to the source team's inbox.

### Dynamic Prompts
- `team_render_prompt(team_name, agent_name, template)` — Substitute `{team}`, `{agent}`, `{role}`, `{members}`, `{unread_count}`, `{open_tasks}`, `{total_tasks}` with live state.

### Relvetia Admin (saga 9 Phase 3) — daemon scheduled-task + walker surface
File-only operations against `~/.claude/relvetia/.claude/scheduled_tasks.json` (override via `$RELVETIA_DIR`) and the walker `schedule.json` (override via `$RELVETIA_WALKER_SCHEDULE_PATH`). Mutation paths land on `scheduled_tasks.json` ONLY; production memory files (stats.json / index.json / MEMORY.md / concepts/graph.json) are NEVER touched (invariant pinned by `relvetia-admin-tools.test.js` production-invariant sentinel + per-tool contract-claim sentinels).

- `distill_mark_fired(force?, taskId?)` — **bookkeeping only** (saga 9 Phase 3-revA P0 rename from `distill_trigger`): set `lastFiredAt = now` for a distill-family task (relvetia-dream / verify / optimize) in scheduled_tasks.json. **DOES NOT invoke the distill subprocess AND DOES NOT affect the daemon's nextFireAt schedule** (the daemon's `nextFireAt` in `relvetia-daemon/src/scheduler.ts` L142-162 is an in-memory cache not invalidated by external file changes). Intended use = recording manual distill (operator runs `/relvetia dream` outside the daemon, then calls this tool so `distill_status` reflects the fact). For real triggering, use `/relvetia dream`; to shift the daemon schedule, restart `pm2 relvetia-daemon`. 6h cooldown gate; `force=true` bypasses. Saga 9 §17 NEW Lesson D lived practice (call graph + execution semantics 全 verify).
- `distill_status()` — read-only view of the three STATIC_PERMANENT_TASKS (relvetia-dream / verify / optimize, mirrored from `relvetia-daemon/src/bootstrap.ts` L27-53). Saga 10 Phase 4-2 P2 #3: returns `{ tasks, static, dynamic }` where `tasks` keeps its prior shape (the 3 STATIC entries, backward compat), `static` aliases `tasks`, and `dynamic` surfaces every non-STATIC entry from `scheduled_tasks.json` (walkers + ad-hoc `scheduled_task_create` entries). Each STATIC entry: `{ id, cron, lastFiredAt, nextFireAt:null, permanent, registered }`. Each dynamic entry adds `cronAcceptedByLocalValidator: boolean` (saga 10 revB P1 #5 + revD honest scope: the result of the file-local 5-field cron validator (isValidCronExpression) — the **local 5-field cron validator only**, NOT a full daemon-acceptance check. `true` = local validator passed; the daemon may still drop the entry on other grounds (missing prompt/createdAt/id, etc.). `false` = local validator rejected; the daemon (which uses the `croner` library) may still accept croner-only syntax such as day-of-week aliases (`MON`, `TUE`, ...) and shortcuts (`@daily`, 6-field crons). Full daemon-side mirror is saga 11+ scope). `nextFireAt` is always null (predictive next-fire lives in the daemon's in-memory `nextFireAt` cache).
- `walker_status()` — read-only view of `~/.claude/relvetia/persona/walkers/schedule.json`. Expands HH:MM → 5-field cron and joins lastFiredAt from scheduled_tasks.json by id. Returns walkers=[] when schedule.json is missing or malformed JSON.
- `scheduled_task_list(includePermanent?)` — read-only list of scheduled_tasks.json. `includePermanent=true` (default) returns the full list; `false` filters out bootstrap-registered permanent tasks.
- `scheduled_task_create(cron, prompt, recurring?)` — append a new (non-permanent) task. Generates 8-char hex id; `recurring` defaults to true. permanent flag NEVER set by this tool (bootstrap-only).
- `scheduled_task_cancel(id)` — remove a non-permanent task by id. Refuses to remove permanent=true tasks (would just confuse the operator — daemon re-creates them on next restart). To suppress walkers, edit schedule.json.

### Other (auto-stub)
- `team_prune_approvals(...)` — TODO: describe this tool (auto-added by sync-readme)
- `team_run_evaluated_task(...)` — TODO: describe this tool (auto-added by sync-readme)
- `team_run_consensus_task(team_name, worker, evaluators[], prompt, from?, quorum?, max_revisions?, timeout_ms?)` — worker → N parallel schema-validated evaluators → quorum loop. Each round: worker produces an answer, N evaluators independently judge it in parallel; default-ACCEPT semantics (accept iff no evaluator explicitly says `passed=false`; abstains from schema-failed evaluators do NOT block ACCEPT). When `quorum` is given, require that many `passed=true` votes for ACCEPT (stricter). On revise, feedback from refuting evaluators is deduped by first 80 chars and merged into the worker revision prompt. Inspired by bun's `phase-h-diff-review.workflow.js` 2-vote pattern.
- `private_memory_search(...)` — TODO: describe this tool (auto-added by sync-readme)
- `team_add_watch(...)` — TODO: describe this tool (auto-added by sync-readme)

## Evaluator Schema Validation (Pattern A)

All judge replies in `evaluate_task` / `team_run_evaluated_task` / `team_run_consensus_task` are validated against `EVALUATOR_RESPONSE_SCHEMA` ({ passed: bool [required], score: number, feedback: string }). On schema mismatch the evaluator gets ONE re-prompt with the previous response inlined and an explicit schema reminder; on second failure the vote falls back to `passed=null, score=null, feedback="[schema-validation-failed] ..."` and emits `evaluator.schema_fail_final` to traces. Backwards-compatible — evaluators that already return clean JSON on first try see no behavior change.

## Structured Task Output (Phase 2)

Tasks now support an optional `result_schema` (JSON Schema subset: type / required / properties / items / enum) and a `result` field populated by `team_complete_task`. The schema is validated before the task is marked completed; failure returns the errors and leaves status unchanged. `blockedBy` dependencies are enforced at completion — unfinished blockers block the transition unless `force=true`.

## Observability (Phase 1)

### Tracing
All MCP tool calls emit spans to `~/.claude/teams/{team}/traces.jsonl` (append-only JSONL). Nested spans share `trace_id` via AsyncLocalStorage. Disable with `CLAUDE_SWARM_DISABLE_TRACING=1`. Custom processors registerable via `addProcessor(fn)` in `src/tracing.js`.

### Guardrails
Optional per-team config at `~/.claude/teams/{team}/guardrails.json`:
```json
{
  "input":  [{ "type": "max_length", "limit": 10000, "action": "block" }],
  "output": [{ "type": "blocklist",  "patterns": ["password"], "mode": "substring", "action": "redact" }]
}
```
Built-in types: `max_length`, `min_length`, `blocklist` (substring|regex), `required_from`. Actions: `block`, `truncate`, `redact`. `redirect_to` sends the guardrail notice to a fallback recipient (e.g., team-lead).

### Lifecycle Hooks
Optional user file at `~/.claude/swarm-hooks.mjs`. Export handlers for events:
- `before_tool({ tool, args })`
- `after_tool({ tool, args, result, error, duration_ms })`
- `on_message({ team, to, from, message })`
- `on_task_update({ team, task_id, updates, task })`

Hook errors are logged and swallowed (never crash the server).

## Communication Topologies

### Hub (default)
All messages flow through team-lead. Use when synthesis or complex coordination is needed.
```
researcher → team-lead → implementer
```

### Mesh
Agents message each other directly. Team-lead is CC'd.
```
researcher → implementer (direct)
both → team-lead (CC summary)
```
Enable by telling agents: "Send findings directly to implementer AND CC me."

### Broadcast
`to: "*"` sends to all members except sender.

## Engineering Skills Integration

Agent init prompts automatically include a catalog of 20 production-engineering
skills **vendored** from [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills)
(MIT). Skills are grouped into 6 phases (define / plan / build / verify / review
/ ship) with a role-aware shortlist.

- **Vendored**, not fetched: `skills/engineering/<name>/SKILL.md` ship in this
  repo so agents `Read` them locally. No runtime network dependency. See
  `skills/engineering/UPSTREAM.md` for the pinned commit SHA and sync procedure.
- Implementation: `src/agent-skills.js` exports `buildSkillsSection(role)`,
  which builds the role-aware skills catalog. The absolute vendor path is
  injected into agent prompts so invocation is `cwd`-independent.
- Skill invocation by agents:
  - Plugin installed → use the matching phase slash command (`/spec`, `/plan`,
    `/build`, `/test`, `/review`, `/ship`). `/code-simplify` is an extra,
    non-phase command for the `code-simplification` skill specifically.
  - Otherwise → `Read` the local `skills/engineering/<skill-name>/SKILL.md`.
- Role buckets (auto-inferred from `member.role`): coordinator, researcher,
  implementer, reviewer, tester, shipper; unknown roles fall back to `generalist`.
- Meta reference: `skills/engineering-skills.md` documents the full integration
  for agents reading the local skills directory.

## MCP Server Registration

**Recommended**: Register with user scope (works from any directory):
```bash
claude mcp add --transport stdio relvetia-team --scope user -- node /path/to/relvetia-team/src/index.js
```

**Important**: `.mcp.json` is only read from Claude Code's current working directory (CWD). It does NOT search parent directories. Use `--scope user` to register globally in `~/.claude.json`.

| Scope | Command | Config File |
|---|---|---|
| User (recommended) | `claude mcp add --scope user` | `~/.claude.json` |
| Project | `claude mcp add --scope project` | `.mcp.json` (CWD only) |

Management commands:
```bash
claude mcp list          # List registered servers
claude mcp remove relvetia-team --scope user  # Unregister
```

## Environment Variables

| Variable | Set By | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | User (optional) | Override `~/.claude` |

## Common Patterns

### As Team Lead
1. Create tasks BEFORE sending messages
2. Choose topology (hub/mesh) based on workflow
3. For mesh: instruct agents to CC you on direct messages
4. Use `team_status` to monitor without reading every message
5. Synthesize results when all tasks complete

### As Agent
1. Check inbox at start of work
2. Read assigned tasks (`team_list_tasks(owner=your_name)`)
3. Update task to `in_progress`, do work, update to `completed`
4. Report to team-lead (hub) or directly to next agent (mesh) + CC team-lead
5. Check inbox for follow-up

## Concurrency & Safety

- File locking: `proper-lockfile`, 30 retries, 5-100ms backoff (10+ agents)
- Separate `.lock` files (not data files)
- Atomic writes: tmp→rename pattern
- Crash-safe task IDs: dual source (HWM file + directory scan)
- Schema validation on task reads
- Corrupt JSON recovery in mailbox (treated as empty, logged)
- safeTool wrapper: MCP server never crashes on I/O errors

## Development

- Runtime: Node.js ES modules (`"type": "module"`)
- Dependencies: `@modelcontextprotocol/sdk`, `proper-lockfile`, `zod`
- No build step: `node src/index.js` runs directly
- Tests: `npm test` (covers lockfile / tasks / mailbox / approvals / handoffs / sessions / turns / requests / cross-team / clone / evaluator / memory / briefing / structured-output / tracing / hooks / guardrails / agent-skills / prompt-template / bugfix-regressions)
