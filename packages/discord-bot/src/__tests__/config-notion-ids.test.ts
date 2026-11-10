import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// notionDatabaseIds is read once at module load, so each case re-imports config.
async function loadNotionIds(): Promise<Record<string, string>> {
  vi.resetModules();
  return (await import("../config.js")).notionDatabaseIds;
}

describe("config: notionDatabaseIds source", () => {
  afterEach(() => {
    delete process.env.NOTION_IDS_PATH;
    vi.restoreAllMocks();
  });

  it("reads the file NOTION_IDS_PATH points to", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-ids-"));
    const file = path.join(dir, "ids.json");
    fs.writeFileSync(file, JSON.stringify({ tasks: "t-id", events: "e-id" }));
    process.env.NOTION_IDS_PATH = file;
    try {
      expect(await loadNotionIds()).toEqual({ tasks: "t-id", events: "e-id" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to config/notion-ids.json when NOTION_IDS_PATH is unset", async () => {
    delete process.env.NOTION_IDS_PATH;
    const defaultPath = path.resolve(__dirname, "..", "..", "config", "notion-ids.json");
    const realRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, opts?: unknown) =>
      p === defaultPath
        ? JSON.stringify({ notes: "n-id" })
        : realRead(p, opts as BufferEncoding)) as typeof fs.readFileSync);
    expect(await loadNotionIds()).toEqual({ notes: "n-id" });
  });
});
