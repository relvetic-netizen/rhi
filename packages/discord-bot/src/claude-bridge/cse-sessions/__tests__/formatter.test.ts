import { describe, it, expect } from "vitest";
import {
  formatAge,
  shortCseId,
  formatBytes,
  formatList,
  formatKillByPid,
} from "../formatter.js";
import type { ClassifiedSessions } from "../inspector.js";

describe("formatAge", () => {
  const t0 = new Date("2026-04-26T10:00:00Z");

  it("returns <1m for under 60s", () => {
    expect(formatAge(t0, new Date(t0.getTime() + 30_000))).toBe("<1m");
  });

  it("returns Nm for under an hour", () => {
    expect(formatAge(t0, new Date(t0.getTime() + 5 * 60_000))).toBe("5m");
  });

  it("returns Nh Mm for over an hour", () => {
    const later = new Date(t0.getTime() + (2 * 60 + 15) * 60_000);
    expect(formatAge(t0, later)).toBe("2h 15m");
  });

  it("returns Nh 0m for exact hour", () => {
    expect(formatAge(t0, new Date(t0.getTime() + 3 * 3600_000))).toBe("3h 0m");
  });
});

describe("shortCseId", () => {
  it("truncates to 12 chars by default", () => {
    expect(shortCseId("cse_01HewnjQGi9zStJVbDsgyZC3")).toBe("cse_01HewnjQ");
  });

  it("preserves shorter IDs", () => {
    expect(shortCseId("cse_short")).toBe("cse_short");
  });
});

describe("formatBytes", () => {
  it("converts to MB rounded", () => {
    expect(formatBytes(1024 * 1024)).toBe("1 MB");
    expect(formatBytes(336 * 1024 * 1024)).toBe("336 MB");
  });
});

describe("formatList", () => {
  it("returns empty message when no processes", () => {
    const empty: ClassifiedSessions = {
      hubPid: null,
      registry: [],
      cse: [],
      unclassified: [],
    };
    expect(formatList(empty)).toBe("現存する Claude プロセス無し。");
  });

  it("renders registry and cse with badges", () => {
    const t0 = new Date("2026-04-26T10:00:00Z");
    const now = new Date(t0.getTime() + 2 * 3600_000);
    const c: ClassifiedSessions = {
      hubPid: 8568,
      registry: [
        {
          proc: {
            pid: 18488,
            parentPid: 2744,
            startedAt: t0,
            workingSetBytes: 500 * 1024 * 1024,
            commandLine: "x",
          },
          entry: {
            name: "claude-1",
            pid: 18488,
            cwd: "C:\\Users\\testuser",
            startedAt: t0.toISOString(),
          },
        },
      ],
      cse: [
        {
          proc: {
            pid: 11160,
            parentPid: 8568,
            startedAt: t0,
            workingSetBytes: 336 * 1024 * 1024,
            commandLine: "x",
          },
          sessionId: "cse_01HewnjQGi9zStJVbDsgyZC3",
        },
      ],
      unclassified: [],
    };
    const out = formatList(c, now);
    expect(out).toContain("Active Claude processes (2)");
    expect(out).toContain("[registry]");
    expect(out).toContain("PID 18488");
    expect(out).toContain("claude-1");
    expect(out).toContain("[cse]");
    expect(out).toContain("PID 11160");
    expect(out).toContain("cse_01HewnjQ");
    expect(out).toContain("parent=8568 (hub)");
    expect(out).toContain("336 MB");
    expect(out).toContain("2h 0m");
  });

  it("excludes unclassified from output", () => {
    const c: ClassifiedSessions = {
      hubPid: null,
      registry: [],
      cse: [],
      unclassified: [
        {
          pid: 99999,
          parentPid: 1,
          startedAt: new Date(),
          workingSetBytes: 0,
          commandLine: "x",
        },
      ],
    };
    expect(formatList(c)).toBe("現存する Claude プロセス無し。");
  });
});

describe("formatKillByPid", () => {
  it("formats success", () => {
    expect(
      formatKillByPid({ pid: 11160, kind: "cse", succeeded: true })
    ).toBe("Killed PID 11160 (kind=cse)");
  });

  it("formats taskkill failure", () => {
    expect(
      formatKillByPid({ pid: 11160, kind: "cse", succeeded: false, error: "timeout" })
    ).toContain("Failed to kill PID 11160");
  });

  it("formats policy denial", () => {
    expect(formatKillByPid({ error: "self-kill 禁止" })).toBe("Failed: self-kill 禁止");
  });
});
