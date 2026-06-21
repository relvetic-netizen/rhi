# CLAUDE.md

## Project

Discord bot powered by Claude Code CLI subprocess. See README.md for full docs.

## Key Paths

- `src/claude/subprocess.ts` — Claude CLI spawning (`claude -p` + `--resume`)
- `src/mcp/` — MCP server with 30 tools (Discord + Gemini)
- `config/channels.json` — Per-channel bot behavior

## Gemini Delegation

MCP tools `gemini_query`, `gemini_review`, `gemini_search` delegate tasks to Gemini 3.1 Pro via CLI.
Uses Google AI Pro plan quota (OAuth auth). `--yolo` mode enables Gemini's built-in tools (file read/write, shell, web search).

Delegate to Gemini when the task involves: code review, abstract reasoning, scientific analysis, web research, large-context analysis.

Details: `docs/gemini-integration.md`
