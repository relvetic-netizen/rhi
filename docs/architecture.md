# Architecture

## Workspace layout

```
rhi/
├── packages/
│   ├── discord-bot/   # Discord → Claude Code bridge
│   ├── browser/       # CDP browser helper
│   ├── team/          # multi-agent team MCP
│   ├── shared/        # @rhi/shared: wire schemas + types
│   ├── daemon/        # resident memory/wake/inbox daemon
│   ├── extracted/     # daemon-extracted libraries (memory / screening core)
│   ├── wake-loop/     # peer-wake supervisor (multi-machine topology)
│   └── setup/         # /setup command + session-hook distillation trigger
└── docs/
```

## Dependency direction (intended)

```
shared  ←  discord-bot
shared  ←  wake-loop
shared  ←  daemon  ←  (uses)  extracted
```

- `@rhi/shared` holds wire schemas and common types; downstream packages depend
  on it via `workspace:*`. A change to `shared` rebuilds every downstream
  package (enforced by the CI path filter).
- `daemon` consumes `extracted` as a workspace dependency. `extracted` itself
  depends only on `zod` and is independently publishable.
- `team` and `browser` are currently standalone within the workspace.

The de-personalization boundary (what is neutralized before shipping, and the
contributor checklist that keeps personal data out) is documented in
[`MONOREPO-neutralize-scope.md`](../MONOREPO-neutralize-scope.md).
