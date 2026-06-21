import fs from "fs";
import path from "path";
import os from "os";

export type AuditAction =
  | "create"
  | "update"
  | "trash"
  | "restore"
  | "move"
  | "update_data_source";

export type AuditResult = "ok" | "error";

export interface AuditEntry {
  ts: string;
  tool: string;
  target_id: string;
  target_type: "page" | "data_source" | "comment" | "other";
  action: AuditAction;
  user_id?: string;
  result: AuditResult;
  error?: string;
}

export interface AppendAuditOptions {
  /** Override the base directory. Defaults to ~/.claude/memory/logs/bot-audit. */
  baseDir?: string;
  /** Override "now" for tests. Defaults to new Date(). */
  now?: Date;
}

const AUDIT_TZ = "Asia/Tokyo";

/**
 * Resolve the JSONL log path for a given date under the audit namespace:
 * <base>/YYYY/MM/YYYY-MM-DD.jsonl
 *
 * Partition は JST (Asia/Tokyo)。relvetia memory log の運用と揃え、
 * 00:00-08:59 JST の audit が前日 UTC ファイルへ落ちる罠を回避する。
 */
export function resolveAuditPath(now: Date, baseDir: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AUDIT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const yyyy = get("year").padStart(4, "0");
  const mm = get("month").padStart(2, "0");
  const dd = get("day").padStart(2, "0");
  return path.join(baseDir, yyyy, mm, `${yyyy}-${mm}-${dd}.jsonl`);
}

export function defaultAuditBaseDir(): string {
  return path.join(os.homedir(), ".claude", "memory", "logs", "bot-audit");
}

export function buildEntry(input: Omit<AuditEntry, "ts"> & { ts?: string }): AuditEntry {
  return {
    ts: input.ts ?? new Date().toISOString(),
    tool: input.tool,
    target_id: input.target_id,
    target_type: input.target_type,
    action: input.action,
    user_id: input.user_id,
    result: input.result,
    error: input.error,
  };
}

/** Serialize an entry as a single JSONL line (no trailing newline). */
export function serializeEntry(entry: AuditEntry): string {
  return JSON.stringify(entry);
}

/** Append an audit entry to today's JSONL log. Append-only; never rewrites. */
export function appendAudit(
  entry: AuditEntry,
  opts: AppendAuditOptions = {}
): { path: string } {
  const baseDir = opts.baseDir ?? defaultAuditBaseDir();
  const filePath = resolveAuditPath(opts.now ?? new Date(), baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${serializeEntry(entry)}\n`, "utf-8");
  return { path: filePath };
}

/** Read all entries from a JSONL file. Used by tests / debug; tolerates blank lines. */
export function readAudit(filePath: string): AuditEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const out: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AuditEntry);
    } catch (err) {
      console.warn(
        "[audit-log] skip malformed line:",
        err instanceof Error ? err.message : err
      );
    }
  }
  return out;
}
