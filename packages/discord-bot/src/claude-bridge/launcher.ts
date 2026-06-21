import { execFileSync, spawn } from "child_process";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { randomUUID, randomBytes } from "crypto";
import { config } from "../config.js";
import { resolveClaudeInvocation } from "../claude/resolve-cli.js";
import type { ClaudeRegistry, ClaudeEntry } from "./registry.js";

export interface LaunchOptions {
  name?: string;
  cwd?: string;
}

export interface LaunchResult {
  name: string;
  pid: number;
  cwd: string;
}

const PTY_WRAPPER_PATH = path.join(
  os.homedir(),
  ".claude",
  "scripts",
  "relvetia",
  "pty-wrapper.mjs"
);

// orchestrator-inject.mjs owns the orchestrators-registry write contract
// (atomic tmp+rename, schema v2, owner_token compare-and-delete). We import
// registerOrchestrator from it rather than re-implementing the registry write,
// so the active-receive wiring stays a single source of truth with spawn-relay.
const ORCHESTRATOR_INJECT_PATH = path.join(
  os.homedir(),
  ".claude",
  "scripts",
  "relvetia",
  "orchestrator-inject.mjs"
);

const RELVETIA_DIR = path.join(os.homedir(), ".claude", "relvetia");

const STATE_FILE_POLL_INTERVAL_MS = 100;
const STATE_FILE_TIMEOUT_MS = 15_000;

/**
 * Fixed relvetia-team team name shared across every Discord-launched session.
 * Each `/claude` invocation adds a member whose agent name = registry name,
 * so team_send_message + channels-mode delivery can address the session by
 * its registry identity. Reused across bot restarts (additive, no purge).
 */
export const DISCORD_CLAUDE_TEAM = "discord-claude";
const TEAMS_ROOT = path.join(os.homedir(), ".claude", "teams");
const COLORS = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "gray",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
];

/**
 * Ensure the fixed `discord-claude` team exists and contains a member with
 * `agentName`. Idempotent — safe to call on every launch. Writes the config
 * atomically via tmp+rename so a concurrent relvetia-team subprocess never
 * sees a partial write. Returns the inbox file path for the agent.
 */
function ensureDiscordClaudeMember(agentName: string): string {
  const safeName = DISCORD_CLAUDE_TEAM.replace(/[^A-Za-z0-9_-]/g, "_");
  const teamDir = path.join(TEAMS_ROOT, safeName);
  const inboxDir = path.join(teamDir, "inboxes");
  const configPath = path.join(teamDir, "config.json");
  mkdirSync(inboxDir, { recursive: true });

  let teamConfig: {
    name: string;
    description: string;
    createdAt: number;
    leadAgentId: string;
    members: Array<{
      agentId: string;
      name: string;
      role: string;
      prompt?: string;
      model: string;
      effort?: string;
      color: string;
      joinedAt: number;
      cwd: string;
      isActive: boolean;
    }>;
  };

  if (existsSync(configPath)) {
    teamConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  } else {
    teamConfig = {
      name: DISCORD_CLAUDE_TEAM,
      description:
        "Fixed team for Discord-launched /claude sessions. Each member = one launcher-registered session, reused across bot restarts.",
      createdAt: Date.now(),
      leadAgentId: `team-lead@${safeName}`,
      members: [
        {
          agentId: `team-lead@${safeName}`,
          name: "team-lead",
          role: "coordinator",
          model: "claude-opus-4-8[1m]",
          color: "white",
          joinedAt: Date.now(),
          cwd: process.cwd(),
          isActive: true,
        },
      ],
    };
  }

  const exists = teamConfig.members.some((m) => m.name === agentName);
  if (!exists) {
    const memberIndex = teamConfig.members.length;
    teamConfig.members.push({
      agentId: `${agentName}@${safeName}`,
      name: agentName,
      role: "discord-launched session",
      prompt: "",
      model: "",
      effort: "",
      color: COLORS[memberIndex % COLORS.length]!,
      joinedAt: Date.now(),
      cwd: process.cwd(),
      isActive: true,
    });
    const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(teamConfig, null, 2));
    renameSync(tmp, configPath);
  }

  const inboxPath = path.join(inboxDir, `${agentName}.json`);
  if (!existsSync(inboxPath)) {
    writeFileSync(inboxPath, "");
  }
  return inboxPath;
}

