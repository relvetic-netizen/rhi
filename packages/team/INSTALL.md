# Installation Guide

Complete setup for relvetia-team — the file-based multi-agent collaboration system for Claude Code.

## Prerequisites

| Requirement | Version | Check |
|---|---|---|
| Node.js | 18+ | `node --version` |
| Claude Code CLI | any recent | `claude --version` |
| git | any | `git --version` |

Claude Code must be signed in. Run `claude` once to authenticate if you haven't.

## Step 1: Clone and install

```bash
git clone https://github.com/relvetic-netizen/rhi.git
cd rhi/packages/team
npm install
```

Verify:

```bash
npm test
# Expected: 201 tests passing across 66 suites
```

If any test fails, stop and check `docs/troubleshooting.md`. Lock errors usually mean stale `.lock` files from a previous run: `find ~/.claude -name "*.lock*" -delete`.

## Step 2: Register the MCP server

**Recommended — user scope** (works from any directory):

```bash
claude mcp add --transport stdio relvetia-team --scope user \
  -- node "$(pwd)/src/index.js"
```

Run this inside the `relvetia-team` directory so `$(pwd)` resolves correctly. The command writes to `~/.claude.json`.

### Verify

```bash
claude mcp list
# Should show:
# relvetia-team (stdio): node /absolute/path/to/relvetia-team/src/index.js
```

### Scope options

| Scope | Flag | Config | Availability |
|---|---|---|---|
| **User** (recommended) | `--scope user` | `~/.claude.json` | All projects |
| Project | `--scope project` | `.mcp.json` (CWD) | Only in that project's directory |

> **Important**: `.mcp.json` is read **only from Claude Code's current working directory**. It does NOT search parent directories. Prefer user scope unless you want per-project isolation.

### Alternative: manual configuration

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "relvetia-team": {
      "command": "node",
      "args": ["/absolute/path/to/relvetia-team/src/index.js"]
    }
  }
}
```

## Step 3: Install the engineering-skills index (optional)

```bash
mkdir -p ~/.claude/skills
cp skills/engineering-skills.md ~/.claude/skills/
```

`engineering-skills.md` is the meta index of the vendored engineering skill catalog.

> The 20 vendored engineering skills (`skills/engineering/<name>/SKILL.md`) do NOT need to be copied to `~/.claude/skills/` — they're loaded by agents on demand via `Read` using the absolute path injected into each agent's init prompt. They stay in the repo so updates flow through normal git history.

## Step 4: Verify end-to-end

Restart Claude Code (exit and reopen), then:

```
You: List teams.
```

Claude should call `team_list` and respond "No teams found." If not:

1. `claude mcp list` — confirm `relvetia-team` is registered
2. `node src/index.js` — should start without error (Ctrl-C to exit)
3. Restart Claude Code — MCP servers load at startup only

You can also run `/mcp` inside Claude Code to see connected servers.

## Step 5: First team

In Claude Code:

```
You: Create a team called "demo" with a researcher and an implementer.
     Create a task for the researcher to investigate README.md.
     Send the researcher instructions to read README.md and message
     findings directly to the implementer, CCing me.
```

Claude drives the team through the MCP tools (`team_create`, `team_create_task`,
`team_send_message`). To run each member as its own Claude Code process, launch
the processes yourself and have each one operate on the shared team via the MCP
tools — all team state lives on the filesystem under `~/.claude/teams/{team}/`.

## Optional: guardrails

Create `~/.claude/teams/{team}/guardrails.json` to validate messages before delivery:

```json
{
  "input": [
    { "type": "max_length", "limit": 20000, "action": "truncate" },
    { "type": "blocklist",
      "patterns": ["password", "api_key"],
      "mode": "substring",
      "action": "redact" },
    { "type": "blocklist",
      "patterns": ["rm -rf /"],
      "mode": "substring",
      "action": "block",
      "redirect_to": "team-lead" }
  ],
  "output": [
    { "type": "blocklist",
      "patterns": ["DROP TABLE"],
      "mode": "regex",
      "action": "block" }
  ]
}
```

Supported rule types: `max_length`, `min_length`, `blocklist` (substring or regex), `required_from`.
Actions: `block`, `truncate`, `redact`. `redirect_to` forwards the blocked message wrapped in a `guardrail` envelope to a fallback recipient (typically `team-lead`).

## Optional: lifecycle hooks

Create `~/.claude/swarm-hooks.mjs` to hook into tool execution and message/task events:

```js
export async function before_tool({ tool, args }) {
  console.error(`[hook] ${tool} called with keys: ${Object.keys(args || {}).join(',')}`)
}

