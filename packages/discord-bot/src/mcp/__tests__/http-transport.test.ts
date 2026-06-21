import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import http from "node:http";
import net from "node:net";

// Make sure module-load `requireEnv("DISCORD_BOT_TOKEN")` in src/config.ts succeeds.
process.env.DISCORD_BOT_TOKEN ??= "ci-dummy-token";
// HTTP MCP env is set per-test; ensure module-load IIFE doesn't require MCP_API_KEY here.
process.env.MCP_HTTP_ENABLE = "false";

const attachmentSpy = vi.hoisted(() => vi.fn());

vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    AttachmentBuilder: class {
      constructor(...args: unknown[]) {
        attachmentSpy(...args);
      }
    },
  };
});

const VALID_KEY = "test-api-key-12345";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: http.RequestOptions,
  body?: string | Buffer
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        ...options,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function makeClientStub(): import("discord.js").Client {
  // Minimal stub. tools/list registration does not call client methods; the
  // path-traversal test relies on the guard throwing BEFORE any client call.
  const stub = {
    user: { id: "stub-bot", tag: "stub#0000" },
    isReady: () => true,
    guilds: { cache: new Map(), fetch: vi.fn() },
    application: { fetch: vi.fn() },
    destroy: vi.fn(),
  };
  return stub as unknown as import("discord.js").Client;
}

let stderrWrites: string[] = [];
let originalStderrWrite: typeof process.stderr.write;

beforeAll(() => {
  originalStderrWrite = process.stderr.write.bind(process.stderr);
});

beforeEach(async () => {
  stderrWrites = [];
  // Capture only — still pass through to keep test output readable on failure.
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") stderrWrites.push(chunk);
    else stderrWrites.push(Buffer.from(chunk).toString("utf-8"));
    return originalStderrWrite(chunk as string, ...(rest as []));
  }) as typeof process.stderr.write;
  attachmentSpy.mockReset();
  const { _resetRateLimitForTest } = await import("../http-transport.js");
  _resetRateLimitForTest();
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

async function startServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const { createHttpMcpServer } = await import("../http-tool-filter.js");
  const { startHttpMcpServer } = await import("../http-transport.js");
  const server = createHttpMcpServer(makeClientStub());
  const handle = await startHttpMcpServer(server, {
    port: 0,
    host: "127.0.0.1",
    apiKey: VALID_KEY,
    isClientReady: () => true,
  });
  const addr = handle.address();
  if (!addr) throw new Error("server has no address after listen");
  return { port: addr.port, close: handle.close };
}