export async function launchClaude(
  registry: ClaudeRegistry,
  opts: LaunchOptions = {}
): Promise<LaunchResult> {
  const existing = registry.list();
  const name = opts.name || `claude-${existing.length + 1}`;
  if (existing.some((e) => e.name === name)) {
    throw new Error(`Claude "${name}" already in registry`);
  }

  const cwd = opts.cwd || os.homedir();

  const { bin: rawBin, prefixArgs } = resolveClaudeInvocation({
    cliPath: config.claudeCliPath,
    cliScript: config.claudeCliScript,
  });

  const claudeArgs = [
    ...prefixArgs,
    "--dangerously-skip-permissions",
    "--dangerously-load-development-channels",
    "server:relvetia-team",
  ];

  // Register this session in the fixed relvetia-team team so channels-mode
  // notifications addressed to RELVETIA_AGENT=<name> reach this Claude.
  // Without team/agent identity, relvetia-team's channels.js initChannels is
  // a no-op (channels.js:84-88 — both env vars required).
  ensureDiscordClaudeMember(name);
  const channelsEnv = {
    RELVETIA_TEAM: DISCORD_CLAUDE_TEAM,
    RELVETIA_AGENT: name,
  };

  if (process.platform === "win32") {
    const claudeExe = resolveWin32ClaudeExe(rawBin);
    const stateFile = path.join(
      os.tmpdir(),
      `rhi-claude-pty-state-${randomUUID()}.json`
    );
    const logFile = path.join(
      os.homedir(),
      ".claude",
      "logs",
      "rhi-claude-pty",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.log`
    );

    // Active-receive wiring: register this session in the orchestrators
    // registry and tell the PTY wrapper to poll an inject queue. inbox-watcher
    // / peer-dispatcher then drive a human-zero turn by dropping a prompt into
    // the queue (orchestrator-inject.mjs:injectToOrchestrator); the wrapper
    // types it into the ConPTY. Mirrors spawn-relay's orchestrator mode: paths
    // follow defaultInjectDirPath / defaultInjectFilePath, owner_token rides
    // RELVETIA_PTY_WRAPPER_OWNER_TOKEN (never the command line), and the wrapper
    // calls unregisterOrchestrator on exit (compare-and-delete by owner_token).
    const orchSessionId = `discord-${name}`.replace(/[^A-Za-z0-9._-]/g, "_");
    const ownerToken = randomBytes(16).toString("hex");
    const runId = randomUUID();
    const injectDir = path.join(
      RELVETIA_DIR,
      "orch-inject-queue",
      orchSessionId
    );
    const injectFile = path.join(
      RELVETIA_DIR,
      "orch-inject",
      `${orchSessionId}.txt`
    );

    const wrapperArgs = [
      PTY_WRAPPER_PATH,
      "--claude-bin",
      claudeExe,
      "--args-json",
      JSON.stringify(claudeArgs),
      "--cwd",
      cwd,
      "--state-file",
      stateFile,
      "--log-file",
      logFile,
      "--orch-session-id",
      orchSessionId,
      "--inject-dir",
      injectDir,
      "--inject-file",
      injectFile,
    ];

    const wrapperPid = spawnDetachedWindows(
      process.execPath,
      wrapperArgs,
      cwd,
      { ...channelsEnv, RELVETIA_PTY_WRAPPER_OWNER_TOKEN: ownerToken }
    );
    let claudePid: number;
    try {
      claudePid = await pollChildPid(stateFile, STATE_FILE_TIMEOUT_MS);
    } catch (err) {
      try {
        execFileSync("taskkill", ["/PID", String(wrapperPid), "/T", "/F"], {
          windowsHide: true,
        });
      } catch {}
      const hint = ` (wrapper log: ${logFile})`;
      throw new Error((err as Error).message + hint);
    } finally {
      try {
        unlinkSync(stateFile);
      } catch {}
    }

    // Register only after the claude PID is confirmed, so a failed boot (which
    // taskkills the wrapper above) never leaves a stale registry entry. The
    // wrapper removes the entry on exit via owner_token compare-and-delete.
    // owner_pid = wrapper PID (the process that owns the inject poll loop and
    // lives for claude's whole lifetime), matching spawn-relay's convention.
    try {
      const orchMod: any = await import(
        pathToFileURL(ORCHESTRATOR_INJECT_PATH).href
      );
      await orchMod.registerOrchestrator({
        orchSessionId,
        injectFile,
        injectDir,
        cwd,
        label: `discord:${name}`,
        ownerPid: wrapperPid,
        ownerToken,
        runId,
      });
    } catch (err) {
      console.error(
        `[launcher] orchestrator register failed for "${name}" — ` +
          `active-receive disabled for this session: ${(err as Error).message}`
      );
    }

    const entry: ClaudeEntry = {
      name,
      pid: claudePid,
      cwd,
      startedAt: new Date().toISOString(),
    };
    registry.add(entry);
    return { name, pid: claudePid, cwd };
  }

  const pid = spawnDetachedUnix(rawBin, claudeArgs, cwd, channelsEnv);
  const entry: ClaudeEntry = {
    name,
    pid,
    cwd,
    startedAt: new Date().toISOString(),
  };
  registry.add(entry);
  return { name, pid, cwd };
}

/**
 * pty-wrapper.mjs writes wrapper_pid + child_pid to the state file after
 * spawning claude.exe in ConPTY. We poll for child_pid because that is the
 * user-visible session PID (registered in claudeRegistry, displayed in
 * /claude-list, killed via /claude-kill). The wrapper itself self-exits when
 * claude.exe exits (term.onExit handler in pty-wrapper.mjs), so killing the
 * claude PID with `taskkill /T` cascades cleanly.
 */
async function pollChildPid(
  stateFile: string,
  timeoutMs: number
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      try {
        const raw = readFileSync(stateFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.child_pid === "number" && parsed.child_pid > 0) {
          return parsed.child_pid;
        }
      } catch {
        // partial write — retry
      }
    }
    await new Promise((r) => setTimeout(r, STATE_FILE_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timeout (${timeoutMs}ms) waiting for claude.exe PID in PTY wrapper state file: ${stateFile}`
  );
}

/**
 * pty-wrapper.mjs requires a real `.exe` path (ConPTY cannot spawn .cmd shims).
 * Mirrors spawn-relay.mjs:resolveWin32ClaudeExe — same fallback chain.
 */
function resolveWin32ClaudeExe(rawBin: string): string {
  const envOverride = process.env.RHI_CLAUDE_EXE;
  if (envOverride && existsSync(envOverride)) return envOverride;
  if (/\.exe$/i.test(rawBin) && existsSync(rawBin)) return rawBin;
  if (rawBin && rawBin.length > 0) {
    const sibling = path.join(
      path.dirname(rawBin),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe"
    );
    if (existsSync(sibling)) return sibling;
  }
  try {
    const out = execFileSync("where.exe", ["claude.exe"], {
      encoding: "utf-8",
      windowsHide: true,
    });
    const line = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (line && existsSync(line)) return line;
  } catch {}
  throw new Error(
    `Cannot resolve claude.exe path for PTY wrapper (rawBin=${rawBin}). ` +
      `Set RHI_CLAUDE_EXE env to override.`
  );
}

/**
 * Windows: use PowerShell Start-Process so the child gets its own hidden
 * console. Without this, stdio:'ignore' makes stdin = NUL which the TUI
 * reads as EOF and exits. Start-Process also detaches the child from the
 * bot's process tree so it survives bot restarts.
 *
 * Argument passing: build a single Win32 command line using MSVCRT-style
 * quoting (winQuoteArg) and pass it as ONE PS-quoted string to -ArgumentList.
 * The PowerShell array form `-ArgumentList 'a','b','c'` joins with spaces
 * but does NOT escape embedded `"` in values, which corrupts JSON payloads
 * passed to the child. Mirrors spawn-relay.mjs:buildWinCommandLine.
 */
function spawnDetachedWindows(
  file: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): number {
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const psFilePath = psQuote(file);
  const psCwd = psQuote(cwd);
  const argListClause =
    args.length > 0
      ? `-ArgumentList ${psQuote(buildWinCommandLine(args))} `
      : "";
  const script =
    `$p = Start-Process -FilePath ${psFilePath} ${argListClause}` +
    `-WorkingDirectory ${psCwd} -WindowStyle Hidden -PassThru; ` +
    `Write-Output $p.Id`;

  // Start-Process inherits the parent (powershell.exe) env into the child.
  // Set RELVETIA_TEAM/AGENT (and any other passthrough) on the powershell.exe
  // env so wrapper → ConPTY → claude.exe → relvetia-team MCP subprocess all
  // observe them. Values stay off the command line (no WMI / Get-CimInstance
  // leak surface). Mirrors spawn-relay.mjs:spawnDetachedWindows.
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf-8",
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    }
  );
  const pid = parseInt(out.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`Failed to parse PID from Start-Process output: ${out}`);
  }
  return pid;
}

/**
 * MSVCRT/CreateProcess command-line quoting: escape backslashes before `"`
 * and surround in `"` when the value contains spaces, tabs, `"`, or `\`.
 * Mirrors spawn-relay.mjs:winQuoteArg.
 */
function winQuoteArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[ \t"\\]/.test(value)) return value;
  let escaped = "";
  let backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      escaped += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      escaped += "\\".repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  escaped += "\\".repeat(backslashes * 2);
  return `"${escaped}"`;
}

function buildWinCommandLine(args: string[]): string {
  return args.map(winQuoteArg).join(" ");
}

function spawnDetachedUnix(
  file: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): number {
  const proc = spawn(file, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  if (typeof proc.pid !== "number") {
    throw new Error("Failed to spawn: no PID");
  }
  proc.unref();
  return proc.pid;
}
