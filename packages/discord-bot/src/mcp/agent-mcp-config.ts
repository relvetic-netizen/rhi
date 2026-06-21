import path from "path";

/**
 * Returns MCP server config for Agent SDK.
 * Uses the existing mcp-standalone.js as a stdio subprocess.
 */
export function getMcpServerConfig(): Record<string, any> {
  const distDir = path.resolve(__dirname, "..");
  return {
    "discord-bot": {
      type: "stdio",
      command: "node",
      args: [path.join(distDir, "mcp-standalone.js")],
      env: {
        DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || "",
        MCP_ALLOWED_GUILD_IDS: process.env.MCP_ALLOWED_GUILD_IDS || "",
        GEMINI_CLI_PATH: process.env.GEMINI_CLI_PATH || "",
        GEMINI_MODEL: process.env.GEMINI_MODEL || "",
        CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH || "",
      },
    },
  };
}
