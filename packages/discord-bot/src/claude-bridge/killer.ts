import { spawn } from "child_process";
import type { ClaudeRegistry, ClaudeEntry } from "./registry.js";
import { canKill, type KillContext, type KillKind } from "./cse-sessions/kill-policy.js";

export interface KillResult {
  killed: Array<{ name: string; pid: number; kind?: KillKind }>;
  failed: Array<{ name: string; pid: number; error: string; kind?: KillKind }>;
}

export interface KillByPidResult {
  pid: number;
  kind: KillKind;
  succeeded: boolean;
  error?: string;
}

export async function killAllClaudes(
  registry: ClaudeRegistry
): Promise<KillResult> {
  const entries = registry.list();
  const killed: KillResult["killed"] = [];
  const failed: KillResult["failed"] = [];

  for (const entry of entries) {
    try {
      await killPid(entry.pid);
      killed.push({ name: entry.name, pid: entry.pid });
    } catch (err) {
      failed.push({
        name: entry.name,
        pid: entry.pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  registry.clear();
  return { killed, failed };
}

/**
 * Kill all registry-tracked Claudes, then all detected cse_sessions.
 * registry.clear() is called regardless of cse outcome.
 */
export async function killAllRegistryAndCse(
  registry: ClaudeRegistry,
  cseSessionPids: number[]
): Promise<KillResult> {
  const result = await killAllClaudes(registry);
  for (const pid of cseSessionPids) {
    try {
      await killPid(pid);
      result.killed.push({ name: `cse:${pid}`, pid, kind: "cse" });
    } catch (err) {
      result.failed.push({
        name: `cse:${pid}`,
        pid,
        kind: "cse",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Kill a single PID after verifying it is allowed by kill-policy.
 * Removes the PID from registry on success if it was a registry-tracked entry.
 * Returns either a KillByPidResult (policy allowed, kill attempted) or
 * { error } (policy denied — kill not attempted).
 */
export async function killByPid(
  pid: number,
  ctx: KillContext,
  registry: ClaudeRegistry
): Promise<KillByPidResult | { error: string }> {
  const decision = canKill(pid, ctx);
  if (!decision.allowed) return { error: decision.reason };
  try {
    await killPid(pid);
    if (decision.kind === "registry") {
      registry.remove(pid);
    }
    return { pid, kind: decision.kind, succeeded: true };
  } catch (err) {
    return {
      pid,
      kind: decision.kind,
      succeeded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function killPid(pid: number): Promise<void> {
  if (process.platform === "win32") {
    return killWindows(pid);
  }
  return killUnix(pid);
}

function killWindows(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "pipe",
      windowsHide: true,
    });
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      // 0 = killed; 128 = process not found (already dead). Both OK.
      // 255 with child-only race: /T tried to kill a descendant that already exited
      // between enumeration and the kill call. The target PID itself is dead.
      if (code === 0 || code === 128) {
        resolve();
      } else if (code === 255 && isChildRaceFailure(stderr)) {
        resolve();
      } else {
        reject(new Error(`taskkill exited ${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

export function isChildRaceFailure(stderr: string): boolean {
  if (!stderr) return false;
  const hasChildIndicator =
    stderr.includes("子プロセス") || /child process/i.test(stderr);
  const hasNotFoundIndicator =
    stderr.includes("インスタンスがありません") ||
    /no running instance/i.test(stderr);
  return hasChildIndicator && hasNotFoundIndicator;
}

function killUnix(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      process.kill(pid, "SIGTERM");
      resolve();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        resolve();
      } else {
        reject(err);
      }
    }
  });
}

export function formatKillReport(result: KillResult): string {
  const parts: string[] = [];
  if (result.killed.length > 0) {
    parts.push(
      `Killed ${result.killed.length}: ${result.killed
        .map((e) => `${e.name}(PID ${e.pid})`)
        .join(", ")}`
    );
  }
  if (result.failed.length > 0) {
    parts.push(
      `Failed ${result.failed.length}: ${result.failed
        .map((e) => `${e.name}(PID ${e.pid}: ${e.error})`)
        .join(", ")}`
    );
  }
  if (parts.length === 0) return "No Claudes in registry.";
  return parts.join("\n");
}

export type { ClaudeEntry };
