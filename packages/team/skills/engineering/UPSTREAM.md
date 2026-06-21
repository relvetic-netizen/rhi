# Vendored Engineering Skills — Upstream Sync

This directory vendors the production-engineering skill catalog from
[`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills) (MIT
licensed). Files are copied verbatim so swarm agents can `Read` them locally
without any runtime network dependency.

## Current snapshot

- **Upstream**: https://github.com/addyosmani/agent-skills
- **Commit SHA**: `1f66d57a5e1b041b11e49a8cdca275aa472f0131`
- **Vendored at**: 2026-04-22
- **Skill count**: 20

## Why vendored, not fetched

Swarm agents run with `--dangerously-skip-permissions`. A compromise of the
upstream repo (account hijack, accidental merge, force-push, branch rename)
would inject arbitrary instructions into every swarm run with no local audit
trail. Vendoring moves the trust boundary inside this repo — changes go
through normal PR review.

Secondary benefits:
- Offline operation (matches relvetia-team's file-based-everything design)
- Reproducibility (same repo SHA → same prompts across runs)
- No WebFetch / GitHub availability dependency

## Sync procedure

When you want to adopt upstream updates:

1. **Pick a target SHA.** Check the upstream commit history. Prefer a tagged
   release if available; otherwise a specific SHA, never `main`.
   ```bash
   git ls-remote https://github.com/addyosmani/agent-skills.git main
   ```

2. **Clone upstream at that SHA** to a scratch directory and diff against
   our vendored copy:
   ```bash
   git clone https://github.com/addyosmani/agent-skills.git /tmp/agent-skills-upstream
   cd /tmp/agent-skills-upstream && git checkout <target-sha>
   diff -r skills/ /path/to/relvetia-team/skills/engineering/ \
     --exclude=LICENSE --exclude=UPSTREAM.md
   ```

3. **Audit every diff.** Each SKILL.md becomes context for an LLM running
   with skip-permissions; read the changes as if they are code, not docs.
   Look specifically for:
   - New instructions to run shell commands, curl URLs, or access files
   - New URLs / endpoints / external references
   - Changes to "When to Use" that could broaden invocation unexpectedly
   - Any prompt-injection-shaped patterns (`<system>`, instructions to
     "ignore prior", etc.)

4. **Copy approved files.** Only copy skills whose diff you reviewed.
   Partial syncs are fine.

5. **Update this file** with the new SHA and date.

6. **Run tests** (`npm test`) and update `skills/engineering-skills.md` if
   the catalog changed (added/removed skills).

7. **Commit with the SHA in the message** so bisect and audit are easy.

## License

MIT (upstream). See `LICENSE` in this directory. When you sync, also refresh
the LICENSE file if upstream has updated it.
