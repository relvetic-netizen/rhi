# RHI

An open monorepo for a persistent-memory agent system: a Discord-operated Claude
Code bot, a resident memory daemon (distillation / screening / recall), a
multi-agent team MCP, a peer-wake supervisor, and supporting libraries.

> **Philosophy: the machinery is open, the memories are closed.** The memory
> _engine_ (distillation, screening, recall, the three-tier logic) is part of
> this repo. Real memory _content_ (`MEMORY.md`, `topics/`, `logs/`, `diary/`)
> is personal data and is never committed — only `.example` / `schema` files
> ship. See [`.gitignore`](./.gitignore).

## Packages

| Package              | Path                                             | What it is                                                         |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `discord-claude-bot` | [`packages/discord-bot`](./packages/discord-bot) | Discord bot driving local Claude Code via a StructuredIO protocol. |
| `relvetia-browser`   | [`packages/browser`](./packages/browser)         | Domain-skill-aware CDP browser helper.                             |
| `relvetia-team`      | [`packages/team`](./packages/team)               | Multi-agent team MCP server (inbox, handoff, consensus).           |
| `@rhi/shared`        | [`packages/shared`](./packages/shared)           | Shared wire schemas and common types.                              |
| `@rhi/daemon`        | [`packages/daemon`](./packages/daemon)           | Resident agent system: memory distillation / wake / inbox-watcher. |
| `@rhi/extracted`     | [`packages/extracted`](./packages/extracted)     | Daemon-extracted libraries (memory / screening core).              |
| `@rhi/wake-loop`     | [`packages/wake-loop`](./packages/wake-loop)     | Peer-wake standby supervisor / endpoint registrar / heartbeat.     |
| `@rhi/setup`         | [`packages/setup`](./packages/setup)             | Interactive `/setup` command + session-hook distillation trigger.  |

All persona/memory machinery ships generically: personas are configured at
runtime (see each package's `*.example` config), and no personal identity or
memory content is committed. See [`MONOREPO-neutralize-scope.md`](./MONOREPO-neutralize-scope.md)
for the de-personalization boundary.

## Getting started

```bash
git clone https://github.com/relvetic-netizen/rhi.git
cd rhi && corepack enable && pnpm install
```

Then register the MCP server in Claude Code and run `/setup` to configure your memory system interactively. See [`docs/setup.md`](./docs/setup.md) for detailed instructions.

## License

[MIT](./LICENSE) © 2026 RHI
