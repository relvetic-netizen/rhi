import fs from "node:fs";
import path from "node:path";
import type { Client } from "discord.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "./server.js";
import { config } from "../config.js";
import { createLogger, getErrorMessage } from "../logger.js";

const logger = createLogger("mcp-http-filter");

interface RegisteredToolInternal {
  handler: (...args: unknown[]) => unknown;
  enabled: boolean;
  remove(): void;
}

type ToolRegistry = Record<string, RegisteredToolInternal | undefined>;

function getToolRegistry(server: McpServer): ToolRegistry {
  // SDK 1.29 stores tools in private _registeredTools; no public removal/wrap API exists,
  // so the HTTP-side hardening (denylist + guards) accesses the internal registry directly.
  const internal = (server as unknown as { _registeredTools?: ToolRegistry })._registeredTools;
  if (!internal) {
    throw new Error("MCP SDK internal _registeredTools registry not found; SDK version mismatch?");
  }
  return internal;
}

function isPathInside(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function validateFilesAttachment(files: string[]): void {
  const roots = config.allowedWorkingDirs.map((r) => path.resolve(r));
  if (roots.length === 0) {
    throw new Error("EINVAL: ALLOWED_WORKING_DIRS is empty; HTTP MCP cannot accept file attachments");
  }
  for (const filePath of files) {
    const resolved = path.resolve(filePath);
    let realResolved = resolved;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      // file may not exist yet — fall back to resolved-only check; original handler will surface ENOENT
    }
    const ok = roots.some((root) => isPathInside(resolved, root) && isPathInside(realResolved, root));
    if (!ok) {
      throw new Error(`EINVAL: file path '${filePath}' is outside allowedWorkingDirs`);
    }
  }
}

function validateWebhookUrl(url: string): void {
  if (typeof url !== "string" || !url.startsWith("https://discord.com/api/webhooks/")) {
    throw new Error("EINVAL: webhook_url must start with https://discord.com/api/webhooks/");
  }
}

function asMcpError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [{ type: "text" as const, text: `Error: ${getErrorMessage(err)}` }],
    isError: true,
  };
}

function wrapHandler(
  registry: ToolRegistry,
  toolName: string,
  validate: (params: Record<string, unknown>) => void
): void {
  const tool = registry[toolName];
  if (!tool) {
    // Silent skip would mask a future SDK rename — log so audit catches the drift.
    logger.warn("wrapHandler skipped: tool not in registry", { tool: toolName });
    return;
  }
  const original = tool.handler;
  tool.handler = async (...args: unknown[]) => {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    try {
      validate(params);
    } catch (err) {
      return asMcpError(err);
    }
    return original(...args);
  };
  // Visibility for the case where SDK changes its dispatch off `tool.handler` —
  // if validators silently no-op, this log being absent is a smoking gun.
  logger.info("handler wrapped", { tool: toolName, reason: "http-validator" });
}

export function createHttpMcpServer(client: Client): McpServer {
  const server = createMcpServer(client);
  const registry = getToolRegistry(server);
  const denylist = config.mcpHttpToolDenylist;

  for (const name of denylist) {
    const tool = registry[name];
    if (tool) {
      tool.remove();
      logger.info("tool removed from HTTP surface", { tool: name, reason: "denylist" });
    } else {
      // Misconfigured env (typo / renamed tool) would silently fail to deny — warn.
      logger.warn("denylist entry not in registry", { tool: name });
    }
  }

  wrapHandler(registry, "discord_send_message", (params) => {
    const files = params.files;
    if (Array.isArray(files) && files.length > 0) {
      validateFilesAttachment(files as string[]);
    }
  });

  wrapHandler(registry, "discord_webhook_send", (params) => {
    const url = params.webhook_url;
    if (url !== undefined) validateWebhookUrl(url as string);
  });

  return server;
}

export function listHttpToolNames(server: McpServer): string[] {
  const registry = getToolRegistry(server);
  return Object.keys(registry).filter((n) => registry[n]?.enabled);
}