export async function after_tool({ tool, error, duration_ms }) {
  if (error) console.error(`[hook] ${tool} failed after ${duration_ms}ms: ${error}`)
}

export async function on_message({ team, to, from }) {
  console.error(`[hook] msg ${from} → ${to} on ${team}`)
}

export async function on_task_update({ team, task_id, updates }) {
  console.error(`[hook] task #${task_id} updated: ${JSON.stringify(updates)}`)
}

export async function on_handoff({ from, to, reason }) {
  console.error(`[hook] handoff ${from} → ${to}: ${reason}`)
}
```

Hook errors are caught and logged; they never crash the MCP server.

## Platform notes

### macOS

```bash
brew install node git
npm install -g @anthropic-ai/claude-code
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install -y nodejs npm git
# or use nvm for a newer Node.js:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 20
npm install -g @anthropic-ai/claude-code
```

### Windows

Claude Code runs natively on Windows. MCP registration is the same as on other
platforms:

```bash
claude mcp add --transport stdio relvetia-team --scope user \
  -- node C:/path/to/relvetia-team/src/index.js
```

## File layout (what gets created)

When teams are used, relvetia-team creates:

```
~/.claude/
├── swarm-hooks.mjs                 # optional, you create this
├── teams/{team-name}/
│   ├── config.json                 # members, roles, turnLimits, activity
│   ├── inboxes/{agent}.json        # Tier 1: live messages
│   ├── notes/{agent}.jsonl         # Tier 2: per-agent episodic notes
│   ├── knowledge.jsonl             # Tier 3: curated team knowledge
│   ├── traces.jsonl                # span trace log (append-only)
│   ├── guardrails.json             # optional, you create this
│   ├── approvals.json              # HITL queue (auto-managed)
│   ├── turn-counts.json            # outbound counters (auto-managed)
│   ├── pending-requests.json       # agents-as-tools registry
│   └── cross-team-requests.json    # cross-team registry
└── tasks/{team-name}/
    ├── {id}.json                   # one file per task
    ├── .highwatermark              # next task id
    └── .lock                       # directory-level lock
```

Nothing lives outside `~/.claude/` (unless you override with `CLAUDE_CONFIG_DIR`).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override Claude config directory |
| `CLAUDE_SWARM_DISABLE_TRACING` | (unset) | `1` to disable span writes |
| `CLAUDE_SWARM_HOOKS_FILE` | `~/.claude/swarm-hooks.mjs` | Path to hooks module |

## Configuration reference

### MCP registration commands

```bash
# Register
claude mcp add --transport stdio relvetia-team --scope user \
  -- node /path/to/src/index.js

# List
claude mcp list

# Remove
claude mcp remove relvetia-team --scope user
```

## Uninstallation

```bash
# 1. Remove MCP registration
claude mcp remove relvetia-team --scope user

# 2. Remove the engineering-skills index (if installed)
rm -f ~/.claude/skills/engineering-skills.md

# 3. Remove team data
rm -rf ~/.claude/teams ~/.claude/tasks ~/.claude/swarm-hooks.mjs

# 4. Remove the repo (optional)
rm -rf /path/to/relvetia-team
```

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| `team_list` not recognized | `claude mcp list` to verify registration; restart Claude Code |
| MCP registered but not loading | `node src/index.js` should start without error |
| `.mcp.json` not picked up | Reads only from CWD; use `--scope user` instead |
| Stuck lock errors | `find ~/.claude -name "*.lock*" -delete` |
| Messages not delivered | Check exact agent names via `team_status`; names are case-sensitive |
| `team_request` times out | Increase `timeout_ms`; verify callee has `team_read_inbox` running |
| Turn-limit blocks | `team_reset_turns(team)` to clear counters |

More detailed diagnostics: [docs/troubleshooting.md](docs/troubleshooting.md).

## What to read next

- [README.md](README.md) — feature overview and architecture
- [docs/architecture.md](docs/architecture.md) — system design deep dive
- [docs/use-cases.md](docs/use-cases.md) — end-to-end recipes
- [CLAUDE.md](CLAUDE.md) — full MCP tool reference (auto-loaded into Claude Code)
