# Neutralization scope

This repo follows one boundary: **the machinery is open, the memories and the
identity are closed.** This document records what that means concretely, what
has been neutralized, and the checklist a contributor must clear so personal
data never re-enters the repo.

## What "neutralized" means

The codebase originated from a private, single-operator deployment. Before and
while open-sourcing, the following classes of personal data are stripped and
must stay out:

| Class                | Examples                                                                           | Policy                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Memory content       | `MEMORY.md`, `topics/`, `logs/`, `diary/`, `concepts/`, `index.json`, `stats.json` | Blocked by `.gitignore`. Only `*.example` / `schema` ship.                                                                               |
| Persona identity     | Built-in persona names, per-persona dirs/prompts                                   | Persona machinery is config-driven. No real persona identity is committed; only neutral example configs (`persona.config.example.json`). |
| Host / machine names | Real `COMPUTERNAME` / hostnames                                                    | Removed. Host gating is configured via env, never hardcoded.                                                                             |
| Private paths        | Operator-specific absolute paths beyond `~/.claude/...` conventions                | Derived from `$HOME` / env at runtime.                                                                                                   |
| Internal work notes  | Sprint labels, handoff doc references, ticket IDs, dated incident memos            | Removed from shipped code and comments.                                                                                                  |

## Current state

- **Memory engine** (`daemon`, `extracted`) — full implementations. Memory
  _data_ never ships; the packages operate on a memory directory you point them
  at. Privacy gating for a restricted memory zone is controlled by the
  `RELVETIA_INCLUDE_PRIVATE` opt-in env (generic, no persona name).
- **Persona system** (`discord-bot`) — config-driven. The bot loads persona
  definitions from `persona.config.json` (gitignored) or the path in
  `RHI_PERSONA_CONFIG`; the repo ships only `persona.config.example.json` with
  neutral, fictional example personas. There is no built-in default identity.
- **Peer-wake** (`wake-loop`) — generic standby/inbox/heartbeat scripts; peer
  identities come from `stack.config.json` (example shipped).
- **Team MCP** (`team`) — the persona-scoped memory-search MCP is generic; the
  memory zone name and host gate are configured, not hardcoded.

## Dependency direction (intended)

```
shared  ←  discord-bot
shared  ←  wake-loop
shared  ←  daemon  ←  (uses)  extracted
```

`team` and `browser` are currently standalone within the workspace.

## Contributor checklist

Before opening a PR, confirm none of the following appear in your diff:

- [ ] Real persona/identity names (any non-example persona, operator, or
      contributor identity — grep your diff for your own handle / real name).
- [ ] Real host/machine names (e.g. `DESKTOP-*`, internal box names).
- [ ] Absolute paths tied to a specific operator's machine.
- [ ] Internal sprint/handoff/ticket references or dated personal work notes.
- [ ] Any file under a gitignored memory tree (`memory/topics`, `logs`, etc.).

If you need example data, add synthetic fixtures or `*.example` files only.
