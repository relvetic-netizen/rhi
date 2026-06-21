import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  appendAudit,
  buildEntry,
  readAudit,
  resolveAuditPath,
  serializeEntry,
  type AuditEntry,
} from "../audit-log.js";

function freshBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rhi-audit-"));
}

describe("audit-log", () => {
  describe("resolveAuditPath", () => {
    it("partitions by JST (Asia/Tokyo) date, zero-padded", () => {
      // 2026-01-05 00:00 UTC = 09:00 JST 同日 → 2026-01-05
      const p = resolveAuditPath(new Date("2026-01-05T00:00:00Z"), "/base");
      expect(p.replace(/\\/g, "/")).toBe("/base/2026/01/2026-01-05.jsonl");
    });

    it("rolls over at JST midnight, not UTC midnight", () => {
      // 2026-05-13 15:30 UTC = 2026-05-14 00:30 JST → 翌日 partition
      const p = resolveAuditPath(new Date("2026-05-13T15:30:00Z"), "/base");
      expect(p.replace(/\\/g, "/")).toBe("/base/2026/05/2026-05-14.jsonl");
    });

    it("00-08:59 JST window stays on the JST calendar day (not UTC prev-day)", () => {
      // 2026-05-13 23:00 UTC = 2026-05-14 08:00 JST → 2026-05-14
      const p = resolveAuditPath(new Date("2026-05-13T23:00:00Z"), "/base");
      expect(p.replace(/\\/g, "/")).toBe("/base/2026/05/2026-05-14.jsonl");
    });

    it("nests under base dir", () => {
      const base = freshBaseDir();
      // 2026-12-31 23:59 UTC = 2027-01-01 08:59 JST → 翌年 partition
      const p = resolveAuditPath(new Date("2026-12-31T23:59:59Z"), base);
      expect(p).toContain("2027");
      expect(p).toContain("01");
      expect(p.endsWith("2027-01-01.jsonl")).toBe(true);
    });
  });

  describe("buildEntry", () => {
    it("auto-fills ts when omitted", () => {
      const e = buildEntry({
        tool: "notion-create-pages",
        target_id: "page-123",
        target_type: "page",
        action: "create",
        result: "ok",
      });
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("preserves ts when provided", () => {
      const e = buildEntry({
        ts: "2026-05-13T02:00:00.000Z",
        tool: "notion-update-page",
        target_id: "page-1",
        target_type: "page",
        action: "update",
        result: "ok",
      });
      expect(e.ts).toBe("2026-05-13T02:00:00.000Z");
    });
  });

  describe("serializeEntry", () => {
    it("emits a single JSON line (no trailing newline)", () => {
      const e: AuditEntry = {
        ts: "2026-05-13T02:00:00.000Z",
        tool: "notion-create-pages",
        target_id: "page-x",
        target_type: "page",
        action: "create",
        result: "ok",
      };
      const s = serializeEntry(e);
      expect(s.endsWith("\n")).toBe(false);
      expect(JSON.parse(s)).toEqual(e);
    });
  });

  describe("appendAudit", () => {
    let baseDir: string;
    beforeEach(() => {
      baseDir = freshBaseDir();
    });

    it("creates parent dirs and writes a single JSONL line", () => {
      const e = buildEntry({
        tool: "notion-create-pages",
        target_id: "abc",
        target_type: "page",
        action: "create",
        result: "ok",
      });
      const { path: p } = appendAudit(e, {
        baseDir,
        now: new Date("2026-05-13T02:00:00Z"),
      });
      expect(fs.existsSync(p)).toBe(true);
      const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        tool: "notion-create-pages",
        target_id: "abc",
        action: "create",
        result: "ok",
      });
    });

    it("appends without rewriting (multiple calls accumulate)", () => {
      const now = new Date("2026-05-13T02:00:00Z");
      const e1 = buildEntry({
        tool: "notion-create-pages",
        target_id: "a",
        target_type: "page",
        action: "create",
        result: "ok",
      });
      const e2 = buildEntry({
        tool: "notion-update-page",
        target_id: "b",
        target_type: "page",
        action: "update",
        result: "error",
        error: "rate_limited",
      });
      appendAudit(e1, { baseDir, now });
      appendAudit(e2, { baseDir, now });
      const p = resolveAuditPath(now, baseDir);
      const entries = readAudit(p);
      expect(entries).toHaveLength(2);
      expect(entries[0].target_id).toBe("a");
      expect(entries[1].target_id).toBe("b");
      expect(entries[1].error).toBe("rate_limited");
    });

    it("each entry round-trips through JSON.parse without loss", () => {
      const e = buildEntry({
        tool: "notion-update-data-source",
        target_id: "ds-1",
        target_type: "data_source",
        action: "update_data_source",
        user_id: "user-42",
        result: "ok",
      });
      appendAudit(e, { baseDir, now: new Date("2026-05-13T02:00:00Z") });
      const p = resolveAuditPath(new Date("2026-05-13T02:00:00Z"), baseDir);
      const [parsed] = readAudit(p);
      expect(parsed).toEqual(e);
    });
  });

  describe("readAudit", () => {
    it("returns empty array when the file is missing", () => {
      expect(readAudit(path.join(os.tmpdir(), "no-such.jsonl"))).toEqual([]);
    });

    it("skips malformed lines but keeps valid ones", () => {
      const base = freshBaseDir();
      const file = path.join(base, "broken.jsonl");
      fs.writeFileSync(
        file,
        [
          JSON.stringify({
            ts: "2026-05-13T02:00:00.000Z",
            tool: "notion-create-pages",
            target_id: "ok-1",
            target_type: "page",
            action: "create",
            result: "ok",
          }),
          "not a valid json line",
          "",
          JSON.stringify({
            ts: "2026-05-13T02:01:00.000Z",
            tool: "notion-update-page",
            target_id: "ok-2",
            target_type: "page",
            action: "update",
            result: "ok",
          }),
        ].join("\n") + "\n",
        "utf-8"
      );
      const out = readAudit(file);
      expect(out).toHaveLength(2);
      expect(out.map((e) => e.target_id)).toEqual(["ok-1", "ok-2"]);
    });
  });
});
