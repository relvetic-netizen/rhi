# relvetia-team

File-based multi-agent collaboration system for Claude Code. Multiple Claude Code instances collaborate as a team through shared mailboxes, shared task lists, persistent memory, and cross-session briefings.

Inspired by the OpenAI Agents SDK, adapted to a multi-process, file-coordinated model so that agents survive restarts, share knowledge across sessions, and can invoke each other as tools.

## Highlights

- **52 MCP tools** — messaging, tasks, handoffs, sessions, guardrails, memory, cross-team
- **20 vendored engineering skills** (from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), MIT) — production-grade workflows automatically injected into every agent's prompt
- **Three-tier memory** — ephemeral inbox / per-agent episodic notes / curated team knowledge
- **Session re-prime** — agents resume with a structured briefing from their past self
- **Real delegation primitives** — `team_handoff` (transfer) and `team_request` (bounded subtask)
- **Safety layers** — input/output guardrails, HITL approvals, per-agent turn limits
- **Observability** — append-only JSONL span tracing with nested trace_id propagation
- **840 tests, concurrent-safe** — proper-lockfile, atomic writes, crash-safe IDs (verified by `npm test` + `node scripts/sync-readme.mjs --check`)

## Quick Start

```bash
# 1. Install
git clone https://github.com/relvetic-netizen/rhi.git
cd rhi/packages/team && npm install

# 2. Register MCP server (user scope = works everywhere)
claude mcp add --transport stdio relvetia-team --scope user \
  -- node "$(pwd)/src/index.js"

# 3. Restart Claude Code, then build a team with the low-level tools:
#    team_create({ team_name, members: [...] })
#    team_create_task({ team_name, subject, owner, blocked_by: [...] })
#    team_send_message({ team_name, to, message, from: "team-lead" })
```

See **[INSTALL.md](INSTALL.md)** for the complete guide (skills, platform notes, uninstall).

## Usage patterns

Build a team with the low-level tools — create the team, create tasks with
dependencies, then send each member its initial instructions:

```js
team_create({ team_name: "custom", members: [...] })
team_create_task({ team_name: "custom", subject: "...", owner: "...", blocked_by: [...] })
team_send_message({ team_name: "custom", to: "...", message: "...", from: "team-lead" })
```

### Key principle: single source of truth

- **Engineering discipline** (Process / Verification / Red Flags) → `skills/engineering/<name>/SKILL.md`
- **Tool surface** → `src/index.js` (registers MCP tools as thin wrappers; never restates discipline)

This is the discipline behind the codebase: each piece of knowledge lives in exactly one place. Layers reference each other by name, not by paraphrase.

## Why relvetia-team

Single Claude Code session = one context window, lost on exit. That's fine for short tasks but painful when:

- You need **multiple concurrent investigations** (research, implementation, testing in parallel)
- The work spans **hours or sessions** and context keeps getting compacted
- You want **specialized agents** — one for reading docs, one for coding, one for reviewing
- You need **audit trails** and **guardrails** for agent-to-agent messages

relvetia-team gives each role a dedicated Claude Code process, a persistent inbox, shared tasks, and a structured memory system so knowledge accumulates across sessions.

## Communication Topologies

Any agent can message any other agent — the topology is a convention you enforce via prompts.

```
Hub (default)              Mesh                       Broadcast
  researcher                 researcher → implementer   team-lead → *
    ↕                          ↕             ↕
  team-lead                    team-lead (CC'd)
    ↕
  implementer
```

| Topology | When to Use |
|---|---|
| **Hub** | Complex synthesis, single decision-maker, clear accountability |
| **Mesh** | Pipelines (research → implement → test), iterative review |
| **Broadcast** | Kickoffs, shared context updates, team-wide announcements |

## Feature Surface

### Core communication (Phase 0)
- `team_create` / `team_status` / `team_delete` / `team_list`
- `team_send_message(to, message, summary?, from?)` — `to="*"` for broadcast
- `team_read_inbox(agent, peek?)` — returns unread messages; bodies > ~8KB are truncated in the response (disk untouched) with a leading `[NOTICE:...]` and `structuredContent: { truncated, omitted_count }`
- `team_member_active(agent, is_active)`

### Shared tasks (Phase 0, extended in Phase 2)
- `team_create_task(subject, owner?, blocked_by?, result_schema?)`
- `team_update_task(task_id, status?, owner?, description?)`
- `team_complete_task(task_id, result?, force?)` — validates against `result_schema`, enforces `blockedBy`
- `team_list_tasks(status?, owner?)` / `team_delete_task`

### Delegation (Phase 2, Phase 3)
- `team_handoff(to, reason, payload?, input_filter?, task_id?)` — explicit transfer with structured envelope, optional task ownership transfer, optional payload filter (`truncate`, `last_n_lines`, `remove_code_blocks`)
- `team_request(to, prompt, timeout_ms?)` + `team_reply(request_id, ...)` — bounded request/reply subtask; caller blocks until reply or timeout
- `team_request_async(to, prompt, summary?, urgency_hint_ms?)` — fire-and-forget variant; returns immediately with `request_id` (prefix `areq_`). Recipient may reply via `team_send_message` (optional). Used by orchestrators to dispatch parallel work without blocking. No registry; messages tagged in inbox.

