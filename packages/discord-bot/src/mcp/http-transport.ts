import http from "node:http";
import type { IncomingMessage, ServerResponse, Server as HttpServer } from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "../config.js";
import { createLogger, getErrorMessage } from "../logger.js";
import { listHttpToolNames } from "./http-tool-filter.js";

const logger = createLogger("mcp-http");

const MAX_BODY_BYTES = 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_FAILURES = 5;
const RATE_SWEEP_INTERVAL_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const BODY_READ_DEADLINE_MS = 5_000;

interface ServerHandle {
  httpServer: HttpServer;
  close: () => Promise<void>;
  /** Exposed for testability (ephemeral port discovery). */
  address: () => { port: number; address: string } | null;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

function readPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PKG_VERSION = readPackageVersion();
const START_TS = Date.now();

function clientIp(req: IncomingMessage): string {
  const sock = req.socket;
  return sock?.remoteAddress ?? "unknown";
}

/**
 * Extract the host (without port) from a Host header, normalised for comparison:
 * - lowercased
 * - trailing dot stripped (DNS canonical "localhost.")
 * - IPv6 bracket form unwrapped ("[::1]:7800" -> "::1")
 * - returns "" for header values that smell like header smuggling
 *   (comma- or whitespace-joined hosts via a misconfigured proxy)
 */
function hostFromHeader(req: IncomingMessage): string {
  const raw = req.headers["host"];
  if (!raw || Array.isArray(raw)) return "";
  // Reject smuggling attempts: a single Host header MUST have one value.
  if (/[,\s]/.test(raw)) return "";

  let host: string;
  if (raw.startsWith("[")) {
    // IPv6: "[::1]" or "[::1]:7800"
    const end = raw.indexOf("]");
    if (end < 0) return "";
    host = raw.slice(1, end);
  } else {
    host = raw.split(":")[0] ?? "";
  }

  host = host.toLowerCase();
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  return host;
}

function isHostAllowed(req: IncomingMessage): boolean {
  const host = hostFromHeader(req);
  if (!host) return false;
  return config.mcpAllowedHosts.some((h) => {
    const normalised = h.toLowerCase().replace(/\.$/, "");
    return normalised === host;
  });
}

function timingSafeEqualStr(provided: string, expected: string): boolean {
  // Always compare against a fixed-length digest so length mismatch doesn't leak via timing.
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth || Array.isArray(auth)) return null;
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function keyFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    // Lazy evict: drop the stale entry before re-creating, so callers that
    // never auth-fail again don't leave a permanent bucket behind.
    if (bucket) rateBuckets.delete(ip);
    rateBuckets.set(ip, { count: 0, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  return bucket.count < RATE_MAX_FAILURES;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    if (bucket) rateBuckets.delete(ip);
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  bucket.count++;
}

/**
 * Periodic sweep across all rate-limit buckets to clear expired entries.
 * Without this, an attacker probing a rotating IP pool would leak a bucket
 * per IP forever even after the window expired. `unref()` so the interval
 * never keeps the process alive on its own.
 */
function sweepRateBuckets(now = Date.now()): void {
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}

/** For tests. */
export function _resetRateLimitForTest(): void {
  rateBuckets.clear();
}

/** For tests: run a sweep at an arbitrary clock value (avoids needing fake intervals). */
export function _sweepRateLimitForTest(now?: number): void {
  sweepRateBuckets(now);
}

/** For tests: introspect bucket count without exporting the Map directly. */
export function _rateLimitBucketCountForTest(): number {
  return rateBuckets.size;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  res.writeHead(status, { "Content-Type": "application/json", ...(headers ?? {}) });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string, headers?: Record<string, string>): void {
  // Connection: close so non-200 rejects (401/413/421/429/404) don't keep the keepalive
  // socket alive across graceful-shutdown windows or test teardown.
  const close = status >= 400;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...(close ? { Connection: "close" } : {}),
    ...(headers ?? {}),
  });
  res.end(text);
}

function logAuthFailure(req: IncomingMessage, reason: string): void {
  logger.warn("auth failure", {
    ip: clientIp(req),
    path: req.url ?? "",
    ua: req.headers["user-agent"] ?? "",
    reason,
    // NEVER include req.headers.authorization — redacted by omission.
  });
}

