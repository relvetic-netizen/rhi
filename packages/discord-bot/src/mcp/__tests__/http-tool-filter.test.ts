import { describe, it, expect, vi } from "vitest";

process.env.DISCORD_BOT_TOKEN ??= "ci-dummy-token";
process.env.MCP_HTTP_ENABLE = "false";

function makeClientStub(): import("discord.js").Client {
  const stub = {
    user: { id: "stub-bot", tag: "stub#0000" },
    isReady: () => true,
    guilds: { cache: new Map(), fetch: vi.fn() },
    application: { fetch: vi.fn() },
    destroy: vi.fn(),
  };
  return stub as unknown as import("discord.js").Client;
}

interface RegisteredToolInternal {
  handler: (...args: unknown[]) => unknown;
  enabled: boolean;
  remove(): void;
}
type ToolRegistry = Record<string, RegisteredToolInternal | undefined>;

describe("createHttpMcpServer + _registeredTools SDK regression", () => {
  it("exposes _registeredTools as a Record on the McpServer instance after creation", async () => {
    // The HTTP-side hardening (denylist + per-tool validator wrap) reads the
    // private `_registeredTools` registry on McpServer. SDK 1.29.0 happens to
    // store tools there; a future SDK refactor that renames or restructures
    // this field would silently break our denylist and wrapHandler logic.
    // Asserting the shape here turns that silent break into a loud test fail.
    const { createHttpMcpServer } = await import("../http-tool-filter.js");
    const server = createHttpMcpServer(makeClientStub());
    const internal = (server as unknown as { _registeredTools?: ToolRegistry })
      ._registeredTools;
    expect(internal, "_registeredTools must exist on McpServer").toBeDefined();
    expect(typeof internal).toBe("object");

    const entries = Object.entries(internal ?? {});
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, tool] of entries) {
      if (!tool) continue;
      expect(typeof tool.handler, `${name}.handler`).toBe("function");
      expect(typeof tool.enabled, `${name}.enabled`).toBe("boolean");
      expect(typeof tool.remove, `${name}.remove`).toBe("function");
    }
  });

  it("listHttpToolNames throws when _registeredTools is missing (SDK shape drift)", async () => {
    const { listHttpToolNames } = await import("../http-tool-filter.js");
    const fakeServer = {} as unknown as import(
      "@modelcontextprotocol/sdk/server/mcp.js"
    ).McpServer;
    expect(() => listHttpToolNames(fakeServer)).toThrow(
      /_registeredTools registry not found/
    );
  });

  it("denylist + wrapHandler still apply after creation (Wave 1 contract preserved)", async () => {
    const { createHttpMcpServer, listHttpToolNames } = await import(
      "../http-tool-filter.js"
    );
    const server = createHttpMcpServer(makeClientStub());
    const names = listHttpToolNames(server);
    for (const denied of [
      "gemini_review",
      "gemini_search",
    ]) {
      expect(names, `${denied} should be denied`).not.toContain(denied);
    }
    expect(names).toContain("discord_send_message");
    expect(names).toContain("discord_webhook_send");
  });
});
