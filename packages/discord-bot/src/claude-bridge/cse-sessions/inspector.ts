import { execFile } from "child_process";
import { promisify } from "util";
import type { ClaudeEntry } from "../registry.js";

const execFileAsync = promisify(execFile);

export interface ClaudeProcess {
  pid: number;
  parentPid: number;
  startedAt: Date;
  workingSetBytes: number;
  commandLine: string;
}

export interface ClassifiedSessions {
  hubPid: number | null;
  registry: Array<{ proc: ClaudeProcess; entry: ClaudeEntry }>;
  cse: Array<{ proc: ClaudeProcess; sessionId: string }>;
  unclassified: ClaudeProcess[];
}

const CSE_ID_RE = /--session-id\s+(cse_[A-Za-z0-9_]+)/;
const SDK_URL_RE = /--sdk-url\s+\S*cse_[A-Za-z0-9_]+/;
const HUB_RE = /\bremote-control\b/;
const PWSH_DATE_RE = /\/Date\((\d+)\)\//;

export function parseWmicJson(stdout: string): ClaudeProcess[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const items = Array.isArray(raw) ? raw : [raw];
  const out: ClaudeProcess[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const pid = numOrNull(obj.ProcessId);
    const parentPid = numOrNull(obj.ParentProcessId);
    if (pid === null || parentPid === null) continue;
    out.push({
      pid,
      parentPid,
      startedAt: parsePwshDate(obj.CreationDate),
      workingSetBytes: numOrNull(obj.WorkingSetSize) ?? 0,
      commandLine: typeof obj.CommandLine === "string" ? obj.CommandLine : "",
    });
  }
  return out;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function parsePwshDate(v: unknown): Date {
  if (typeof v === "string") {
    const m = v.match(PWSH_DATE_RE);
    if (m) return new Date(parseInt(m[1]!, 10));
  }
  return new Date(0);
}

export function extractCseId(commandLine: string): string | null {
  const m = commandLine.match(CSE_ID_RE);
  return m ? m[1]! : null;
}

export function isCseProcess(commandLine: string): boolean {
  return SDK_URL_RE.test(commandLine) && CSE_ID_RE.test(commandLine);
}

export function isHubProcess(commandLine: string): boolean {
  return HUB_RE.test(commandLine) && !SDK_URL_RE.test(commandLine);
}

export function detectHubPid(procs: ClaudeProcess[]): number | null {
  for (const p of procs) {
    if (isHubProcess(p.commandLine)) return p.pid;
  }
  return null;
}

export function classify(
  procs: ClaudeProcess[],
  registryEntries: ClaudeEntry[]
): ClassifiedSessions {
  const hubPid = detectHubPid(procs);
  const registryByPid = new Map(registryEntries.map((e) => [e.pid, e]));
  const result: ClassifiedSessions = {
    hubPid,
    registry: [],
    cse: [],
    unclassified: [],
  };
  for (const proc of procs) {
    if (proc.pid === hubPid) continue;
    const entry = registryByPid.get(proc.pid);
    if (entry) {
      result.registry.push({ proc, entry });
      continue;
    }
    if (isCseProcess(proc.commandLine) && (hubPid === null || proc.parentPid === hubPid)) {
      const sessionId = extractCseId(proc.commandLine)!;
      result.cse.push({ proc, sessionId });
      continue;
    }
    result.unclassified.push(proc);
  }
  return result;
}

const PWSH_SCRIPT =
  `Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ` +
  `Select-Object ProcessId, ParentProcessId, CreationDate, WorkingSetSize, CommandLine | ` +
  `ConvertTo-Json`;

export async function listClaudeProcesses(): Promise<ClaudeProcess[]> {
  if (process.platform !== "win32") {
    throw new Error("listClaudeProcesses is Windows-only (PowerShell required)");
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PWSH_SCRIPT],
    { encoding: "utf-8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  return parseWmicJson(stdout);
}
