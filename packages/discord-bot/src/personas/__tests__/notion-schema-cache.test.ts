import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock notionDatabaseIds before importing cache
vi.mock("../../config.js", () => ({
  notionDatabaseIds: {
    projects: "proj-id",
    invoices: "inv-id",
    tasks: "",          // empty — must be skipped
    dailyReport: "",   // empty — must be skipped
  },
}));

import {
  getSchemas,
  invalidate,
  notifyWrite,
  setAutoInvalidateOnWrite,
  isAutoInvalidateOnWrite,
  serializeForFirstMessage,
} from "../notion-schema-cache.js";

const OK_RESPONSE = {
  id: "proj-id",
  title: [{ plain_text: "Projects DB" }],
  properties: {
    名前: { name: "名前", type: "title" },
    ステータス: {
      name: "ステータス",
      type: "status",
      status: { options: [{ name: "未着手" }, { name: "進行中" }, { name: "完了" }] },
    },
    締切: { name: "締切", type: "date" },
    クライアント: {
      name: "クライアント",
      type: "relation",
      relation: { database_id: "client-db-id" },
    },
    タグ: {
      name: "タグ",
      type: "multi_select",
      multi_select: { options: [{ name: "急ぎ" }, { name: "見積もり中" }] },
    },
  },
};

describe("notion-schema-cache", () => {
  beforeEach(() => {
    invalidate();
    process.env.NOTION_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOTION_API_KEY;
  });

  it("skips empty IDs and only fetches configured DBs", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const schemas = await getSchemas();
    // 2 DB 中 1 回だけ最初に data_sources endpoint が呼ばれる想定 (projects + invoices)
    // → 2 DB × 1 endpoint = 2 fetch call (both succeed on first try)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(schemas).toHaveProperty("projects");
    expect(schemas).toHaveProperty("invoices");
    expect(schemas).not.toHaveProperty("tasks");
    expect(schemas).not.toHaveProperty("dailyReport");
  });

  it("uses cache on second call within TTL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await getSchemas(1000);
    const beforeSecond = fetchMock.mock.calls.length;
    await getSchemas(1000 + 60 * 1000); // +60s, well within TTL
    expect(fetchMock.mock.calls.length).toBe(beforeSecond); // no extra fetches
  });

  it("re-fetches after TTL expiry", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await getSchemas(1000);
    const before = fetchMock.mock.calls.length;
    await getSchemas(1000 + 25 * 60 * 60 * 1000); // +25h
    expect(fetchMock.mock.calls.length).toBe(before + 2); // 2 DBs re-fetched
  });

  it("gracefully skips on 403 / 404", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 404, json: async () => ({}) }; // data_sources 404 → fallback
      if (call === 2) return { ok: false, status: 403, json: async () => ({}) }; // databases 403 → give up
      return { ok: true, status: 200, json: async () => OK_RESPONSE };
    });
    vi.stubGlobal("fetch", fetchMock);
    const schemas = await getSchemas();
    // projects: data_sources 404 → databases 403 → null
    // invoices: data_sources 200 OK
    expect(schemas).not.toHaveProperty("projects");
    expect(schemas).toHaveProperty("invoices");
  });

  it("invalidate() clears cache", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);
    await getSchemas();
    const before = fetchMock.mock.calls.length;
    invalidate();
    await getSchemas();
    expect(fetchMock.mock.calls.length).toBe(before * 2);
  });

  it("returns empty when NOTION_API_KEY missing", async () => {
    delete process.env.NOTION_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const schemas = await getSchemas();
    expect(schemas).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializeForFirstMessage renders schema block", () => {
    const schemas = {
      projects: {
        id: "proj-id",
        title: "Projects DB",
        properties: {
          名前: { name: "名前", type: "title" },
          ステータス: {
            name: "ステータス",
            type: "status",
            description: "options: 未着手 / 完了",
          },
          クライアント: {
            name: "クライアント",
            type: "relation",
            description: "relation → client-db-id",
          },
        },
        fetchedAt: Date.now(),
      },
    };
    const s = serializeForFirstMessage(schemas);
    expect(s.startsWith("<notion_schemas>")).toBe(true);
    expect(s.endsWith("</notion_schemas>")).toBe(true);
    expect(s).toContain("### projects (Projects DB)");
    expect(s).toContain("data_source_id: proj-id");
    expect(s).toContain("ステータス (status) — options: 未着手 / 完了");
    expect(s).toContain("クライアント (relation) — relation → client-db-id");
  });

  it("serializeForFirstMessage returns empty string for no schemas", () => {
    expect(serializeForFirstMessage({})).toBe("");
  });

  describe("autoInvalidateOnWrite (notifyWrite hook)", () => {
    it("is enabled by default", () => {
      expect(isAutoInvalidateOnWrite()).toBe(true);
    });

    it("evicts the targeted entry on notifyWrite by schema name", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      notifyWrite("projects");
      await getSchemas();
      // projects 1 件は再 fetch (data_sources のみ成功するので +1)、invoices は cache 維持
      expect(fetchMock.mock.calls.length).toBe(before + 1);
    });

    it("evicts by DS id (not name)", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      // OK_RESPONSE.id = "proj-id" は projects + invoices (mock の id 同一)、
      // しかし cache の entry id は両方 "proj-id" になるため両方 evict される
      notifyWrite("proj-id");
      await getSchemas();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    });

    it("no-op when autoInvalidate disabled", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      setAutoInvalidateOnWrite(false);
      try {
        notifyWrite("projects");
        await getSchemas();
        expect(fetchMock.mock.calls.length).toBe(before); // no refetch
      } finally {
        setAutoInvalidateOnWrite(true);
      }
    });

    it("per-call opts override the global flag", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      setAutoInvalidateOnWrite(false);
      try {
        notifyWrite("projects", { autoInvalidateOnWrite: true });
        await getSchemas();
        expect(fetchMock.mock.calls.length).toBe(before + 1);
      } finally {
        setAutoInvalidateOnWrite(true);
      }
    });

    it("notifyWrite with empty string is a no-op", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      notifyWrite("");
      await getSchemas();
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    it("invalidate(name) only evicts that name", async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
      }));
      vi.stubGlobal("fetch", fetchMock);
      await getSchemas();
      const before = fetchMock.mock.calls.length;
      invalidate("projects");
      await getSchemas();
      expect(fetchMock.mock.calls.length).toBe(before + 1); // 1 entry refetched
    });
  });

  it("extracts status and multi_select options", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => OK_RESPONSE,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const schemas = await getSchemas();
    const p = schemas.projects;
    expect(p.properties["ステータス"].description).toContain("未着手");
    expect(p.properties["タグ"].description).toContain("急ぎ");
    expect(p.properties["クライアント"].description).toBe("relation → client-db-id");
  });
});
