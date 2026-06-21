# @rhi/setup

Interactive setup slash command for the RHI persistent memory system.

## Contents

- `SKILL.md` -- Slash command definition (drives the `/setup` interaction)
- `setup-runner.mjs` -- Node script that creates directories, files, and hooks
- `distill-trigger.mjs` -- Hook entry point for session-based distillation
- `package.json` -- Package metadata

## Usage

Run `/setup` in a Claude Code session. The command detects your environment,
asks three questions, and configures memory + distillation accordingly.

## Profiles

- **Standard** -- Session-hook distillation. Suitable for most setups.
- **Full** -- Daemon-based distillation with multi-PC coordination. Requires
  an always-on machine and separate PM2/daemon setup.

## Documentation

See [docs/setup.md](../../docs/setup.md) for detailed documentation.
