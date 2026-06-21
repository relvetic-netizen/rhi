#!/usr/bin/env node
// W2-S4 hardening smoke: extends the Sprint-1 smoke with the 8 P2 items —
// Host-header normalisation, slow-loris guard, rate-limit 429+Retry-After,
// timeouts on the http.Server instance, denylist surface.
// Uses a fake Discord client so it can run with no live token.
//
// Note: WHATWG fetch() treats Host as a forbidden header and silently strips
// it, so we use node:http for Host-header probes instead.

import { createRequire } from "node:module";
import net from "node:net";
import http from "node:http";
const require = createRequire(import.meta.url);

process.env.DISCORD_BOT_TOKEN ??= "ci-dummy-token";
process.env.MCP_HTTP_ENABLE = "true";
process.env.MCP_API_KEY ??= "w2s4-smoke-key";
process.env.MCP_BIND ??= "127.0.0.1";
process.env.MCP_HTTP_PORT ??= "0"; // ephemeral; don't fight other smokes
process.env.ALLOWED_WORKING_DIRS ??= process.cwd();

const { createHttpMcpServer } = require("../dist/mcp/http-tool-filter.js");
const {
  startHttpMcpServer,
  _resetRateLimitForTest,
} = require("../dist/mcp/http-transport.js");

const fakeClient = {
  user: { id: "stub", tag: "stub#0000" },
  isReady: () => false,
  guilds: { cache: new Map(), fetch: async () => new Map() },
  application: { fetch: async () => ({}) },
  destroy: () => {},
};

const server = createHttpMcpServer(fakeClient);
const handle = await startHttpMcpServer(server, {
  isClientReady: () => false,
});
const port = handle.address()?.port;
const base = `http://127.0.0.1:${port}`;
const key = process.env.MCP_API_KEY;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

function rawRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...opts }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function postJsonRpc(headers, body) {
  return rawRequest(
    {
      method: "POST",
      path: "/mcp",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    },
    JSON.stringify(body)
  );
}

function parseSseOrJson(text) {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  for (const line of t.split(/\n/)) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error("unparseable: " + t.slice(0, 200));
}

console.log(`smoke[W2-S4]: bound to ${base}`);

// 1. tools/list returns 38 tools (43 - 5 denylisted)
{
  _resetRateLimitForTest();
  const r = await postJsonRpc({ Authorization: `Bearer ${key}` }, {
    jsonrpc: "2.0", method: "tools/list", id: 1,
  });
  const parsed = parseSseOrJson(r.body);
  const tools = parsed?.result?.tools ?? [];
  record("tools/list returns 38 tools", r.status === 200 && tools.length === 38, `status=${r.status} count=${tools.length}`);
}

// 2. /health 200 with clientReady=false
{
  const r = await rawRequest({ method: "GET", path: "/health" });
  let ready = null;
  try { ready = JSON.parse(r.body).clientReady; } catch {}
  record("/health 200 + clientReady false", r.status === 200 && ready === false, `status=${r.status} clientReady=${ready}`);
}

// 3. POST /mcp with bad bearer → 401
{
  _resetRateLimitForTest();
  const r = await postJsonRpc({ Authorization: "Bearer wrong-key" }, {
    jsonrpc: "2.0", method: "tools/list", id: 2,
  });
  record("bad bearer → 401", r.status === 401, `status=${r.status}`);
}

// 4. bad Host → 421 (raw http.request allows Host override; fetch does not)
{
  const r = await rawRequest({ method: "GET", path: "/health", headers: { Host: "evil.com" } });
  record("bad Host → 421", r.status === 421, `status=${r.status}`);
}

// 5. Host normalisation (trailing dot + uppercase) → 200
{
  const r = await rawRequest({ method: "GET", path: "/health", headers: { Host: "LOCALHOST." } });
  record("Host=LOCALHOST. normalised → 200", r.status === 200, `status=${r.status}`);
}

// 6. Host smuggling (comma-joined) → 421
{
  const r = await rawRequest({ method: "GET", path: "/health", headers: { Host: "localhost,evil.com" } });
  record("Host=localhost,evil.com smuggled → 421", r.status === 421, `status=${r.status}`);
}

// 7. Auth failure 5 連 + 6 回目 429 + Retry-After: 60
{
  _resetRateLimitForTest();
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const r = await postJsonRpc({ Authorization: "Bearer wrong-key" }, {
      jsonrpc: "2.0", method: "tools/list", id: 100 + i,
    });
    codes.push(r.status);
  }
  const limited = await postJsonRpc({ Authorization: "Bearer wrong-key" }, {
    jsonrpc: "2.0", method: "tools/list", id: 999,
  });
  const ra = limited.headers["retry-after"];
  record(
    "5 fail then 429 + Retry-After:60",
    codes.every((c) => c === 401) && limited.status === 429 && ra === "60",
    `codes=[${codes.join(",")}] limited=${limited.status} retry-after=${ra}`
  );
}

// 8. Slow-loris: open raw socket, write headers, never write body, expect
//    server to close within the 5s body-read deadline AND send a 408 status
//    before tearing the socket. Reset rate-limit so the request reaches the
//    body-cap layer rather than being short-circuited at the rate limiter.
{
  _resetRateLimitForTest();
  const sock = net.connect({ host: "127.0.0.1", port });
  const start = Date.now();
  // Construct the promise (sync listener attach) first, then write, then
  // await — otherwise the await would wait forever for a request that was
  // never sent.
  const resultP = new Promise((resolve) => {
    const chunks = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("close", () => resolve({ elapsed: Date.now() - start, received: Buffer.concat(chunks).toString("utf-8") }));
    sock.on("error", () => { /* expected: remote destroy */ });
    setTimeout(() => resolve({ elapsed: -1, received: "" }), 15_000).unref();
  });
  sock.write(
    [
      "POST /mcp HTTP/1.1",
      "Host: localhost",
      `Authorization: Bearer ${key}`,
      "Content-Type: application/json",
      "Content-Length: 100",
      "",
      "",
    ].join("\r\n")
  );
  const { elapsed, received } = await resultP;
  const got408 = /HTTP\/1\.1 408/.test(received);
  record(
    "slow-loris closed by body-read deadline (~5s, <8s) with 408",
    elapsed > 4_000 && elapsed < 8_000 && got408,
    `elapsed=${elapsed}ms got408=${got408}`
  );
}

await handle.close();
const failed = results.filter((r) => !r.ok);
console.log(`smoke[W2-S4]: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
