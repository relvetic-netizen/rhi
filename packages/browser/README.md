# relvetia-browser

Domain-skill-aware Chrome DevTools Protocol helper for Relvetia. Sits alongside the existing `agent-browser` CLI (Vercel Labs) on port 9222 and adds:

- `goto(url)` that auto-loads public domain skills for the target hostname
- `saveSkill(hostname, name, content)` that lets an agent file its own reusable how-to notes under `~/.claude/skills/domains/<hostname>/`
- CDP mini-helpers (`click`, `type`, `press`, `scroll`, `screenshot`, `js`, tab management) for things the existing CLI does not expose

Inspired by [browser-use/browser-harness](https://github.com/browser-use/browser-harness), but trimmed to fit an existing Windows + TypeScript + CDP stack.

## Install

```bash
cd workspace/relvetia/relvetia-browser
npm install
npm run build
```

Chrome must be running with `--remote-debugging-port=9222`. On Relvetia the launcher is `~/.claude/helpers/relvetia-chrome.sh`.

## CLI

```
relvetia-browser goto <url>
relvetia-browser page-info
relvetia-browser js <expression>
relvetia-browser click <x> <y>
relvetia-browser click-selector <css>
relvetia-browser type <text>
relvetia-browser press <key> [--modifiers Shift,Ctrl]
relvetia-browser scroll <dx> <dy>
relvetia-browser screenshot [--path p] [--full] [--format png|jpeg]
relvetia-browser list-tabs
relvetia-browser switch-tab <id>
relvetia-browser new-tab [url]
relvetia-browser close-tab <id>
relvetia-browser list-skills <hostname>
relvetia-browser save-skill <hostname> <name> <body|-|@file>
                 [--mode versioned|fail-if-exists|overwrite]
                 [--author <name>] [--no-frontmatter]
```

All commands emit a single JSON line on stdout. Errors emit `{error, message}` and exit with code `2` for validation errors / `1` for other failures.

Global flags: `--port <n>` (default 9222), `--skills-root <path>` (default `~/.claude/skills/domains`), `--max-skills <n>` (default 10).

## Domain skills

Skills are plain markdown with a simple frontmatter block:

```markdown
---
hostname: example.com
name: add-to-cart
updated_at: 2026-04-19T12:00:00Z
author: private
---
# Add-to-cart notes
- The golden button's selector is `button[data-testid=cart-add]`.
- Appears ~600ms after the hero image loads.
```

`goto(url)` walks the hostname chain from most-specific to parent (`www.x.com` → `x.com`) and returns the first 10 matching skills. Names collide across levels by most-specific wins.

### What belongs in a skill

Observable, reproducible behavior rules. Button coordinates, keyboard shortcuts, session flush tricks, realtime-layer quirks. If another operator could use it without knowing you, it belongs here.

### What does NOT belong in a skill

Persona, emotion, personal relationships, private judgment. The `saveSkill` API rejects bodies that literal-match common private paths (`~/.claude/memory/private`, `$HOME/.claude/secrets`, Windows equivalents) with a `PrivatePathLiteralError`.

## Library usage

```ts
import { goto, saveSkill } from "relvetia-browser";

const { url, title, domainSkills } = await goto("https://example.com/");
for (const skill of domainSkills) {
  console.log(skill.name, skill.content.length);
}

await saveSkill("example.com", "hero-scroll", "- Scroll(0, 800) reveals the pricing table.");
```

## Integration with relvetia-daemon (example, not wired)

To let a daemon task use `goto()` in-process rather than via CLI fork:

```jsonc
// workspace/relvetia/relvetia-daemon/package.json
{
  "dependencies": {
    "relvetia-browser": "file:../relvetia-browser"
  }
}
```

```ts
// in a daemon task handler
import { goto } from "relvetia-browser";

const snapshot = await goto("https://example.com/");
// apply snapshot.domainSkills to the task's reasoning context
```

The daemon is currently running under pm2 — if you wire this in, plan the install/restart window so the cron schedule is not in flight.

## Safety notes

- `saveSkill` validates hostname against `/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i` and skill name against `/^[a-z0-9][a-z0-9._-]*$/i`. Path-traversal, slashes, null bytes, and control characters are rejected.
- Default save mode is `versioned`: existing files are moved to `<name>.YYYYMMDD-HHMMSS.md` before a new one is written atomically (tmp + rename). No data is ever silently overwritten.
- `saveSkill` refuses bodies containing literal references to Relvetia private directories. This is a last line of defense against accidental persona bleed.
- Runtime audit log goes to `~/.claude/relvetia/logs/browser-YYYYMMDD.jsonl` (set `RELVETIA_BROWSER_NO_LOG=1` to disable). The log lives outside `memory/private/` intentionally.

## Design notes

- Coexists with agent-browser on CDP:9222 via per-command short-lived connections. Each call resolves the active page target fresh, so simultaneous agent-browser invocations do not starve.
- Event subscriptions follow the `chrome-remote-interface` convention: `Page.loadEventFired(cb)` registers a listener. There is no `.once`.
- No Python reload machinery, no daemon socket bridge — the point of this package is to remain a thin, disposable shim.
