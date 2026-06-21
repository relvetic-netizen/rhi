import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

class FakeTaskkill extends EventEmitter {
  public stderr = new EventEmitter();
  close(code: number): void {
    this.emit("close", code);
  }
}

let tmpDir: string;
let registryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-"));
  registryPath = path.join(tmpDir, "registry.json");
  spawnMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("killAllClaudes", () => {
  it("returns empty result when registry is empty", async () => {
    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllClaudes } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    const result = await killAllClaudes(registry);
    expect(result.killed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("invokes taskkill for each entry and clears registry on Windows", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllClaudes } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({
      name: "a",
      pid: 111,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    registry.add({
      name: "b",
      pid: 222,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => fake.close(0));
      return fake as unknown as ChildProcess;
    });

    const result = await killAllClaudes(registry);
    expect(result.killed).toHaveLength(2);
    expect(result.killed.map((e) => e.pid).sort()).toEqual([111, 222]);
    expect(result.failed).toEqual([]);
    expect(registry.list()).toEqual([]);

    for (const call of spawnMock.mock.calls) {
      const [cmd, args] = call as [string, string[]];
      expect(cmd).toBe("taskkill");
      expect(args).toContain("/T");
      expect(args).toContain("/F");
    }
  });

  it("treats exit code 128 as success on Windows (process already dead)", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllClaudes } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({
      name: "a",
      pid: 111,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => fake.close(128));
      return fake as unknown as ChildProcess;
    });

    const result = await killAllClaudes(registry);
    expect(result.killed).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it("records failures for non-zero exit codes other than 128", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllClaudes } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({
      name: "a",
      pid: 111,
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => fake.close(1));
      return fake as unknown as ChildProcess;
    });

    const result = await killAllClaudes(registry);
    expect(result.killed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.pid).toBe(111);
  });
});

describe("formatKillReport", () => {
  it("formats empty result", async () => {
    const { formatKillReport } = await import("../killer.js");
    expect(formatKillReport({ killed: [], failed: [] })).toBe(
      "No Claudes in registry."
    );
  });

  it("formats killed entries", async () => {
    const { formatKillReport } = await import("../killer.js");
    const out = formatKillReport({
      killed: [
        { name: "a", pid: 1 },
        { name: "b", pid: 2 },
      ],
      failed: [],
    });
    expect(out).toContain("Killed 2");
    expect(out).toContain("a(PID 1)");
    expect(out).toContain("b(PID 2)");
  });

  it("formats failed entries", async () => {
    const { formatKillReport } = await import("../killer.js");
    const out = formatKillReport({
      killed: [],
      failed: [{ name: "a", pid: 1, error: "boom" }],
    });
    expect(out).toContain("Failed 1");
    expect(out).toContain("boom");
  });
});
