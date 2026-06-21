# Setup

## Prerequisites

- Node.js >= 22
- pnpm (`corepack enable`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/relvetic-netizen/rhi.git
cd rhi && corepack enable && pnpm install
```

### 2. Register the MCP server

Add the `relvetia-team` MCP server so Claude Code can use it:

```bash
claude mcp add relvetia-team -- node /absolute/path/to/rhi/packages/team/src/index.mjs
```

Or add it manually to your Claude Code `settings.json`:

```json
{
  "mcpServers": {
    "relvetia-team": {
      "command": "node",
      "args": ["/absolute/path/to/rhi/packages/team/src/index.mjs"]
    }
  }
}
```

Replace `/absolute/path/to/rhi` with the actual path on your machine.

### 3. Run the setup wizard

In a Claude Code session, type:

```
/setup
```

The wizard asks 3 questions and configures everything: memory directories, distillation mode, config file, and session hooks.

## Profiles

### Standard (default)

- **Three-tier memory**: daily logs -> topic files -> `MEMORY.md` index
- **Automatic distillation** via SessionStart hook (every 8 hours, runs in background)
- **Memory search** (MemorySearchTool)
- **Novelty screening** (deduplication before writing)
- **Local team MCP**

### Full

Everything in Standard, plus:

- **PM2 resident daemon** (scheduled distillation, cron tasks)
- **Cross-machine communication** (wake-loop, peer heartbeat)
- **Inbox push notifications** (channels mode)

## Configuration

After setup, your config lives at `~/.claude/rhi/config.json`:

```json
{
  "version": 1,
  "profile": "standard",
  "distillation": {
    "mode": "session-hook",
    "cooldownHours": 8,
    "model": "claude-sonnet-4-6",
    "maxTurns": 40,
    "distillMode": "standard"
  },
  "memory": {
    "dir": "/home/you/.claude/memory"
  },
  "search": {
    "enabled": true
  },
  "crossMachine": {
    "enabled": false,
    "peers": []
  }
}
```

| Field | Description |
| --- | --- |
| `profile` | `"standard"` or `"full"` |
| `distillation.mode` | `"session-hook"` (Standard) or `"daemon"` (Full) |
| `distillation.cooldownHours` | Minimum hours between distillation runs |
| `memory.dir` | Absolute path to your memory directory |
| `crossMachine.enabled` | Whether peer communication is active |
| `crossMachine.peers` | List of peer endpoints (Full profile) |

## Standard -> Full upgrade

1. Re-run `/setup` and answer "つけっぱなし" + "連携する"
2. Install PM2 globally: `npm install -g pm2`
3. Set up the daemon: see [`packages/daemon/README.md`](../packages/daemon/README.md)

## Per-package configuration

Configuration that contains secrets or machine-specific IDs is **never** committed. Each package ships `*.example` files; copy them and fill in your own values.

| Package | Copy from | To |
| --- | --- | --- |
| `discord-bot` | `packages/discord-bot/.env.example` | `packages/discord-bot/.env` |
| `discord-bot` | `packages/discord-bot/config/*.example.json` | `config/*.json` (same name, no `.example`) |
| `team` | `packages/team/persona.config.example.json` | `packages/team/persona.config.json` |

See each package's own `README.md` for the meaning of every field.

## Memory data

The memory *engine* is open source, but real memory *content* never ships.
When the `daemon` / `extracted` packages are imported, point them at a local
memory directory of your own; the repo only contains example/schema files.
The root `.gitignore` enforces this.
