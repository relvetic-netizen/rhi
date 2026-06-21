# @rhi/wake-loop

Peer-wake supervisor: a small set of scripts that keep a long-running agent
session alive and let one machine wake another. Designed for a **two-PC
topology** (an orchestrator PC and a worker PC), with a single-PC fallback.

## Scripts

| File | Role |
| --- | --- |
| `scripts/peer-standby-supervisor.mjs` | Supervisor loop. Keeps the orchestrator session alive via spawn-relay; detects a dead session (Windows WMI process check) and restarts it. |
| `scripts/peer-inbox-bridge.mjs` | SSH bridge. Polls the local inbox and relays messages to a worker on another host via the configured `sshTarget`. Idle until `sshTarget` is set. |
| `scripts/endpoint-registrar.mjs` | Registrar template. Writes/refreshes a shared endpoint record so peers can discover each other. Fully config-driven. |
| `scripts/endpoint-heartbeat-remote.mjs` | Remote helper invoked by the registrar to stamp the shared endpoint file with the remote host's clock. |
| `scripts/heartbeat.sh` / `scripts/heartbeat.bat` | Active-hours heartbeat. The `.bat` is a Windows Task Scheduler wrapper that invokes the `.sh` via Git Bash. |

All scripts resolve configuration in the order: **environment variable →
`peer-stack.config.json` → built-in default**. No endpoints, hosts, or
credentials are baked in.

## Configuration

Copy the example and fill in your own values:

```bash
cp peer-stack.config.json.example peer-stack.config.json
```

```jsonc
{
  "orchSessionId": "peer-standby",      // session id the supervisor keeps alive
  "team": "sisters",                    // team namespace (example persona)
  "agent": "peer",                      // worker persona name (example)
  "bridge": {
    "sshTarget": "<user>@<worker-host>",  // REQUIRED for the SSH bridge; idle without it
    "bashPath": "C:\\Program Files\\Git\\bin\\bash.exe"
  }
}
```

`peer-stack.config.json` is git-ignored — it holds host-specific values and must
not be committed. Override any field with the matching env var (e.g.
`PEER_SSH_TARGET`, `PEER_REMOTE_BASH`).

> The persona names `peer` / `private` are kept as **examples** — rename them to
> your own roles freely.

## Topologies

**Two-PC (intended).** The orchestrator PC runs the standby-supervisor and the
inbox bridge; the worker PC runs the agent woken over SSH. The registrar keeps a
shared endpoint record so each side can find the other.

**Single-PC (fallback).** With one machine there is no peer to wake. Run the
heartbeat on a schedule instead:

- **Windows:** register `scripts/heartbeat.bat` as a Task Scheduler job (e.g.
  every 30 min during active hours).
- **Linux/macOS:** add `scripts/heartbeat.sh` to `cron` (e.g.
  `*/30 9-23 * * *`), or run the supervisor under `pm2` with `autorestart`.

In single-PC mode the SSH bridge and registrar are unused — leave `sshTarget`
empty and the bridge stays idle.

## Not shipped

The author's live deployment registrar (with hard-coded host/IP and personal
paths) is intentionally excluded. Only the generic, config-driven templates
above are published.
