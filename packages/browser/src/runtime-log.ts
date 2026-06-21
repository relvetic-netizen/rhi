import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface RuntimeLogEntry {
  ts: string;
  command: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: { name: string; message: string };
  durationMs: number;
}

function defaultLogDir(): string {
  return path.join(homedir(), ".claude", "relvetia", "logs");
}

function logFileName(now: Date): string {
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  const d = now.getDate().toString().padStart(2, "0");
  return `browser-${y}${m}${d}.jsonl`;
}

export async function logEntry(entry: RuntimeLogEntry, dir?: string): Promise<void> {
  if (process.env.RELVETIA_BROWSER_NO_LOG === "1") return;
  const target = dir ?? defaultLogDir();
  await mkdir(target, { recursive: true });
  const file = path.join(target, logFileName(new Date(entry.ts)));
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function withLogging<T>(
  command: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  dir?: string,
): Promise<T> {
  const start = Date.now();
  const ts = new Date().toISOString();
  try {
    const result = await fn();
    const summary = summarizeResult(result);
    await logEntry(
      { ts, command, args, result: summary, durationMs: Date.now() - start },
      dir,
    ).catch(() => {});
    return result;
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    await logEntry(
      { ts, command, args, error: { name, message }, durationMs: Date.now() - start },
      dir,
    ).catch(() => {});
    throw err;
  }
}

function summarizeResult(result: unknown): unknown {
  if (result == null) return result;
  if (typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.length > 200) {
      out[key] = `${value.slice(0, 200)}…`;
    } else if (Array.isArray(value) && value.length > 5) {
      out[key] = `[array:${value.length}]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
