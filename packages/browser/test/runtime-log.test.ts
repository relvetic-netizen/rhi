import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withLogging } from "../src/runtime-log.js";

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), "relvetia-browser-log-"));
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

describe("withLogging", () => {
  it("writes JSONL entry for success", async () => {
    const out = await withLogging(
      "test-op",
      { a: 1 },
      async () => ({ value: 42 }),
      logDir,
    );
    expect(out).toEqual({ value: 42 });
    const files = await readdir(logDir);
    expect(files.length).toBe(1);
    const line = (await readFile(path.join(logDir, files[0]), "utf8")).trim();
    const entry = JSON.parse(line);
    expect(entry.command).toBe("test-op");
    expect(entry.args).toEqual({ a: 1 });
    expect(entry.result).toEqual({ value: 42 });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.error).toBeUndefined();
  });

  it("writes JSONL entry for failure and rethrows", async () => {
    await expect(
      withLogging("fail-op", {}, async () => {
        throw new Error("boom");
      }, logDir),
    ).rejects.toThrow("boom");
    const files = await readdir(logDir);
    const line = (await readFile(path.join(logDir, files[0]), "utf8")).trim();
    const entry = JSON.parse(line);
    expect(entry.command).toBe("fail-op");
    expect(entry.error).toEqual({ name: "Error", message: "boom" });
    expect(entry.result).toBeUndefined();
  });

  it("truncates long string fields in result", async () => {
    const long = "x".repeat(500);
    await withLogging("big", {}, async () => ({ blob: long }), logDir);
    const files = await readdir(logDir);
    const line = (await readFile(path.join(logDir, files[0]), "utf8")).trim();
    const entry = JSON.parse(line);
    expect(entry.result.blob.length).toBeLessThan(long.length);
    expect(entry.result.blob.endsWith("…")).toBe(true);
  });
});
