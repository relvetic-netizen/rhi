import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  parseWmicJson,
  detectHubPid,
  isCseProcess,
  isHubProcess,
  extractCseId,
  classify,
  type ClaudeProcess,
} from "../inspector.js";
import type { ClaudeEntry } from "../../registry.js";

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf-8");

describe("parseWmicJson", () => {
  it("parses a 4-process array fixture", () => {
    const procs = parseWmicJson(fixture("wmic-3-processes.json"));
    expect(procs).toHaveLength(4);
    const pids = procs.map((p) => p.pid).sort((a, b) => a - b);
    expect(pids).toEqual([8568, 11160, 16336, 18488]);
  });

  it("parses a single-object fixture (PowerShell single-element behavior)", () => {
    const procs = parseWmicJson(fixture("wmic-single.json"));
    expect(procs).toHaveLength(1);
    expect(procs[0]?.pid).toBe(8568);
  });

  it("returns empty array for empty input", () => {
    expect(parseWmicJson("")).toEqual([]);
    expect(parseWmicJson("   \n  ")).toEqual([]);
  });

  it("returns empty array for malformed JSON", () => {
    expect(parseWmicJson("not json")).toEqual([]);
  });

  it("converts /Date(millis)/ to Date object", () => {
    const procs = parseWmicJson(fixture("wmic-single.json"));
    expect(procs[0]?.startedAt.getTime()).toBe(1777123236876);
  });

  it("preserves CommandLine and WorkingSetSize", () => {
    const procs = parseWmicJson(fixture("wmic-3-processes.json"));
    const cse = procs.find((p) => p.pid === 11160)!;
    expect(cse.commandLine).toContain("--sdk-url");
    expect(cse.commandLine).toContain("cse_01HewnjQGi9zStJVbDsgyZC3");
    expect(cse.workingSetBytes).toBeGreaterThan(0);
  });
});

describe("isCseProcess / isHubProcess / extractCseId", () => {
  const procs = parseWmicJson(fixture("wmic-3-processes.json"));
  const hub = procs.find((p) => p.pid === 8568)!;
  const cse = procs.find((p) => p.pid === 11160)!;
  const interactive = procs.find((p) => p.pid === 18488)!;

  it("identifies hub", () => {
    expect(isHubProcess(hub.commandLine)).toBe(true);
    expect(isHubProcess(cse.commandLine)).toBe(false);
    expect(isHubProcess(interactive.commandLine)).toBe(false);
  });

  it("identifies cse_session", () => {
    expect(isCseProcess(cse.commandLine)).toBe(true);
    expect(isCseProcess(hub.commandLine)).toBe(false);
    expect(isCseProcess(interactive.commandLine)).toBe(false);
  });

  it("extracts cse_id", () => {
    expect(extractCseId(cse.commandLine)).toBe("cse_01HewnjQGi9zStJVbDsgyZC3");
    expect(extractCseId(interactive.commandLine)).toBeNull();
  });
});

describe("detectHubPid", () => {
  it("detects hub PID 8568 from fixture", () => {
    const procs = parseWmicJson(fixture("wmic-3-processes.json"));
    expect(detectHubPid(procs)).toBe(8568);
  });

  it("returns null when no hub present", () => {
    const procs = parseWmicJson(fixture("wmic-3-processes.json")).filter(
      (p) => p.pid !== 8568
    );
    expect(detectHubPid(procs)).toBeNull();
  });
});

describe("classify", () => {
  const procs = parseWmicJson(fixture("wmic-3-processes.json"));

  it("classifies hub as hubPid (not in registry/cse/unclassified)", () => {
    const c = classify(procs, []);
    expect(c.hubPid).toBe(8568);
    const allOther = [...c.registry, ...c.cse, ...c.unclassified.map((p) => ({ proc: p }))];
    expect(allOther.find((x) => x.proc.pid === 8568)).toBeUndefined();
  });

  it("places cse_session under cse", () => {
    const c = classify(procs, []);
    expect(c.cse).toHaveLength(1);
    expect(c.cse[0]?.proc.pid).toBe(11160);
    expect(c.cse[0]?.sessionId).toBe("cse_01HewnjQGi9zStJVbDsgyZC3");
  });

  it("places interactive (no registry, no cse) under unclassified", () => {
    const c = classify(procs, []);
    const unclassifiedPids = c.unclassified.map((p) => p.pid).sort((a, b) => a - b);
    expect(unclassifiedPids).toEqual([16336, 18488]);
  });

  it("registry entry takes precedence over unclassified", () => {
    const entry: ClaudeEntry = {
      name: "claude-1",
      pid: 18488,
      cwd: "C:\\Users\\testuser",
      startedAt: new Date().toISOString(),
    };
    const c = classify(procs, [entry]);
    expect(c.registry).toHaveLength(1);
    expect(c.registry[0]?.entry.name).toBe("claude-1");
    expect(c.unclassified.find((p) => p.pid === 18488)).toBeUndefined();
  });

  it("registry entry takes precedence over cse classification", () => {
    const entry: ClaudeEntry = {
      name: "shadowed",
      pid: 11160,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    };
    const c = classify(procs, [entry]);
    expect(c.registry.find((r) => r.proc.pid === 11160)).toBeDefined();
    expect(c.cse.find((x) => x.proc.pid === 11160)).toBeUndefined();
  });

  it("rejects cse classification when parent is not hub (and hub exists)", () => {
    const fakeProcs: ClaudeProcess[] = [
      ...procs,
      {
        pid: 99999,
        parentPid: 12345,
        startedAt: new Date(),
        workingSetBytes: 100_000_000,
        commandLine: "claude.exe --sdk-url http://x/cse_FAKE --session-id cse_FAKE",
      },
    ];
    const c = classify(fakeProcs, []);
    expect(c.cse.find((x) => x.proc.pid === 99999)).toBeUndefined();
    expect(c.unclassified.find((p) => p.pid === 99999)).toBeDefined();
  });

  it("accepts cse classification when no hub detected (fallback)", () => {
    const noHub = procs.filter((p) => p.pid !== 8568);
    const c = classify(noHub, []);
    expect(c.hubPid).toBeNull();
    expect(c.cse.find((x) => x.proc.pid === 11160)).toBeDefined();
  });

  it("handles empty input", () => {
    const c = classify([], []);
    expect(c).toEqual({ hubPid: null, registry: [], cse: [], unclassified: [] });
  });
});
