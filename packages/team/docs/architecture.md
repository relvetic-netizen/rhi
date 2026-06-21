# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code processes (one per team member)                     │
│                                                                 │
│  ┌─ Process 0 ───────┐  ┌─ Process 1 ───────┐  ┌─ Process N┐  │
│  │ Claude Code        │  │ Claude Code        │  │ ...      │  │
│  │ (team-lead)        │  │ (researcher)       │  │          │  │
│  │                    │  │                    │  │          │  │
│  │ MCP: relvetia-team  │  │ MCP: relvetia-team  │  │ MCP: ... │  │
│  └────────┬───────────┘  └────────┬───────────┘  └────┬─────┘  │
│           │                       │                    │        │
│           └───────────┬───────────┴────────────────────┘        │
│                       │                                         │
│                       ▼                                         │
│              Shared Filesystem                                  │
│  ┌─────────────────────────────────────────────────────┐        │
│  │  ~/.claude/teams/{team}/                            │        │
│  │    config.json            ← Team state              │        │
│  │    inboxes/team-lead.json ← Coordinator inbox       │        │
│  │    inboxes/researcher.json← Agent inbox             │        │
│  │    inboxes/implementer.json← Agent inbox            │        │
│  │                                                     │        │
│  │  ~/.claude/tasks/{team}/                            │        │
│  │    1.json, 2.json, ...    ← Shared tasks            │        │
│  │    .highwatermark          ← ID counter              │        │
│  │    .lock                   ← Directory lock          │        │
│  └─────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

All agents share the same filesystem. Any agent can write to any other agent's inbox. This enables both hub and mesh communication patterns.

## Communication Topologies

### Hub Mode (default)

All communication flows through team-lead. Team-lead coordinates, synthesizes, and forwards information.

```
researcher ──→ team-lead ──→ implementer
     ↑              │              │
     └──────────────┘              │
                    ←──────────────┘
```

**Best for**: Complex tasks where the coordinator needs to synthesize findings before passing them on.

### Mesh Mode

Agents communicate directly. Team-lead is CC'd to stay informed.

```
researcher ──→ implementer (direct)
     │              │
     └─→ team-lead ←┘  (CC'd on both)
```

**Best for**: Pipeline workflows where one agent's output is another's input (research → implement → test).

### Broadcast

Any agent can send to all members using `to: "*"`.

```
team-lead ──→ ALL (announcement)
researcher ──→ ALL (status update)
```

**Best for**: Announcements, status updates, project-wide decisions.

## Data Flow

### Message Delivery (Any Agent to Any Agent)

```
Agent A                  Filesystem                  Agent B
   │                        │                           │
   │ team_send_message()    │                           │
   │ (to: "agent-b")       │                           │
   ├──────────────────────► │                           │
   │  1. Acquire .lock file │                           │
   │  2. Read inbox JSON    │                           │
   │  3. Append message     │                           │
   │  4. Atomic write (tmp→rename)                      │
   │  5. Release lock       │                           │
   │ ◄─────── OK ──────────┤                           │
   │                        │                           │
   │                        │    team_read_inbox()       │
   │                        │ ◄─────────────────────────┤
   │                        │    1. Read inbox JSON      │
   │                        │    2. Filter unread        │
   │                        │    3. Mark all as read     │
   │                        ├──────────────────────────► │
   │                        │    Returns messages        │
```

### Direct Agent-to-Agent with CC

```
researcher                  Filesystem           implementer    team-lead
   │                           │                      │              │
   │ send_message              │                      │              │
   │ (to: "implementer")      │                      │              │
   ├─────────────────────────► │                      │              │
   │                           ├─────────────────────►│              │
   │                           │  implementer inbox   │              │
   │                           │                      │              │
   │ send_message              │                      │              │
   │ (to: "team-lead",        │                      │              │
   │  "CC: sent to impl")     │                      │              │
   ├─────────────────────────► │                      │              │
   │                           ├─────────────────────────────────────►│
   │                           │               team-lead inbox       │
```

### Task Lifecycle

```
team_create_task          team_update_task          team_update_task
     │                         │                         │
     ▼                         ▼                         ▼
  ┌──────┐               ┌───────────┐             ┌───────────┐
  │pending│ ──────────► │in_progress│ ──────────► │ completed │
  └──────┘               └───────────┘             └───────────┘

Any agent can update any task's status.
Task ownership is advisory (not enforced).
blocked_by dependencies are informational (agents check voluntarily).
```

## Component Details

### MCP Server (`src/index.js`)

- **Stateless**: Each Claude Code process runs its own MCP server instance
- **11 tools**: Registered via `@modelcontextprotocol/sdk`
- **safeTool wrapper**: All handlers catch errors and return structured error responses
- **Transport**: stdio (standard for Claude Code MCP servers)
- **Validation**: Zod schemas on all tool inputs

### Team Manager (`src/team.js`)

- CRUD on `config.json` with file locking
- Member status updates (active/idle) under lock
- Team deletion: async tmux kill + per-step cleanup with logging

### Mailbox (`src/mailbox.js`)

- **Write**: Acquire `.lock` file → read inbox → append → atomic write (tmp→rename) → release
- **Read**: No lock needed (JSON is immutable after read)
- **Mark as read**: Lock → update flags → atomic write → release
- **Broadcast**: `Promise.allSettled` for resilience (one failure doesn't block others)
- **Corrupt recovery**: Invalid JSON treated as empty array, logged

### Tasks (`src/tasks.js`)

- **One file per task**: Reduces lock contention
- **Crash-safe IDs**: Dual source (HWM file + directory scan) prevents ID reuse
- **Atomic writes**: tmp→rename pattern prevents partial write corruption
- **Schema validation**: Required fields checked on every read
- **Directory-level lock**: Single `.lock` file for create/update/delete

## Design Decisions

| Decision | Rationale |
|---|---|
| File-based storage (no DB) | Works within Claude Code's security model. No extra servers. |
| Any-to-any messaging | All agents share filesystem; no artificial restrictions on who can message whom. |
| CC pattern (not enforced) | Direct communication is fast; CC to team-lead is a convention, not a constraint. |
| Per-file tasks | Reduces lock contention when multiple agents update different tasks. |
| Dual HWM source | Crash-safe: even if HWM file wasn't updated, directory scan finds true max. |
| Atomic writes (tmp→rename) | Prevents corruption on process crash mid-write. |
| Separate .lock files | Lock file doesn't interfere with data file reads/writes. |
| safeTool wrapper | Centralized error handling; MCP server never crashes on I/O errors. |
| Promise.allSettled for broadcast | One failed delivery doesn't block the rest. |