describe("HTTP MCP transport", () => {
  it("t1: unknown path returns 404", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(port, { method: "GET", path: "/unknown" });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("t2: POST /mcp without auth returns 401 + WWW-Authenticate + no key leaked in log", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: { "Content-Type": "application/json" },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
      const joinedLogs = stderrWrites.join("");
      expect(joinedLogs).toContain("auth failure");
      expect(joinedLogs).not.toContain("Authorization");
      expect(joinedLogs).not.toContain(VALID_KEY);
    } finally {
      await close();
    }
  });

  it("t3: POST /mcp with wrong key returns 401", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-key",
          },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(res.status).toBe(401);
      const joinedLogs = stderrWrites.join("");
      expect(joinedLogs).not.toContain("wrong-key");
    } finally {
      await close();
    }
  });

  it("t4: tools/list with valid key returns tool array including discord_send_message", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(res.status).toBe(200);
      const parsed = parseMaybeSseJson(res.body) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const tools = parsed.result?.tools ?? [];
      expect(tools.length).toBeGreaterThanOrEqual(5);
      const names = tools.map((t) => t.name);
      expect(names).toContain("discord_send_message");
    } finally {
      await close();
    }
  });

  it("t5: denylisted tools (gemini_review) are absent from tools/list", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(res.status).toBe(200);
      const parsed = parseMaybeSseJson(res.body) as {
        result?: { tools?: Array<{ name: string }> };
      };
      const names = (parsed.result?.tools ?? []).map((t) => t.name);
      for (const denied of [
        "gemini_review",
        "gemini_search",
      ]) {
        expect(names, `tool ${denied} should be denied`).not.toContain(denied);
      }
    } finally {
      await close();
    }
  });

  it("t6: GET /health returns 200 with status ok (no auth required)", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(port, { method: "GET", path: "/health" });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        status: string;
        clientReady: boolean;
        uptime: number;
        toolCount: number;
      };
      expect(body.status).toBe("ok");
      expect(typeof body.clientReady).toBe("boolean");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.toolCount).toBeGreaterThanOrEqual(5);
    } finally {
      await close();
    }
  });

  it("t7: bad Host header returns 421", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(port, {
        method: "GET",
        path: "/health",
        headers: { Host: "evil.com" },
      });
      expect(res.status).toBe(421);
    } finally {
      await close();
    }
  });

  it("t7a: Host header trailing-dot + uppercase is accepted (normalisation)", async () => {
    // Before Item 1: strict-equality match would reject "LOCALHOST." even though
    // it is the DNS-canonical form of "localhost".
    const { port, close } = await startServer();
    try {
      const res = await request(port, {
        method: "GET",
        path: "/health",
        headers: { Host: "LOCALHOST." },
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("t7b: comma-joined Host header is rejected as smuggling (421)", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(port, {
        method: "GET",
        path: "/health",
        headers: { Host: "localhost,evil.com" },
      });
      expect(res.status).toBe(421);
    } finally {
      await close();
    }
  });

  it("t7c: IPv6-bracket Host header is unwrapped before allowlist check", async () => {
    // Bracket form "[127.0.0.1]:PORT" wraps an IP literal per RFC 3986; even
    // though the default allowlist stores it bracket-less, the normaliser
    // should peel the brackets so the match succeeds.
    const { port, close } = await startServer();
    try {
      const res = await request(port, {
        method: "GET",
        path: "/health",
        headers: { Host: `[127.0.0.1]:${port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("t8: oversized body (Content-Length >1MB) returns 413", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(2 * 1024 * 1024),
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        // We don't actually send 2MB — Content-Length declaration alone triggers reject.
        "{}"
      );
      expect(res.status).toBe(413);
    } finally {
      await close();
    }
  });

  it("t8a: body of exactly 1MB passes the HTTP gate (not 413)", async () => {
    const { port, close } = await startServer();
    try {
      // The HTTP-layer body cap is what we're guarding here. Build a JSON
      // payload that lands at exactly 1024*1024 bytes; what MCP/SDK does with
      // it past the gate is out of scope for the body-cap contract.
      const skeleton = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
      const overhead = ',"_pad":""'.length;
      const pad = 1024 * 1024 - skeleton.length - overhead;
      const body = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 1,
        _pad: " ".repeat(Math.max(0, pad)),
      });
      expect(body.length).toBe(1024 * 1024);
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": String(body.length),
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        body
      );
      // Boundary: the HTTP body cap MUST NOT reject at exactly MAX_BODY_BYTES.
      // SDK-side handling (200 success or 4xx parser/method error) is fine.
      expect(res.status).not.toBe(413);
    } finally {
      await close();
    }
  });

  it("t8b: body of 1MB+1 byte is rejected with 413", async () => {
    const { port, close } = await startServer();
    try {
      const body = "x".repeat(1024 * 1024 + 1);
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(body.length),
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        body
      );
      expect(res.status).toBe(413);
    } finally {
      await close();
    }
  });

  it("t8c: empty body (0 bytes) is accepted by the gate but parser returns 400 Invalid JSON", async () => {
    // 0 bytes is below the cap and below all rate-limit gates — it should reach
    // the JSON parser, which rejects empty input. This documents the contract
    // boundary so that switching the gate to reject 0 bytes here would surface.
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "0",
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        ""
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatch(/Invalid JSON/);
    } finally {
      await close();
    }
  });

  it("t12: 5 wrong-key requests succeed-with-401, 6th returns 429 + Retry-After:60", async () => {
    const { port, close } = await startServer();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await request(
          port,
          {
            method: "POST",
            path: "/mcp",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer wrong-key",
            },
          },
          JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
        );
        expect(res.status, `request ${i + 1} should still be 401`).toBe(401);
      }
      const limited = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-key",
          },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");

      // After clearing the bucket (representing window expiry) the cycle resets
      // and the next request is back to 401 rather than staying rate-limited.
      const { _resetRateLimitForTest } = await import("../http-transport.js");
      _resetRateLimitForTest();
      const recovered = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer wrong-key",
          },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(recovered.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("t13: rate-limit buckets are eviction-bounded after periodic sweep", async () => {
    // Without sweep, every distinct IP that auth-fails would leak a Map entry
    // forever. Item 2 adds a periodic sweep + lazy evict; this test simulates
    // the sweep at a future timestamp and asserts the Map drains.
    const { port, close } = await startServer();
    const { _resetRateLimitForTest, _sweepRateLimitForTest, _rateLimitBucketCountForTest } =
      await import("../http-transport.js");
    _resetRateLimitForTest();
    try {
      // Force-record auth failures from many distinct IPs by issuing wrong-key
      // requests; each request's source IP is the loopback, so we can't get
      // distinct IPs over real sockets. Instead exercise the recorder via the
      // public surface using the same IP (count grows) and verify the sweep
      // removes the entry after the window expires.
      const wrong = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
        },
        JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 })
      );
      expect(wrong.status).toBe(401);
      expect(_rateLimitBucketCountForTest()).toBe(1);

      _sweepRateLimitForTest(Date.now() + 60_001);
      expect(_rateLimitBucketCountForTest()).toBe(0);
    } finally {
      await close();
    }
  });

  it("t14: requestTimeout / headersTimeout are tightened below Node defaults", async () => {
    const { startHttpMcpServer } = await import("../http-transport.js");
    const { createHttpMcpServer } = await import("../http-tool-filter.js");
    const probeServer = createHttpMcpServer(makeClientStub());
    const handle = (await startHttpMcpServer(probeServer, {
      port: 0,
      host: "127.0.0.1",
      apiKey: VALID_KEY,
      isClientReady: () => true,
    })) as unknown as { httpServer: http.Server; close: () => Promise<void> };
    try {
      // Guard against a future ServerHandle shape change that drops `httpServer`:
      // without this, the property reads below would silently see `undefined`
      // and the assertions would throw instead of failing assertively.
      expect(handle.httpServer).toBeDefined();
      expect(handle.httpServer.requestTimeout).toBe(15_000);
      expect(handle.httpServer.headersTimeout).toBe(10_000);
      // Defaults in Node 18+: requestTimeout=300_000, headersTimeout=60_000.
      expect(handle.httpServer.requestTimeout).toBeLessThan(300_000);
      expect(handle.httpServer.headersTimeout).toBeLessThan(60_000);
    } finally {
      await handle.close();
    }
  });

  it("t15: body-read deadline aborts a slow-loris connection at ~5s with a 408 response", async () => {
    // Slow-loris: client sends valid headers declaring Content-Length but never
    // writes the body. The body-read deadline (5s) must close the connection
    // even though node:http would otherwise hold it for requestTimeout (15s).
    // We assert BOTH the timing window (4-8s, i.e. the body deadline, not the
    // requestTimeout fallback) AND that the client sees a 408 status line —
    // a pure RST would mean the deadline destroyed the socket before the
    // response could flush, which is the regression we want to catch.
    const { port, close } = await startServer();
    try {
      const socket = net.connect({ host: "127.0.0.1", port });
      const startedAt = Date.now();
      // Construct the Promise (which synchronously attaches listeners) FIRST,
      // then write the request, then await — otherwise the await blocks
      // forever waiting for a request that was never sent.
      const resultP = new Promise<{ elapsed: number; received: string }>((resolve) => {
        const chunks: Buffer[] = [];
        socket.on("data", (c: Buffer) => chunks.push(c));
        socket.on("close", () => {
          resolve({
            elapsed: Date.now() - startedAt,
            received: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        // Defensive: end the test even if the server holds the socket open.
        setTimeout(() => resolve({ elapsed: -1, received: "" }), 10_000).unref();
      });

      // Valid request line + headers, then DO NOT write any body bytes.
      socket.write(
        [
          "POST /mcp HTTP/1.1",
          "Host: localhost",
          `Authorization: Bearer ${VALID_KEY}`,
          "Content-Type: application/json",
          "Content-Length: 100",
          "",
          "",
        ].join("\r\n")
      );

      const result = await resultP;

      // Must close near the body-read deadline (4-8s), not requestTimeout (15s)
      // or the test guard (10s). The lower bound rules out a fast reject path
      // (e.g. host allowlist mismatch) that would silently mask a regression.
      expect(result.elapsed).toBeGreaterThan(4_000);
      expect(result.elapsed).toBeLessThan(8_000);
      // The server MUST send the 408 status before tearing the socket.
      expect(result.received).toMatch(/HTTP\/1\.1 408/);
    } finally {
      await close();
    }
  }, 20_000);

  it("t16: listen() error releases the rate-limit sweep timer (no leak on EADDRINUSE)", async () => {
    // Bind a blocker so the second listen() attempt fails. Without the fix
    // in startHttpMcpServer's error handler, the sweep setInterval that was
    // created before listen() would survive forever.
    const blocker = http.createServer(() => undefined);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const blockerAddr = blocker.address();
    if (typeof blockerAddr !== "object" || !blockerAddr) throw new Error("no blocker addr");

    const handlesBefore = process.getActiveResourcesInfo?.() ?? [];
    const intervalsBefore = handlesBefore.filter((r) => r === "Timeout").length;

    const { startHttpMcpServer } = await import("../http-transport.js");
    const { createHttpMcpServer } = await import("../http-tool-filter.js");
    const probeServer = createHttpMcpServer(makeClientStub());

    let rejected = false;
    try {
      await startHttpMcpServer(probeServer, {
        port: blockerAddr.port,
        host: "127.0.0.1",
        apiKey: VALID_KEY,
        isClientReady: () => true,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);

    const handlesAfter = process.getActiveResourcesInfo?.() ?? [];
    const intervalsAfter = handlesAfter.filter((r) => r === "Timeout").length;
    // Should not have leaked an extra Timeout.
    expect(intervalsAfter).toBeLessThanOrEqual(intervalsBefore);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it("t9: graceful close completes within 5s with no in-flight connections", async () => {
    const { close } = await startServer();
    const start = Date.now();
    await close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5_000);
  });

  it("t11: discord_webhook_send with non-discord.com URL returns EINVAL (prefix guard)", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
          params: {
            name: "discord_webhook_send",
            arguments: {
              webhook_url: "https://evil.example.com/api/webhooks/xxxx/yyyy",
              content: "x",
            },
          },
        })
      );
      expect(res.status).toBe(200);
      const parsed = parseMaybeSseJson(res.body) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(parsed.result?.isError).toBe(true);
      const text = parsed.result?.content?.[0]?.text ?? "";
      expect(text).toMatch(/EINVAL/);
      expect(text).toMatch(/webhook_url/);
    } finally {
      await close();
    }
  });

  it("t10: discord_send_message with /etc/passwd path returns error, AttachmentBuilder not constructed", async () => {
    const { port, close } = await startServer();
    try {
      const res = await request(
        port,
        {
          method: "POST",
          path: "/mcp",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${VALID_KEY}`,
          },
        },
        JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          id: 1,
          params: {
            name: "discord_send_message",
            arguments: {
              guild_id: "0",
              channel_id: "0",
              content: "x",
              files: ["/etc/passwd"],
            },
          },
        })
      );
      expect(res.status).toBe(200);
      const parsed = parseMaybeSseJson(res.body) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(parsed.result?.isError).toBe(true);
      const text = parsed.result?.content?.[0]?.text ?? "";
      expect(text).toMatch(/EINVAL/);
      expect(attachmentSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});

/** Parse either a plain JSON body or an SSE-framed JSON response (the SDK
 *  may stream JSON-RPC responses via SSE when Accept includes text/event-stream). */
function parseMaybeSseJson(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // SSE frame: lines `data: <json>` separated by \n\n
  for (const block of trimmed.split(/\n\n/)) {
    for (const line of block.split(/\n/)) {
      if (line.startsWith("data:")) {
        const payload = line.slice("data:".length).trim();
        if (payload.startsWith("{") || payload.startsWith("[")) {
          return JSON.parse(payload);
        }
      }
    }
  }
  throw new Error(`Unparseable response body: ${body.slice(0, 200)}`);
}