### Sessions (Phase 2)
- `team_get_session(agent, limit?, since?, unread_only?)` — full history access. Output capped to ~24KB; oldest items are dropped (or the single returned item is truncated) above the budget, with a leading `[NOTICE:...]` and `structuredContent: { truncated, omitted_count }`. Set `RELVETIA_CAP_DISABLE=1` to bypass (dev/harness only); `limit` clamped to `0..1000`.
- `team_session_pop(agent)` — undo/retry
- `team_session_clear(agent)`

### Safety (Phase 3)
- `team_set_turn_limit(agent?, limit)` / `team_reset_turns` / `team_get_turn_counts` — per-agent or team-wide outbound caps
- `team_list_approvals` / `team_approve_message` / `team_reject_message` — Human-in-the-Loop; flag a send with `requires_approval=true` to queue it

### Observability (Phase 1)
- Auto-instrumented span tracing to `~/.claude/teams/{team}/traces.jsonl`
- Optional `~/.claude/teams/{team}/guardrails.json` for input/output validators
  (`max_length`, `min_length`, `blocklist` substring/regex, `required_from`; actions: block/truncate/redact with optional `redirect_to`)
- Optional `~/.claude/swarm-hooks.mjs` for lifecycle hooks
  (`before_tool`, `after_tool`, `on_message`, `on_task_update`, `on_handoff`)

### Memory / Briefing (Phase 5)
Three-tier persistence — designed so new sessions can pick up where past-self left off.

- `team_note(agent, kind, content, topic?, task_id?, tags?)` — structured personal note; `kind` ∈ `finding | decision | assumption | open_question | next_step | gotcha`
- `team_remember(content, topic?, source_agent?, tags?)` — promote fact to team knowledge
- `team_list_notes(agent, kind?, topic?, since?, limit?)`
- `team_search_memory(query, scope?, agent?, kind?, limit?)` — cross-tier boolean search; non-empty queries are reordered by TF-IDF + recency screening (boolean operators stay as hard filters). `limit` defaults to 20 (max 200) and the reply is byte-capped (~16KB) with a leading `[NOTICE:...]` plus `structuredContent: { truncated, omitted_count }`.
- `team_build_briefing(agent, topics_of_interest?, finding_days?)` — preview; when `topics_of_interest` is set, findings + knowledge are substring-filtered then reordered by TF-IDF + recency screening (essential / consistency groups untouched).
- `team_prime_agent(agent, ...)` — build briefing + deliver to inbox as `past-self` message, so an agent resumes with a recap of prior sessions

### Orchestration primitives (Phase 4)
- `team_clone_member(from_name, to_name, overrides?)` — Agent.clone equivalent
- `team_evaluate_task(task_id, evaluator, timeout_ms?)` — LLM-as-judge; parses the judge's JSON reply for `{passed, score}` and auto-promotes items in `promote_to_knowledge[]` to team knowledge
- `team_invoke(source_team, source_agent, target_team, target_agent, prompt)` / `team_cross_reply(...)` — cross-team agents-as-tools

### Dynamic prompts (Phase 1)
- `team_render_prompt(agent, template)` — substitutes `{team}`, `{agent}`, `{role}`, `{members}`, `{unread_count}`, `{open_tasks}`, `{total_tasks}`

## Architecture

```
┌─ Claude Code processes (one per team member) ───────────────┐
│                                                             │
│  ┌─ team-lead ──┐  ┌─ researcher ──┐  ┌─ implementer ──┐   │
│  │ Claude Code  │  │ Claude Code   │  │ Claude Code    │   │
│  │ + MCP server │  │ + MCP server  │  │ + MCP server   │   │
│  └──────┬───────┘  └──────┬────────┘  └──────┬─────────┘   │
│         └─────────────────┴──────────────────┘              │
│                           ▼                                 │
│                 Shared Filesystem                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ~/.claude/teams/{team}/                               │  │
│  │   ├── config.json               (members, turnLimits) │  │
│  │   ├── inboxes/{agent}.json      (Tier 1: messages)    │  │
│  │   ├── notes/{agent}.jsonl       (Tier 2: episodic)    │  │
│  │   ├── knowledge.jsonl           (Tier 3: curated)     │  │
│  │   ├── traces.jsonl              (span log)            │  │
│  │   ├── guardrails.json           (optional)            │  │
│  │   ├── approvals.json            (HITL queue)          │  │
│  │   ├── turn-counts.json          (hot counters)        │  │
│  │   ├── pending-requests.json     (request registry)    │  │
│  │   └── cross-team-requests.json  (cross-team registry) │  │
│  │ ~/.claude/tasks/{team}/*.json                         │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  In-repo (vendored):                                        │
│  skills/engineering/<name>/SKILL.md   ×20  (MIT)            │
└─────────────────────────────────────────────────────────────┘
```

## Concurrency & Safety

