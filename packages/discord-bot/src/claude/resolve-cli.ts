import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { platform } from "os";

export interface ClaudeInvocation {
  /** Binary to spawn. Absolute path when resolved, bare name when falling through. */
  bin: string;
  /** Args prepended before caller-supplied CLI args (e.g. the JS entrypoint when invoking via node). */
  prefixArgs: string[];
  /** True when spawn() must use `shell:true` — only as a last-resort on Windows when direct resolution fails. */
  useShell: boolean;
}

export interface ResolveOptions {
  /** Override for env CLAUDE_CLI_PATH. Empty string or undefined → fall back to env or "claude". */
  cliPath?: string;
  /** Override for env CLAUDE_CLI_SCRIPT. When set, this path is used verbatim (existence-checked). */
  cliScript?: string;
  /** Inject a custom PATH lookup for tests. Defaults to process.env.PATH. */
  envPath?: string;
  /** Override platform detection for tests. */
  platformOverride?: NodeJS.Platform;
  /** Override the node binary used when invoking a JS entrypoint. Defaults to process.execPath. */
  nodeBin?: string;
}

/**
 * Resolve how to spawn the Claude CLI across package layout versions.
 *
 * Priority:
 *   1. Explicit CLAUDE_CLI_SCRIPT override (path to .exe or .cjs/.js).
 *   2. On Windows, parse the `.cmd` shim on PATH to find the underlying
 *      `bin/claude.exe` (claude-code 2.1.x+) or `cli.js` (legacy), with
 *      fallback to `cli-wrapper.cjs` if the native binary is mid-update.
 *   3. Fall through to the raw bin name (spawned through shell on Windows,
 *      directly on POSIX).
 *
 * Mirrors relvetia-team/scripts/launch-swarm.mjs to keep spawn behavior
 * consistent across the daemon / swarm launcher / discord bot.
 */
export function resolveClaudeInvocation(opts: ResolveOptions = {}): ClaudeInvocation {
  const plat = opts.platformOverride ?? platform();
  const isWindows = plat === "win32";
  const nodeBin = opts.nodeBin ?? process.execPath;

  const rawPath = opts.cliPath || process.env.CLAUDE_CLI_PATH || "claude";
  const script = opts.cliScript ?? process.env.CLAUDE_CLI_SCRIPT ?? "";

  if (script) {
    if (script.toLowerCase().endsWith(".exe")) {
      return { bin: script, prefixArgs: [], useShell: false };
    }
    return { bin: nodeBin, prefixArgs: [script], useShell: false };
  }

  if (isWindows) {
    const direct = resolveWindowsShim(rawPath, nodeBin, opts.envPath);
    if (direct) return direct;
  }

  const bin = isWindows && rawPath.includes("\\") ? rawPath.replace(/\\/g, "/") : rawPath;
  return { bin, prefixArgs: [], useShell: isWindows };
}

function findShimOnPath(bin: string, envPath: string | undefined, plat: NodeJS.Platform): string {
  if (bin.includes("/") || bin.includes("\\")) return bin;
  const sep = plat === "win32" ? ";" : ":";
  const path = envPath ?? process.env.PATH ?? process.env.Path ?? "";
  const exts = plat === "win32" ? [".cmd", ".ps1", ""] : [""];
  for (const dir of path.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return bin;
}

function resolveWindowsShim(
  rawPath: string,
  nodeBin: string,
  envPath: string | undefined
): ClaudeInvocation | null {
  const bin = findShimOnPath(rawPath, envPath, "win32");
  const guessBase = bin.endsWith(".cmd") ? bin.slice(0, -4) : bin;
  const candidates = [`${guessBase}.cmd`, bin];

  for (const shim of candidates) {
    let txt: string;
    try {
      txt = readFileSync(shim, "utf-8");
    } catch {
      continue;
    }
    const shimDir = dirname(shim) + "\\";
    const expand = (p: string) => p.replace(/%~?dp0%\\?/gi, shimDir);

    const exeMatch = txt.match(/["']([^"']*claude\.exe)["']/i);
    if (exeMatch) {
      const exePath = expand(exeMatch[1]);
      if (existsSync(exePath)) {
        return { bin: exePath, prefixArgs: [], useShell: false };
      }
      const pkgDir = dirname(dirname(exePath));
      for (const candidate of ["cli-wrapper.cjs", "cli.js"]) {
        const scriptPath = join(pkgDir, candidate);
        if (existsSync(scriptPath)) {
          return { bin: nodeBin, prefixArgs: [scriptPath], useShell: false };
        }
      }
    }

    const cliMatch = txt.match(/["']([^"']*cli\.js)["']/i);
    if (cliMatch) {
      const scriptPath = expand(cliMatch[1]);
      if (existsSync(scriptPath)) {
        return { bin: nodeBin, prefixArgs: [scriptPath], useShell: false };
      }
    }
  }
  return null;
}
