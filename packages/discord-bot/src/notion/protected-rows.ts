import fs from "fs";
import path from "path";

export interface ProtectedRow {
  id: string;
  reason: string;
  since: string;
}

export interface ProtectedRowsConfig {
  protected_rows: ProtectedRow[];
  protected_pattern: string;
}

const EMPTY_CONFIG: ProtectedRowsConfig = {
  protected_rows: [],
  protected_pattern: "",
};

export function loadProtectedRowsConfig(jsonPath: string): ProtectedRowsConfig {
  try {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProtectedRowsConfig>;
    return {
      protected_rows: Array.isArray(parsed.protected_rows) ? parsed.protected_rows : [],
      protected_pattern:
        typeof parsed.protected_pattern === "string" ? parsed.protected_pattern : "",
    };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_CONFIG };
    }
    console.error(
      "[protected-rows] failed to parse:",
      err instanceof Error ? err.message : err
    );
    return { ...EMPTY_CONFIG };
  }
}

function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function isProtectedId(
  cfg: ProtectedRowsConfig,
  candidateId: string
): boolean {
  const target = normalizeId(candidateId);
  return cfg.protected_rows.some((row) => normalizeId(row.id) === target);
}

export function matchesProtectedPattern(
  cfg: ProtectedRowsConfig,
  memo: string | undefined | null
): boolean {
  if (!cfg.protected_pattern || !memo) return false;
  return memo.includes(cfg.protected_pattern);
}

export function isProtectedRow(
  cfg: ProtectedRowsConfig,
  row: { id?: string; memo?: string | null }
): boolean {
  if (row.id && isProtectedId(cfg, row.id)) return true;
  if (matchesProtectedPattern(cfg, row.memo ?? null)) return true;
  return false;
}

export function formatProtectedSection(cfg: ProtectedRowsConfig): string {
  if (cfg.protected_rows.length === 0 && !cfg.protected_pattern) return "";
  const lines: string[] = [
    "",
    "【protected_rows — 編集禁止】",
    "以下の row は確定申告提出済等の理由で改変不可。編集・削除・archive を試みる前に必ず relvetic に承認を求めること。",
  ];
  for (const r of cfg.protected_rows) {
    lines.push(`  - ${r.id} — ${r.reason} (since ${r.since})`);
  }
  if (cfg.protected_pattern) {
    lines.push(
      `また、備考欄に「${cfg.protected_pattern}」が含まれる row も同様に protected として扱うこと。`
    );
  }
  return lines.join("\n");
}

export function defaultProtectedRowsPath(): string {
  return path.resolve(__dirname, "..", "..", "config", "protected-rows.json");
}
