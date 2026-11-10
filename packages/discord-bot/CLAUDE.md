# CLAUDE.md

## Project

Discord bot powered by Claude Code CLI subprocess. See README.md for full docs.

## Key Paths

- `src/claude/subprocess.ts` — Claude CLI spawning (`claude -p` + `--resume`)
- `src/mcp/` — MCP server with 4 read-only tools (guilds, channels, message history and search)
- `config/channels.json` — Per-channel bot behavior
