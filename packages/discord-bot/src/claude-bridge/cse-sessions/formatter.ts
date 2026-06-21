import type { ClassifiedSessions } from "./inspector.js";
import type { KillKind } from "./kill-policy.js";

export function formatAge(startedAt: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - startedAt.getTime();
  if (diffMs < 60_000) return "<1m";
  const totalMin = Math.floor(diffMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function shortCseId(id: string, len = 12): string {
  if (id.length <= len) return id;
  return id.slice(0, len);
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

export function formatList(c: ClassifiedSessions, now: Date = new Date()): string {
  const total = c.registry.length + c.cse.length;
  if (total === 0) return "現存する Claude プロセス無し。";

  const lines: string[] = [];
  lines.push(`🔧 Active Claude processes (${total})`);
  lines.push("");

  for (const r of c.registry) {
    lines.push(
      `[registry] PID ${pad(r.proc.pid, 6)} | ${pad(r.entry.name, 12)} | cwd=${truncate(r.entry.cwd, 40)} | ${formatAge(r.proc.startedAt, now)}`
    );
  }
  for (const x of c.cse) {
    const parent = c.hubPid === x.proc.parentPid ? `parent=${x.proc.parentPid} (hub)` : `parent=${x.proc.parentPid}`;
    lines.push(
      `[cse]      PID ${pad(x.proc.pid, 6)} | ${pad(shortCseId(x.sessionId), 12)} | ${pad(parent, 25)} | ${formatAge(x.proc.startedAt, now)} | ${formatBytes(x.proc.workingSetBytes)}`
    );
  }
  return lines.join("\n");
}

export function formatKillByPid(result: {
  pid: number;
  kind: KillKind;
  succeeded: boolean;
  error?: string;
} | { error: string }): string {
  if ("succeeded" in result) {
    if (result.succeeded) {
      return `Killed PID ${result.pid} (kind=${result.kind})`;
    }
    return `Failed to kill PID ${result.pid}: ${result.error ?? "unknown"}`;
  }
  return `Failed: ${result.error}`;
}

function pad(s: string | number, width: number): string {
  const str = String(s);
  if (str.length >= width) return str;
  return str + " ".repeat(width - str.length);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
