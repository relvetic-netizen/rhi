import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  loadProtectedRowsConfig,
  isProtectedId,
  isProtectedRow,
  matchesProtectedPattern,
  formatProtectedSection,
  type ProtectedRowsConfig,
} from "../protected-rows.js";

const SAMPLE: ProtectedRowsConfig = {
  protected_rows: [
    {
      id: "12345678-90ab-cdef-1234-567890abcdef",
      reason: "2024年度 集約",
      since: "2026-05-13",
    },
  ],
  protected_pattern: "【2024年度集約 row、確定申告提出済】",
};

function writeTempJson(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-rows-"));
  const p = path.join(dir, "protected-rows.json");
  fs.writeFileSync(p, JSON.stringify(obj), "utf-8");
  return p;
}

describe("protected-rows loader", () => {
  it("loads a valid json", () => {
    const p = writeTempJson(SAMPLE);
    const cfg = loadProtectedRowsConfig(p);
    expect(cfg.protected_rows).toHaveLength(1);
    expect(cfg.protected_rows[0].id).toBe(SAMPLE.protected_rows[0].id);
    expect(cfg.protected_pattern).toBe(SAMPLE.protected_pattern);
  });

  it("returns empty config when file is missing", () => {
    const cfg = loadProtectedRowsConfig(path.join(os.tmpdir(), "no-such-file.json"));
    expect(cfg.protected_rows).toEqual([]);
    expect(cfg.protected_pattern).toBe("");
  });

  it("returns empty config on malformed json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-rows-bad-"));
    const p = path.join(dir, "broken.json");
    fs.writeFileSync(p, "{ not valid json", "utf-8");
    const cfg = loadProtectedRowsConfig(p);
    expect(cfg.protected_rows).toEqual([]);
    expect(cfg.protected_pattern).toBe("");
  });

  it("tolerates partial schemas", () => {
    const p = writeTempJson({ protected_rows: SAMPLE.protected_rows });
    const cfg = loadProtectedRowsConfig(p);
    expect(cfg.protected_rows).toHaveLength(1);
    expect(cfg.protected_pattern).toBe("");
  });
});

describe("isProtectedId", () => {
  it("matches both dashed and undashed forms", () => {
    expect(
      isProtectedId(SAMPLE, "12345678-90ab-cdef-1234-567890abcdef")
    ).toBe(true);
    expect(isProtectedId(SAMPLE, "1234567890abcdef1234567890abcdef")).toBe(true);
    expect(isProtectedId(SAMPLE, "12345678-90AB-CDEF-1234-567890ABCDEF")).toBe(true);
  });

  it("rejects unrelated id", () => {
    expect(
      isProtectedId(SAMPLE, "00000000-0000-0000-0000-000000000000")
    ).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(
      isProtectedId(
        { protected_rows: [], protected_pattern: "" },
        "12345678-90ab-cdef-1234-567890abcdef"
      )
    ).toBe(false);
  });
});

describe("matchesProtectedPattern + isProtectedRow", () => {
  it("matches when pattern is in memo", () => {
    expect(
      matchesProtectedPattern(SAMPLE, "備考: 【2024年度集約 row、確定申告提出済】")
    ).toBe(true);
  });

  it("does not match when memo missing", () => {
    expect(matchesProtectedPattern(SAMPLE, null)).toBe(false);
    expect(matchesProtectedPattern(SAMPLE, undefined)).toBe(false);
    expect(matchesProtectedPattern(SAMPLE, "通常の備考")).toBe(false);
  });

  it("isProtectedRow uses id OR pattern", () => {
    expect(
      isProtectedRow(SAMPLE, { id: "1234567890abcdef1234567890abcdef" })
    ).toBe(true);
    expect(
      isProtectedRow(SAMPLE, {
        id: "other-id",
        memo: "...【2024年度集約 row、確定申告提出済】...",
      })
    ).toBe(true);
    expect(isProtectedRow(SAMPLE, { id: "other-id", memo: "通常" })).toBe(false);
  });
});

describe("formatProtectedSection", () => {
  it("returns empty string for empty config", () => {
    expect(
      formatProtectedSection({ protected_rows: [], protected_pattern: "" })
    ).toBe("");
  });

  it("emits each protected row id + reason", () => {
    const s = formatProtectedSection(SAMPLE);
    expect(s).toContain("12345678-90ab-cdef-1234-567890abcdef");
    expect(s).toContain("2024年度 集約");
    expect(s).toContain("【2024年度集約 row、確定申告提出済】");
    expect(s).toMatch(/編集禁止/);
  });
});