function readBodyWithCap(req: IncomingMessage): Promise<{ ok: true; body: Buffer } | { ok: false; status: number; text: string }> {
  return new Promise((resolve) => {
    const declared = req.headers["content-length"];
    if (declared && Number(declared) > MAX_BODY_BYTES) {
      // Reject by Content-Length before any bytes are read.
      resolve({ ok: false, status: 413, text: "Payload Too Large" });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;

    // Slow-loris guard at the body layer: even if the client trickles bytes
    // under the per-chunk timeout that Node's HTTP parser enforces, the
    // *whole body* must arrive within this deadline. Defer the socket
    // destroy via setImmediate so the resolved promise's `.then` microtask
    // can flush the 408 + `Connection: close` response before the socket
    // disappears underneath it — otherwise the client only ever sees an RST.
    const deadline = setTimeout(() => {
      if (aborted) return;
      aborted = true;
      finish({ ok: false, status: 408, text: "Request Timeout" });
      setImmediate(() => req.destroy());
    }, BODY_READ_DEADLINE_MS);
    deadline.unref?.();

    const finish = (result: { ok: true; body: Buffer } | { ok: false; status: number; text: string }) => {
      clearTimeout(deadline);
      resolve(result);
    };

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        aborted = true;
        finish({ ok: false, status: 413, text: "Payload Too Large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      finish({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      finish({ ok: false, status: 400, text: `Bad Request: ${getErrorMessage(err)}` });
    });
  });
}

interface HealthSnapshot {
  status: "ok";
  uptime: number;
  version: string;
  toolCount: number;
  clientReady: boolean;
}

function buildHealth(server: McpServer, isClientReady: () => boolean): HealthSnapshot {
  return {
    status: "ok",
    uptime: Math.floor((Date.now() - START_TS) / 1000),
    version: PKG_VERSION,
    toolCount: listHttpToolNames(server).length,
    clientReady: isClientReady(),
  };
}

async function handleMcpRequest(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch (err) {
    sendJson(res, 400, { error: `Invalid JSON: ${getErrorMessage(err)}` });
    return;
  }

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (err) {
    logger.error("mcp request failed", { error: getErrorMessage(err) });
    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal Server Error" });
    } else {
      res.end();
    }
  }
}

export interface StartHttpMcpServerOptions {
  /** Defaults to `config.mcpHttpPort`. Pass 0 for ephemeral (tests). */
  port?: number;
  /** Defaults to `config.mcpBind`. */
  host?: string;
  /** Override the API key (tests). */
  apiKey?: string;
  /** Client-ready predicate for `/health`. */
  isClientReady?: () => boolean;
}

export function startHttpMcpServer(
  server: McpServer,
  options: StartHttpMcpServerOptions = {}
): Promise<ServerHandle> {
  const port = options.port ?? config.mcpHttpPort;
  const host = options.host ?? config.mcpBind;
  const apiKey = options.apiKey ?? config.mcpApiKey;
  const isClientReady = options.isClientReady ?? (() => true);

  if (!apiKey) {
    return Promise.reject(new Error("MCP_API_KEY is required when MCP_HTTP_ENABLE=true"));
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    // 1) Host header check (DNS rebinding).
    if (!isHostAllowed(req)) {
      logger.warn("host header rejected", { ip: clientIp(req), host: req.headers["host"] ?? "" });
      sendText(res, 421, "Misdirected Request");
      return;
    }

    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // 2) /health (no auth).
    if (method === "GET" && url === "/health") {
      sendJson(res, 200, buildHealth(server, isClientReady));
      return;
    }

    // 3) Only POST /mcp from here on.
    if (!(method === "POST" && url === "/mcp")) {
      sendText(res, 404, "Not Found");
      return;
    }

    const ip = clientIp(req);

    // 4) Rate limit on auth failures.
    if (!checkRateLimit(ip)) {
      logAuthFailure(req, "rate_limited");
      sendText(res, 429, "Too Many Requests", { "Retry-After": "60" });
      return;
    }

    // 5) Bearer token check (timing-safe).
    const provided = bearerToken(req);
    if (!provided || !timingSafeEqualStr(provided, apiKey)) {
      recordAuthFailure(ip);
      logAuthFailure(req, provided ? "bad_key" : "missing_bearer");
      sendText(res, 401, "Unauthorized", { "WWW-Authenticate": 'Bearer realm="mcp"' });
      return;
    }

    // 6) Body size cap then forward.
    void readBodyWithCap(req).then(async (result) => {
      if (!result.ok) {
        sendText(res, result.status, result.text);
        return;
      }
      logger.info("mcp request", {
        ip,
        path: url,
        fingerprint: keyFingerprint(provided),
      });
      await handleMcpRequest(server, req, res, result.body);
    });
  };

  const httpServer = http.createServer(handle);

  // Slow-loris hardening: shrink both knobs from Node defaults (300s / 60s).
  // headersTimeout MUST be <= requestTimeout per Node's invariant.
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;

  // Periodic sweep so a rotating-IP attacker can't leak buckets forever.
  const sweepTimer = setInterval(() => sweepRateBuckets(), RATE_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return new Promise<ServerHandle>((resolve, reject) => {
    let settled = false;
    httpServer.once("error", (err) => {
      if (settled) return;
      settled = true;
      // The sweep timer is created before listen() resolves; if listen
      // fails (port in use, EACCES) we must clear it here, otherwise the
      // process leaks a 60s interval even though the server never bound.
      clearInterval(sweepTimer);
      reject(err);
    });
    httpServer.listen(port, host, () => {
      if (settled) return;
      settled = true;
      const addr = httpServer.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      logger.info("HTTP MCP listening", { host, port: boundPort });
      resolve({
        httpServer,
        address: () => {
          const a = httpServer.address();
          if (typeof a === "object" && a) return { port: a.port, address: a.address };
          return null;
        },
        close: () => {
          clearInterval(sweepTimer);
          return closeWithTimeout(httpServer);
        },
      });
    });
  });
}

function closeWithTimeout(httpServer: HttpServer): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn("HTTP MCP close timeout; forcing close", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      try {
        httpServer.closeAllConnections?.();
      } catch {
        // ignore — best-effort
      }
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
    httpServer.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}
