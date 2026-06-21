import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  notionDatabaseIds: { tasks: "mock-tasks-db-id" },
  channelConfigs: {},
  config: { allowedUserIds: null, allowedWorkingDirs: [] },
  getChannelMode: () => "none",
}));

const TASKS_DB_ID = "mock-tasks-db-id";

vi.mock("../../personas/notion-schema-cache.js", () => ({
  invalidate: vi.fn(),
  notifyWrite: vi.fn(),
}));

vi.mock("../../audit/audit-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../audit/audit-log.js")>();
  return {
    ...actual,
    appendAudit: vi.fn(() => ({ path: "/tmp/mock-audit.jsonl" })),
  };
});

import { handleTask } from "../commands.js";
import { appendAudit } from "../../audit/audit-log.js";
import { notifyWrite } from "../../personas/notion-schema-cache.js";

function mockInteraction(userId = "test-user-123") {
  return {
    options: {
      getString: vi.fn().mockReturnValue("テストタスク"),
    },
    user: { id: userId },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Parameters<typeof handleTask>[0];
}

describe("handleTask integration — audit + notify contract", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.NOTION_API_KEY = "test-key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("success: notifies tasks cache + audits created page id with target_type='page'", async () => {
    const createdPageId = "created-page-abc123";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: createdPageId }),
    }) as unknown as typeof globalThis.fetch;

    const interaction = mockInteraction();
    await handleTask(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("タスクを作成しました") })
    );
    expect(notifyWrite).toHaveBeenCalledTimes(1);
    expect(notifyWrite).toHaveBeenCalledWith("tasks");

    expect(appendAudit).toHaveBeenCalledTimes(1);
    const auditEntry = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry).toMatchObject({
      tool: "notion-create-pages",
      target_id: createdPageId,
      target_type: "page",
      action: "create",
      user_id: "test-user-123",
      result: "ok",
    });
  });

  it("failure: skips cache notify + audits DB id with target_type='data_source' and result='error'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    }) as unknown as typeof globalThis.fetch;

    const interaction = mockInteraction();
    await handleTask(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("タスク作成失敗"),
        ephemeral: true,
      })
    );
    expect(notifyWrite).not.toHaveBeenCalled();

    expect(appendAudit).toHaveBeenCalledTimes(1);
    const auditEntry = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry).toMatchObject({
      tool: "notion-create-pages",
      target_id: TASKS_DB_ID,
      target_type: "data_source",
      action: "create",
      user_id: "test-user-123",
      result: "error",
    });
    expect(typeof (auditEntry as { error?: unknown }).error).toBe("string");
  });

  it("success but unparseable Notion response: falls back to target_id=DB and target_type='data_source'", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("JSON parse error")),
    }) as unknown as typeof globalThis.fetch;

    const interaction = mockInteraction();
    await handleTask(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("タスクを作成しました") })
    );
    // Cache invalidation still fires because Notion returned ok.
    expect(notifyWrite).toHaveBeenCalledWith("tasks");

    expect(appendAudit).toHaveBeenCalledTimes(1);
    const auditEntry = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry).toMatchObject({
      tool: "notion-create-pages",
      target_id: TASKS_DB_ID,
      target_type: "data_source",
      action: "create",
      result: "ok",
    });
  });

  it("success with empty page id in Notion response: falls back to target_id=DB", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "" }),
    }) as unknown as typeof globalThis.fetch;

    const interaction = mockInteraction();
    await handleTask(interaction);

    expect(appendAudit).toHaveBeenCalledTimes(1);
    const auditEntry = (appendAudit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEntry).toMatchObject({
      target_id: TASKS_DB_ID,
      target_type: "data_source",
      result: "ok",
    });
  });
});
