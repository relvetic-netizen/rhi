# Use Cases

End-to-end recipes for common multi-agent scenarios. Each includes communication topology recommendations.

---

## 1. Bug Investigation and Fix (Mesh)

**Team**: 2 agents (researcher + implementer)
**Topology**: **Mesh** — researcher sends findings directly to implementer

### Setup

```
team_create(team_name: "bugfix-auth", description: "Fix auth timeout", members: [
  { name: "researcher", role: "Root cause analysis" },
  { name: "implementer", role: "Code fix and tests" }
])
```

### Tasks

```
team_create_task(subject: "Investigate auth timeout root cause", owner: "researcher")
team_create_task(subject: "Implement fix", owner: "implementer", blocked_by: ["1"])
team_create_task(subject: "Add regression tests", owner: "implementer", blocked_by: ["2"])
```

### Instructions

```
team_send_message(to: "researcher",
  message: "Investigate the auth timeout in src/services/auth/. When you find the root cause, send findings DIRECTLY to implementer AND CC me.",
  summary: "Investigate auth, send findings to implementer")

team_send_message(to: "implementer",
  message: "Wait for researcher's findings in your inbox (they'll message you directly). Implement fix and tests. Update tasks as you progress.",
  summary: "Wait for researcher's direct message, then fix")
```

### Expected Flow

```
researcher → investigates → finds root cause
researcher → team_send_message(to: "implementer", "Root cause: ...")
researcher → team_send_message(to: "team-lead", "CC: sent findings to implementer")
implementer → receives directly → implements fix
implementer → team_send_message(to: "team-lead", "Fix complete, tests pass")
```

**Why Mesh**: Researcher's output is implementer's input. Direct handoff eliminates relay delay.

---

## 2. Feature Implementation (Hub → Mesh)

**Team**: 3 agents (architect + frontend + backend)
**Topology**: **Hub** for design phase, then **Mesh** for implementation

### Setup

```
team_create(team_name: "feature-search", description: "Add full-text search", members: [
  { name: "architect", role: "API design" },
  { name: "frontend", role: "UI components" },
  { name: "backend", role: "Search service" }
])
```

### Tasks

```
team_create_task(subject: "Design search API contract", owner: "architect")
team_create_task(subject: "Implement search endpoint", owner: "backend", blocked_by: ["1"])
team_create_task(subject: "Implement search UI", owner: "frontend", blocked_by: ["1"])
team_create_task(subject: "Integration testing", owner: "architect", blocked_by: ["2", "3"])
```

### Instructions

```
# Phase 1: Hub — architect reports to team-lead
team_send_message(to: "architect",
  message: "Design the API contract for full-text search. Send the spec to me when done.",
  summary: "Design search API spec")

# After architect reports back, Phase 2: Mesh — broadcast spec + enable direct comms
team_send_message(to: "*",
  message: "API spec attached: [spec details]. Frontend and backend: work in parallel. If you need to coordinate on shared types or interfaces, message each other directly. CC me on decisions.",
  summary: "API spec ready, start parallel work")
```

### Expected Flow

```
Phase 1 (Hub):   architect → team-lead (spec)
Phase 2 (Mesh):  team-lead → broadcast (spec to all)
                  frontend ←→ backend (coordinate interfaces directly)
                  frontend/backend → team-lead (CC on decisions)
                  both → team-lead (completion reports)
Phase 3 (Hub):   team-lead → architect (run integration tests)
```

---

## 3. Code Review Swarm (Mesh)

**Team**: 2 agents (reviewer + author)
**Topology**: **Mesh** — iterative direct dialogue between reviewer and author

### Setup

```
team_create(team_name: "review-pr-42", members: [
  { name: "reviewer", role: "Code review" },
  { name: "author", role: "Address feedback" }
])
```

### Tasks

```
team_create_task(subject: "Initial review", owner: "reviewer")
team_create_task(subject: "Address feedback", owner: "author", blocked_by: ["1"])
team_create_task(subject: "Final review", owner: "reviewer", blocked_by: ["2"])
```

### Instructions

```
team_send_message(to: "reviewer",
  message: "Review changes in current branch vs main. Send feedback DIRECTLY to author. CC me with a summary.",
  summary: "Review branch, send feedback to author")

team_send_message(to: "author",
  message: "Wait for reviewer's feedback (direct message). Address each point and message reviewer back when done. CC me.",
  summary: "Wait for review, address, message reviewer back")
```

### Expected Flow

