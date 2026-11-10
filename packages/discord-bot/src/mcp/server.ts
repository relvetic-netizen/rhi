import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Client } from "discord.js";

import { registerMessageTools } from "./tools/messages.js";
import { registerChannelTools } from "./tools/channels.js";
import { registerGuildTools } from "./tools/guilds.js";
import { getErrorMessage } from "../logger.js";

export function createMcpServer(discordClient: Client): McpServer {
  const server = new McpServer({
    name: "discord-bot",
    version: "1.0.0",
  });

  registerMessageTools(server, discordClient);
  registerChannelTools(server, discordClient);
  registerGuildTools(server, discordClient);

  return server;
}

export async function startMcpTransport(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] MCP server connected via stdio transport");
}

/** Wrapper that catches errors and returns them as MCP text content */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- MCP SDK's server.tool() uses internal generics tied to zod schemas
export function safeTool(
  server: McpServer,
  name: string,
  description: string,
  schema: Record<string, any>,
  handler: (params: any) => Promise<string>
): void {
  server.tool(name, description, schema as any, async (params: any) => {
    try {
      const text = await handler(params);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = getErrorMessage(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });
}