- **File locking**: `proper-lockfile`, separate `.lock` files, 30 retries / 5-100ms backoff
- **Atomic writes**: tmp→rename pattern (no partial writes on crash)
- **Crash-safe task IDs**: dual source — highwatermark file + directory scan (prevents reuse after crash)
- **Corrupt JSON recovery**: inbox/notes treated as empty if unreadable, logged but never crashes
- **safeTool wrapper**: tool handlers never propagate uncaught exceptions; errors become MCP responses
- **Guardrails**: declarative input/output filtering with deterministic actions
- **Turn limits**: runaway-agent circuit breaker with team-lead notification

## Documentation

| Document | Description |
|---|---|
| **[INSTALL.md](INSTALL.md)** | Full installation, hooks, skills, platform notes |
| [Architecture](docs/architecture.md) | System design, data flow, topologies |
| [Use Cases](docs/use-cases.md) | End-to-end recipes with topology recommendations |
| [Troubleshooting](docs/troubleshooting.md) | Common problems and diagnostics |
| [Setup Guide](docs/setup-guide.md) | Condensed setup reference |
| [CLAUDE.md](CLAUDE.md) | AI project memory (auto-loaded by Claude Code) |

## Skills

Engineering discipline (how to do production-quality work) ships as a vendored
skill catalog. [`engineering-skills`](skills/engineering-skills.md) is the meta
index of that catalog.

### Engineering skills (vendored, 20 total)

Vendored verbatim from [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) (MIT). Files live in `skills/engineering/<name>/SKILL.md`. The pinned upstream SHA and sync procedure are in [`skills/engineering/UPSTREAM.md`](skills/engineering/UPSTREAM.md).

Why vendored, not fetched at runtime: agents often run with `--dangerously-skip-permissions`, so SKILL.md content is effectively LLM instructions to an unsandboxed executor. Vendoring moves the trust boundary into this repo (changes go through normal PR review) and removes the runtime network dependency.

Grouped into six phases:

| Phase | Skills |
|---|---|
| **define** | `idea-refine`, `spec-driven-development` |
| **plan** | `planning-and-task-breakdown` |
| **build** | `incremental-implementation`, `test-driven-development`, `context-engineering`, `source-driven-development`, `frontend-ui-engineering`, `api-and-interface-design` |
| **verify** | `browser-testing-with-devtools`, `debugging-and-error-recovery` |
| **review** | `code-review-and-quality`, `code-simplification`, `security-and-hardening`, `performance-optimization` |
| **ship** | `git-workflow-and-versioning`, `ci-cd-and-automation`, `deprecation-and-migration`, `documentation-and-adrs`, `shipping-and-launch` |

Each agent's init prompt automatically gets a role-aware shortlist of these skills (computed by `src/agent-skills.js` from the agent's `role` field). Agents `Read` the SKILL.md they need, on demand. If the [agent-skills marketplace plugin](https://github.com/addyosmani/agent-skills) is installed, slash commands work too: `/spec`, `/plan`, `/build`, `/test`, `/review`, `/ship`, `/code-simplify`.

**Single source of truth principle**: all engineering discipline (Process, Verification, Red Flags) lives in the vendored `SKILL.md` files. Tool schemas reference skills by name and never paraphrase their contents — this avoids drift between layers.

## Runtime

- Node.js 18+ (ES modules, `"type": "module"`)
- Dependencies: `@modelcontextprotocol/sdk`, `proper-lockfile`, `re2`, `zod`
- No build step: `node src/index.js` runs directly
- Tests: `npm test`

## Inspiration

Built by analyzing Claude Code's internal multi-agent team architecture and cross-referencing the OpenAI Agents SDK design. Patterns adopted:

**From Claude Code internals**: `proper-lockfile` configuration, crash-safe ID generation via dual HWM source, atomic file operations, corrupt JSON recovery.

**From OpenAI Agents SDK** (adapted to multi-process, file-based model):
- `Handoff` semantics → `team_handoff` with input filters
- `Sessions` abstraction → `team_get_session` with full history
- `Guardrails` (input/output tripwires) → declarative config
- `Agent.clone()` → `team_clone_member`
- `Agents-as-tools` → `team_request` / `team_invoke`
- `output_type` + structured outputs → task `result_schema` + JSON Schema validation
- `max_turns` + error handlers → per-agent turn budgets with team-lead notification
- `needs_approval` → HITL approval queue
- LLM-as-judge evaluator → `team_evaluate_task` with auto-promotion
- Tracing with `contextvar` → AsyncLocalStorage-backed span nesting

What relvetia-team adds on top that the SDK doesn't provide:
- True multi-process concurrency across independent Claude Code processes
- Pull-based persistent messaging that survives agent crashes
- Three-tier memory with structured session briefings
- Cross-team invocation
- Vendored production-engineering skill catalog (addyosmani/agent-skills) automatically wired into every agent's prompt

**From [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)** (MIT, vendored): the 20-skill production-engineering catalog organized into the 6-phase development lifecycle. relvetia-team automates skill selection per agent role and enforces the single-source-of-truth principle (discipline lives only in `skills/engineering/*/SKILL.md`).

## License

MIT
