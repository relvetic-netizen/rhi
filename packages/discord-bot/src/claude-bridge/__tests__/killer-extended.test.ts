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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-ext-"));
  registryPath = path.join(tmpDir, "registry.json");
  spawnMock.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mockTaskkillSuccess(): void {
  spawnMock.mockImplementation(() => {
    const fake = new FakeTaskkill();
    setImmediate(() => fake.close(0));
    return fake as unknown as ChildProcess;
  });
}

describe("killByPid", () => {
  it("denies bot self-kill without invoking taskkill", async () => {
    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    const result = await killByPid(1000, {
      botPid: 1000,
      registryPids: [],
      cseSessionPids: [],
    }, registry);
    expect("error" in result && result.error).toMatch(/self-kill/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("denies unknown PID without invoking taskkill", async () => {
    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    const result = await killByPid(9999, {
      botPid: 1,
      registryPids: [],
      cseSessionPids: [],
    }, registry);
    expect("error" in result && result.error).toMatch(/該当しない/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("kills registry PID and removes from registry on Windows", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "a", pid: 111, cwd: "/tmp", startedAt: new Date().toISOString() });
    registry.add({ name: "b", pid: 222, cwd: "/tmp", startedAt: new Date().toISOString() });

    mockTaskkillSuccess();

    const result = await killByPid(111, {
      botPid: 1,
      registryPids: [111, 222],
      cseSessionPids: [],
    }, registry);

    expect("succeeded" in result && result.succeeded).toBe(true);
    expect("kind" in result && result.kind).toBe("registry");
    const remaining = registry.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.pid).toBe(222);
  });

  it("kills cse PID without touching registry on Windows", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "keep", pid: 555, cwd: "/tmp", startedAt: new Date().toISOString() });

    mockTaskkillSuccess();

    const result = await killByPid(11160, {
      botPid: 1,
      registryPids: [555],
      cseSessionPids: [11160],
    }, registry);

    expect("succeeded" in result && result.succeeded).toBe(true);
    expect("kind" in result && result.kind).toBe("cse");
    expect(registry.list()).toHaveLength(1);
  });

  it("reports taskkill failure with error", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => fake.close(1));
      return fake as unknown as ChildProcess;
    });

    const result = await killByPid(11160, {
      botPid: 1,
      registryPids: [],
      cseSessionPids: [11160],
    }, registry);
    expect("succeeded" in result && result.succeeded).toBe(false);
    expect("error" in result && result.error).toBeTruthy();
  });

  it("treats exit 255 child-race (JP locale) as success", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "codex", pid: 22708, cwd: "/tmp", startedAt: new Date().toISOString() });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => {
        fake.stderr.emit(
          "data",
          Buffer.from(
            "エラー: PID 50776 のプロセス (PID 22708 の子プロセス) を終了できませんでした。\n" +
              "理由: 実行中のタスクのインスタンスがありません。\n"
          )
        );
        fake.close(255);
      });
      return fake as unknown as ChildProcess;
    });

    const result = await killByPid(22708, {
      botPid: 1,
      registryPids: [22708],
      cseSessionPids: [],
    }, registry);
    expect("succeeded" in result && result.succeeded).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it("treats exit 255 child-race (EN locale) as success", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "x", pid: 12345, cwd: "/tmp", startedAt: new Date().toISOString() });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => {
        fake.stderr.emit(
          "data",
          Buffer.from(
            "ERROR: The process with PID 67890 (child process of PID 12345) could not be terminated.\n" +
              "Reason: There is no running instance of the task.\n"
          )
        );
        fake.close(255);
      });
      return fake as unknown as ChildProcess;
    });

    const result = await killByPid(12345, {
      botPid: 1,
      registryPids: [12345],
      cseSessionPids: [],
    }, registry);
    expect("succeeded" in result && result.succeeded).toBe(true);
  });

  it("still rejects exit 255 when stderr is unrelated", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killByPid } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "x", pid: 999, cwd: "/tmp", startedAt: new Date().toISOString() });

    spawnMock.mockImplementation(() => {
      const fake = new FakeTaskkill();
      setImmediate(() => {
        fake.stderr.emit("data", Buffer.from("ERROR: Access is denied.\n"));
        fake.close(255);
      });
      return fake as unknown as ChildProcess;
    });

    const result = await killByPid(999, {
      botPid: 1,
      registryPids: [999],
      cseSessionPids: [],
    }, registry);
    expect("succeeded" in result && result.succeeded).toBe(false);
    expect("error" in result && result.error).toMatch(/Access is denied/);
  });
});

describe("killAllRegistryAndCse", () => {
  it("kills both registry and cse PIDs on Windows", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllRegistryAndCse } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "a", pid: 111, cwd: "/tmp", startedAt: new Date().toISOString() });

    mockTaskkillSuccess();

    const result = await killAllRegistryAndCse(registry, [11160, 24800]);
    expect(result.killed).toHaveLength(3);
    expect(result.killed.map((k) => k.pid).sort((a, b) => a - b)).toEqual([111, 11160, 24800]);
    expect(registry.list()).toEqual([]);
  });

  it("returns only registry kills when cse list is empty", async () => {
    if (process.platform !== "win32") return;

    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllRegistryAndCse } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    registry.add({ name: "a", pid: 111, cwd: "/tmp", startedAt: new Date().toISOString() });

    mockTaskkillSuccess();

    const result = await killAllRegistryAndCse(registry, []);
    expect(result.killed).toHaveLength(1);
  });

  it("handles both empty registry and empty cse", async () => {
    const { ClaudeRegistry } = await import("../registry.js");
    const { killAllRegistryAndCse } = await import("../killer.js");

    const registry = new ClaudeRegistry(registryPath);
    const result = await killAllRegistryAndCse(registry, []);
    expect(result.killed).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});
