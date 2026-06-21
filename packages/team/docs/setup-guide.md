# Setup Guide

## Prerequisites

- **Node.js** 18 or later
- **Claude Code CLI** installed and authenticated (`claude` command available)

## 1. Install

```bash
cd /path/to/relvetia-team
npm install
```

Verify the MCP server starts:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node src/index.js
```

You should see a JSON response with `"name": "relvetia-team"`.

## 2. Register MCP Server

**Recommended** — use the CLI command:

```bash
claude mcp add --transport stdio relvetia-team --scope user -- node /absolute/path/to/relvetia-team/src/index.js
```

This registers the server in `~/.claude.json` with user scope, available from any directory.

> **Warning about `.mcp.json`**: `.mcp.json` is only read from Claude Code's **current working directory** (CWD). It does NOT search parent directories. If you place `.mcp.json` in `/home/you/` but start Claude Code in `/home/you/project/`, the server won't be found. **Always use `--scope user` to avoid this issue.**

## 3. Install Skills (Optional)

```bash
mkdir -p ~/.claude/skills
cp skills/engineering-skills.md ~/.claude/skills/
```

## 4. Verify

**Restart Claude Code**, then test:

```
> Can you list teams?

Claude should call team_list and return "No teams found."
```

You can also run `/mcp` to see connected MCP servers, or `claude mcp list` from the terminal.

## 5. First Team

### Create a team (in Claude Code)

```
> Create a team called "demo" with two members: a researcher and an implementer.
  Send the researcher instructions to investigate README.md and send
  findings directly to the implementer.
```

Claude drives the team through the MCP tools (`team_create`, `team_create_task`,
`team_send_message`). All team state lives on the filesystem under
`~/.claude/teams/{team}/`, so members can also run as separate Claude Code
processes operating on the shared team.

## 6. Uninstallation

```bash
# Remove MCP server
claude mcp remove relvetia-team --scope user

# Remove skills and data
rm -f ~/.claude/skills/engineering-skills.md
rm -rf ~/.claude/teams/ ~/.claude/tasks/
```
