/**
 * Standalone MCP server entry point (REST API only, no Gateway).
 *
 * Used by Claude CLI sessions (spawned by /code or direct use).
 * Does NOT login to Discord Gateway — uses REST API only via bot token.
 * This avoids the dual-login conflict when the bot is already running.
 */
import "./dns-fix.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// Redirect console.log to stderr (stdout is for MCP protocol)
console.log = (...args: unknown[]) => {
  console.error(...args);
};

import { Client } from "discord.js";
import { createMcpServer, startMcpTransport } from "./mcp/server.js";

// Create a minimal Discord.js client for REST API access only
const client = new Client({ intents: [] });

// Set token for REST API calls without Gateway login
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error("[mcp-standalone] DISCORD_BOT_TOKEN not set in .env");
  process.exit(1);
}
client.token = token;
client.rest.setToken(token);

// Create and start MCP server
const mcpServer = createMcpServer(client);
startMcpTransport(mcpServer).then(() => {
  console.error(
    "[mcp-standalone] Discord MCP server ready (REST-only mode, 25 tools)"
  );
});

process.on("SIGINT", () => {
  console.error("[mcp-standalone] Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("[mcp-standalone] Shutting down...");
  process.exit(0);
});
