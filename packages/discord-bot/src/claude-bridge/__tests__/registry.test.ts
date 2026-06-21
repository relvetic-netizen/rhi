import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { ClaudeRegistry, type ClaudeEntry } from "../registry.js";

let tmpDir: string;
let registryPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-registry-"));
  registryPath = path.join(tmpDir, "registry.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<ClaudeEntry> = {}): ClaudeEntry {
  return {
    name: "claude-1",
    pid: 1234,
    cwd: "/tmp",
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ClaudeRegistry", () => {
  it("returns empty list when file does not exist", () => {
    const registry = new ClaudeRegistry(registryPath);
    expect(registry.list()).toEqual([]);
  });

  it("adds entries and persists them to disk", () => {
    const registry = new ClaudeRegistry(registryPath);
    const entry = makeEntry();
    registry.add(entry);

    const fresh = new ClaudeRegistry(registryPath);
    expect(fresh.list()).toEqual([entry]);
  });

  it("rejects duplicate names", () => {
    const registry = new ClaudeRegistry(registryPath);
    registry.add(makeEntry({ name: "dup", pid: 1 }));
    expect(() => registry.add(makeEntry({ name: "dup", pid: 2 }))).toThrow(
      /already in registry/
    );
  });

  it("removes entries by pid", () => {
    const registry = new ClaudeRegistry(registryPath);
    registry.add(makeEntry({ name: "a", pid: 1 }));
    registry.add(makeEntry({ name: "b", pid: 2 }));
    registry.remove(1);
    const remaining = registry.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.pid).toBe(2);
  });

  it("clears all entries", () => {
    const registry = new ClaudeRegistry(registryPath);
    registry.add(makeEntry({ name: "a", pid: 1 }));
    registry.add(makeEntry({ name: "b", pid: 2 }));
    registry.clear();
    expect(registry.list()).toEqual([]);
  });

  it("recovers from corrupt json by returning empty", () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, "not json");
    const registry = new ClaudeRegistry(registryPath);
    expect(() => registry.list()).toThrow();
  });

  it("treats non-array json as empty", () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ not: "array" }));
    const registry = new ClaudeRegistry(registryPath);
    expect(registry.list()).toEqual([]);
  });

  it("creates parent directories when writing", () => {
    const nested = path.join(tmpDir, "nested", "dir", "registry.json");
    const registry = new ClaudeRegistry(nested);
    registry.add(makeEntry());
    expect(fs.existsSync(nested)).toBe(true);
  });
});
