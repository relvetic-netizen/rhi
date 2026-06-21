# Troubleshooting

## MCP Server Not Found

**Symptom**: Claude says it doesn't have `team_*` tools. ToolSearch returns nothing.

**Causes & Fixes**:

1. **Not registered** — Verify registration:
   ```bash
   claude mcp list
   # Should show "relvetia-team" in the list
   ```
   If missing, register:
   ```bash
   claude mcp add --transport stdio relvetia-team --scope user -- node /path/to/relvetia-team/src/index.js
   ```

2. **`.mcp.json` in wrong directory** — `.mcp.json` is only read from Claude Code's **current working directory** (CWD). It does NOT search parent directories. If you put `.mcp.json` in `P:/` but start Claude in `P:/myproject/`, it won't be found.
   
   **Fix**: Use `--scope user` instead (registers in `~/.claude.json`, works everywhere).

3. **Wrong path** — Verify the server starts:
   ```bash
   node /your/path/to/relvetia-team/src/index.js
   # Should wait for input (Ctrl+C to exit). If error, path is wrong.
   ```

4. **Claude Code not restarted** — MCP servers load at startup. Exit and reopen after registering.

5. **Check with /mcp** — Run `/mcp` in Claude Code to see connected servers and their status.

---

## Lockfile Errors / Timeouts

**Symptom**: `ELOCKED` errors or tools hanging.

**Cause**: Stale lock files from crashed processes.

**Fix**:
```bash
find ~/.claude/teams -name "*.lock" -delete
find ~/.claude/teams -name "*.lock.*" -delete
find ~/.claude/tasks -name ".lock" -delete
find ~/.claude/tasks -name ".lock.*" -delete
```

---

## Messages Not Delivered

**Symptom**: `team_send_message` succeeds but recipient never sees it.

**Causes & Fixes**:

1. **Name mismatch** — Names are lowercased and sanitized. Check exact names:
   ```bash
   cat ~/.claude/teams/myteam/config.json | node -e "
     const t=JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8'));
     t.members.forEach(m=>console.log(m.name))"
   ```

2. **Recipient idle** — An agent only sees messages when it calls `team_read_inbox`. If an agent isn't doing anything, it won't check its inbox until it starts working.

3. **Wrong team name** — Use `team_status` to verify.

---

## Direct Messages Between Agents Not Working

**Symptom**: Agent A sends to Agent B, but B never receives.

**Check**:
1. Both agents are operating on the same team
2. Agent B's name matches exactly (use `team_status` to verify)
3. Agent B's inbox file exists:
   ```bash
   ls ~/.claude/teams/myteam/inboxes/
   ```
4. The message was actually written:
   ```bash
   cat ~/.claude/teams/myteam/inboxes/agent-b.json
   ```

---

## Tasks Not Visible

**Symptom**: `team_list_tasks` returns empty.

**Causes & Fixes**:

1. **Wrong team name** — Remember: sanitized to lowercase
2. **Tasks directory missing** — Check: `ls ~/.claude/tasks/myteam/`
3. **Team doesn't exist** — Check: `ls ~/.claude/teams/`

---

## Agent Not Receiving Initial Prompt

**Symptom**: Teammate pane starts Claude but has no context about its role.

**Fix**: Keep member prompts simple in `team_create` (no quotes or special characters). Send detailed instructions via `team_send_message` after launch.

---

## Agents Not CC'ing Team-Lead

**Symptom**: Agents communicate directly but team-lead is out of the loop.

**Cause**: The CC convention is a prompt convention, not enforced by code. If agents don't follow it:

1. Remind agents explicitly in your instructions:
   ```
   "When you message other agents directly, always send a brief summary to team-lead too."
   ```
2. Use `team_status` to check unread counts — if team-lead has 0 unread but agents are busy, they may not be CC'ing.

---

## Cleaning Up

### Remove a specific team
```bash
# Via Claude Code (recommended)
> Delete the bugfix-auth team

# Or manually
rm -rf ~/.claude/teams/bugfix-auth
rm -rf ~/.claude/tasks/bugfix-auth
```

### Remove all team data
```bash
rm -rf ~/.claude/teams ~/.claude/tasks
```
