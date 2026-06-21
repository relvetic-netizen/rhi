import { z } from "zod";
import { spawn } from "child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { safeTool } from "../server.js";
import { config } from "../../config.js";

/** Filter env to only pass Google/Gemini auth-related vars */
function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (
      val !== undefined &&
      (key.startsWith("GOOGLE_") ||
        key.startsWith("GEMINI_") ||
        key === "HOME" ||
        key === "USERPROFILE" ||
        key === "PATH" ||
        key === "APPDATA" ||
        key === "XDG_CONFIG_HOME")
    ) {
      env[key] = val;
    }
  }
  return env;
}

interface GeminiResult {
  text: string;
  durationMs: number;
  isError: boolean;
}

async function runGeminiCli(
  prompt: string,
  opts: { yolo: boolean; timeoutMs?: number; cwd?: string }
): Promise<GeminiResult> {
  const start = Date.now();
  const args: string[] = [];

  if (opts.yolo) args.push("--yolo");
  args.push("--model", config.geminiModel);
  args.push("--output-format", "json");

  const timeout = opts.timeoutMs ?? config.geminiTimeoutMs;

  return new Promise<GeminiResult>((resolve) => {
    const proc = spawn(config.geminiCliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: safeEnv(),
      shell: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, timeout);

    const MAX_BUFFER = 10 * 1024 * 1024; // 10MB
    let stdoutSize = 0;
    let stderrSize = 0;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_BUFFER) {
        proc.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_BUFFER) {
        proc.kill("SIGTERM");
        return;
      }
      stderr.push(chunk);
    });

    // Pipe prompt via stdin then close
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      const raw = Buffer.concat(stdout).toString("utf-8").trim();

      if (killed) {
        resolve({
          text: `Gemini CLI timed out after ${timeout / 1000}s`,
          durationMs,
          isError: true,
        });
        return;
      }

      if (code !== 0) {
        const errMsg = Buffer.concat(stderr).toString("utf-8").trim();
        resolve({
          text: `Gemini CLI exited with code ${code}: ${errMsg || raw}`.slice(
            0,
            2000
          ),
          durationMs,
          isError: true,
        });
        return;
      }

      // Try parsing JSON response, fall back to raw stdout
      try {
        const parsed = JSON.parse(raw);
        const text =
          parsed.response ?? parsed.text ?? parsed.content ?? raw;
        resolve({ text: String(text), durationMs, isError: false });
      } catch {
        // Raw text output — still usable
        resolve({ text: raw || "(empty response)", durationMs, isError: false });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        text: `Failed to spawn Gemini CLI: ${err.message}`,
        durationMs: Date.now() - start,
        isError: true,
      });
    });
  });
}

export function registerGeminiTools(server: McpServer): void {
  safeTool(
    server,
    "gemini_query",
    "Send a text query to Gemini 3.1 Pro. Best for: analysis, summarization, translation, abstract reasoning, scientific questions. No tool access (read-only).",
    {
      prompt: z.string().describe("The prompt to send to Gemini"),
      context: z
        .string()
        .optional()
        .describe("Additional context to prepend to the prompt"),
    },
    async ({ prompt, context }) => {
      const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;
      const result = await runGeminiCli(fullPrompt, { yolo: false });
      const suffix = `\n\n---\n_Gemini ${config.geminiModel} | ${(result.durationMs / 1000).toFixed(1)}s_`;
      if (result.isError) throw new Error(result.text);
      return result.text + suffix;
    }
  );

  safeTool(
    server,
    "gemini_review",
    "Delegate a code review to Gemini 3.1 Pro with --yolo mode (Gemini can read files, run git commands, grep). Best for: code review, architecture analysis, git diff review.",
    {
      prompt: z
        .string()
        .describe(
          "Review instructions (e.g. 'Review the latest git diff for bugs and style issues')"
        ),
      cwd: z
        .string()
        .optional()
        .describe("Working directory for Gemini (defaults to project root)"),
    },
    async ({ prompt, cwd }) => {
      const result = await runGeminiCli(prompt, {
        yolo: true,
        timeoutMs: 300_000, // 5 min for agent tasks
        cwd,
      });
      const suffix = `\n\n---\n_Gemini ${config.geminiModel} --yolo | ${(result.durationMs / 1000).toFixed(1)}s_`;
      if (result.isError) throw new Error(result.text);
      return result.text + suffix;
    }
  );

  safeTool(
    server,
    "gemini_search",
    "Delegate a web research task to Gemini 3.1 Pro with --yolo mode (Gemini can use google_web_search). Best for: researching APIs, libraries, best practices, current events.",
    {
      prompt: z
        .string()
        .describe(
          "Research query (e.g. 'Search for the latest Next.js 15 migration guide')"
        ),
    },
    async ({ prompt }) => {
      const result = await runGeminiCli(prompt, {
        yolo: true,
        timeoutMs: 300_000,
      });
      const suffix = `\n\n---\n_Gemini ${config.geminiModel} --yolo | ${(result.durationMs / 1000).toFixed(1)}s_`;
      if (result.isError) throw new Error(result.text);
      return result.text + suffix;
    }
  );
}
