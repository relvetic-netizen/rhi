#!/usr/bin/env node
// Sprint-1 smoke runner: starts the HTTP MCP transport against a fake Discord
// client and exercises tools/list + /health + 401. Bypasses real bot login so
// the smoke is reproducible with no live token. Output goes to stdout.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

process.env.DISCORD_BOT_TOKEN ??= "ci-dummy-token";
process.env.MCP_HTTP_ENABLE = "true";
process.env.MCP_API_KEY ??= "smoke-key-" + Math.random().toString(36).slice(2, 8);
process.env.MCP_BIND ??= "127.0.0.1";
process.env.MCP_HTTP_PORT ??= "17800";
process.env.ALLOWED_WORKING_DIRS ??= process.cwd();

const { createHttpMcpServer } = require("../dist/mcp/http-tool-filter.js");
const { startHttpMcpServer } = require("../dist/mcp/http-transport.js");

const fakeClient = {
  user: { id: "stub", tag: "stub#0000" },
  isReady: () => false,
  guilds: { cache: new Map(), fetch: async () => new Map() },
  application: { fetch: async () => ({}) },
  destroy: () => {},
};

const server = createHttpMcpServer(fakeClient);
const handle = await startHttpMcpServer(server, {
  isClientReady: () => fakeClient.isReady(),
});

const port = handle.address()?.port ?? Number(process.env.MCP_HTTP_PORT);
const base = `http://127.0.0.1:${port}`;
const key = process.env.MCP_API_KEY;

async function jsonRpc(headers, body) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

console.log(`smoke: bound to ${base}`);

const list = await jsonRpc({ Authorization: `Bearer ${key}` }, {
  jsonrpc: "2.0", method: "tools/list", id: 1,
});
console.log(`--- tools/list (auth) status=${list.status} ---`);
console.log(list.body.slice(0, 4000));

const health = await fetch(`${base}/health`).then(async (r) => ({
  status: r.status, body: await r.text(),
}));
console.log(`--- /health status=${health.status} ---`);
console.log(health.body);

const noauth = await jsonRpc({}, { jsonrpc: "2.0", method: "tools/list", id: 2 });
console.log(`--- POST /mcp no-auth status=${noauth.status} ---`);
console.log(noauth.body);

await handle.close();
console.log("smoke: server closed");
process.exit(0);