```
reviewer → author: "3 issues found: [details]"
reviewer → team-lead: "CC: sent 3 issues to author"
author → reviewer: "All 3 addressed, please re-review"
author → team-lead: "CC: addressed feedback, asked for re-review"
reviewer → team-lead: "LGTM, no remaining issues"
```

**Why Mesh**: Review is inherently conversational. Hub would add unnecessary relay delays to each round-trip.

---

## 4. Large-Scale Migration (Pipeline Mesh)

**Team**: 3 agents (analyzer + migrator + validator)
**Topology**: **Pipeline Mesh** — linear handoff: analyzer → migrator → validator

### Setup

```
team_create(team_name: "migrate-api-v2", members: [
  { name: "analyzer", role: "Find all files needing changes" },
  { name: "migrator", role: "Apply transformations" },
  { name: "validator", role: "Run tests and verify" }
])
```

### Tasks

```
team_create_task(subject: "Identify all APIv1 usages", owner: "analyzer")
team_create_task(subject: "Migrate to APIv2", owner: "migrator", blocked_by: ["1"])
team_create_task(subject: "Run test suite", owner: "validator", blocked_by: ["2"])
team_create_task(subject: "Fix test failures", owner: "migrator", blocked_by: ["3"])
```

### Instructions

```
team_send_message(to: "analyzer",
  message: "Find all APIv1 patterns in the codebase. When done, send the file list DIRECTLY to migrator and CC me.",
  summary: "Find APIv1, send list to migrator")

team_send_message(to: "migrator",
  message: "Wait for analyzer's file list (direct message). Apply migrations. When done, send completion notice to validator directly. CC me.",
  summary: "Wait for file list, migrate, notify validator")

team_send_message(to: "validator",
  message: "Wait for migrator's completion notice (direct message). Run full test suite. Report results to team-lead.",
  summary: "Wait for migration, run tests, report")
```

### Expected Flow

```
analyzer → migrator: "File list: [42 files]"  (direct)
analyzer → team-lead: "CC: sent file list"
migrator → validator: "Migration complete"      (direct)
migrator → team-lead: "CC: migration done"
validator → team-lead: "Tests: 3 failures"      (to leader)
team-lead → migrator: "Fix these 3 failures"
```

**Why Pipeline Mesh**: Each stage's output is the next stage's input. Direct handoff maximizes throughput.

---

## 5. Research and Documentation (Hub)

**Team**: 2 agents (researcher + writer)
**Topology**: **Hub** — team-lead synthesizes research before passing to writer

### Setup

```
team_create(team_name: "doc-auth-system", members: [
  { name: "researcher", role: "Codebase analysis" },
  { name: "writer", role: "Documentation authoring" }
])
```

### Tasks

```
team_create_task(subject: "Analyze auth architecture", owner: "researcher")
team_create_task(subject: "Map data flow", owner: "researcher")
team_create_task(subject: "Write architecture doc", owner: "writer", blocked_by: ["1", "2"])
team_create_task(subject: "Write API reference", owner: "writer", blocked_by: ["1"])
```

### Instructions

```
team_send_message(to: "researcher",
  message: "Analyze the auth system: entry points, middleware, token lifecycle, DB interactions. Report all findings to me.",
  summary: "Analyze auth system, report to me")

team_send_message(to: "writer",
  message: "Wait for my instructions. I'll send you synthesized research findings to write into documentation.",
  summary: "Wait for synthesized findings from me")
```

**Why Hub**: Team-lead needs to synthesize multiple research reports into a coherent brief before the writer can produce good documentation.

---

## Choosing Your Topology

| Scenario | Topology | Why |
|---|---|---|
| Output → Input pipeline | **Mesh** | Direct handoff, no relay delay |
| Iterative back-and-forth | **Mesh** | Conversational, many round-trips |
| Synthesis needed | **Hub** | Team-lead combines multiple inputs |
| Announcement / kickoff | **Broadcast** | Everyone needs same info |
| Complex coordination | **Hub** | Team-lead tracks dependencies |
| Simple 2-agent task | **Mesh** | Less overhead |

## Tips for All Use Cases

- **Always create tasks first** — agents can see the full plan
- **Check `team_status` regularly** — shows unread counts per agent
- **In mesh mode, ask agents to CC you** — stay informed without being a bottleneck
- **Use broadcast sparingly** — direct messages are clearer
- **Keep teams small** (2-4 agents) — coordination overhead grows with size
- **Delete teams when done** — cleans up tmux + filesystem state
