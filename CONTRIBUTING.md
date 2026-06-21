# Contributing to RHI

Thanks for your interest in contributing. RHI is an open monorepo for a
persistent-memory agent system. This guide covers how to get set up, the
quality bar a change has to clear, and the one rule that is non-negotiable.

## The golden rule: machinery is open, memories are closed

The memory **engine** (distillation, screening, recall, the three-tier logic)
is the open-source product. Real memory **content** and personal identity are
**never** committed:

- No real `MEMORY.md`, `topics/`, `logs/`, `diary/`, `concepts/` data.
- No personal identities, persona names, real machine/host names, private
  filesystem paths, internal ticket IDs, or dated personal work notes.
- Only `*.example` / `schema` files and synthetic fixtures ship.

`.gitignore` enforces the data side; **you** are responsible for the identity
side. Before opening a PR, grep your diff for anything personal — your own
username or real name, machine/host names, home-directory or other absolute
paths, and internal ticket IDs — and make sure none of it leaks in. See
[`MONOREPO-neutralize-scope.md`](./MONOREPO-neutralize-scope.md).

## Prerequisites

- Node.js >= 22
- pnpm via `corepack enable`

## Getting set up

```bash
git clone https://github.com/relvetic-netizen/rhi.git
cd rhi
corepack enable
pnpm install
```

## Workflow

1. Branch from `main`.
2. Make your change in the relevant `packages/<name>` workspace.
3. Keep the change scoped to one package where possible — the CI matrix is
   path-filtered and only rebuilds what you touch (a change to `shared` fans
   out to every downstream package).
4. Run the checks below locally.
5. Open a pull request describing the change and how you verified it.

## Local checks (must pass before a PR)

```bash
pnpm install --frozen-lockfile
pnpm -r run build           # all packages compile
pnpm -r run test            # all package test suites pass
pnpm typecheck              # type-only check where configured
pnpm format:check           # prettier formatting
```

A clean `pnpm -r run test` on a checkout with **no secrets in the environment**
is a hard requirement: tests must be hermetic and must not require real tokens
or personal data.

## Code style

- TypeScript, ES modules, `node >= 22`.
- Formatting is enforced by Prettier (`pnpm format` to fix).
- Match the surrounding code's conventions, naming, and comment density.
- Comments should state constraints the code can't, not narrate the diff or
  reference internal sprints/tickets.

## Commit messages

Use clear, conventional-ish prefixes (`feat:`, `fix:`, `docs:`, `chore:`,
`test:`, `refactor:`) and describe the _why_, not just the _what_.

## Reporting bugs / requesting features

Open an issue with a minimal reproduction and your environment (OS, Node
version, package). For security issues, **do not** open a public issue — see
[`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
