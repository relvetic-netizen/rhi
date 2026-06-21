# Security Policy

RHI runs Claude Code as a subprocess, exposes MCP servers, and (optionally) a
networked HTTP transport and cross-machine peer-wake. That makes its security
posture important. Please treat the following seriously.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**, or
2. Email the maintainers at the address listed on the GitHub org profile.

Please include a description, reproduction steps, affected package(s) and
version, and the potential impact. We aim to acknowledge reports within a few
business days.

## Supported versions

This project is pre-1.0 and moves fast. Security fixes land on `main`. Pin a
commit if you need stability.

## Threat model & hardening notes

These are the sharp edges. If you run RHI, understand them:

- **Claude runs with elevated permissions.** The bot and daemon can spawn
  Claude Code with `--dangerously-skip-permissions` / `bypassPermissions`.
  Only run it on machines and directories you control, and scope
  `ALLOWED_WORKING_DIRS` / persona `additionalDirs` as tightly as possible.
- **The HTTP MCP transport is off by default** (`MCP_HTTP_ENABLE=false`) and
  binds to loopback (`127.0.0.1`). It requires a bearer token (`MCP_API_KEY`)
  and enforces DNS-rebinding host allow-listing and a tool denylist. Read the
  Security Runbook in `packages/discord-bot/README.md` before binding to
  `0.0.0.0`.
- **Secrets live only in `.env` / local config**, never in the repo. All
  `*.example` files contain placeholders. Never commit a real token; rotate any
  token that is accidentally committed.
- **Memory content is personal data.** The `.gitignore` blocks real memory
  trees. Do not defeat it.
- **Untrusted input.** Discord messages, webhook payloads, and tool arguments
  are untrusted. Tools that send outward (webhooks) restrict URLs by prefix to
  limit SSRF.

## Dependencies

`pnpm-lock.yaml` is checked against supply-chain policies on install. Keep the
lockfile committed and review dependency changes.
