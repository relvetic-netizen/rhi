#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { collect } from "./api/collect.js";
import { goto } from "./api/goto.js";
import { listSkills, saveSkill } from "./api/skills.js";
import { clearText, click, clickSelector, press, scroll, type as inputType } from "./api/interact.js";
import { js, pageInfo, screenshot } from "./api/page.js";
import { closeTab, listTabs, newTab, switchTab } from "./api/tabs.js";
import { withLogging } from "./runtime-log.js";
import {
  InvalidHostnameError,
  InvalidSkillNameError,
  PrivatePathLiteralError,
  SaveSkillMode,
  SkillExistsError,
} from "./types.js";

const HELP = `relvetia-browser — domain-skill-aware CDP browser helper

Navigation & info:
  goto <url>                      Navigate and load domain skills
  page-info                       Return viewport/scroll/url/title
  js <expression>                 Evaluate JS, return value as JSON

Interaction:
  click <x> <y>                   Mouse click at coordinates
  click-selector <css>            Click the center of a matching element
  type <text>                     Insert text into focused element
  clear-text [--selector <css>]   Focus (optional) + Ctrl+A → Backspace
  press <key> [--modifiers A,B]   Dispatch key event (e.g. Enter, Tab)
  scroll <dx> <dy>                Scroll window by delta
  collect <selector>              Collect unique selector matches while scrolling
                                  [--target <n>] [--max-scrolls <n>] [--settle <ms>]
                                  [--stable <n>] [--max-text <n>]

Capture:
  screenshot [--path <p>] [--full] [--format png|jpeg]

Tabs:
  list-tabs                       List page targets
  switch-tab <id>                 Activate a tab
  new-tab [url]                   Create a new tab (default about:blank)
  close-tab <id>                  Close a tab

Skills:
  list-skills <hostname>          List skills for a hostname
  save-skill <host> <name> <body> Save a skill. body = "-" (stdin) or "@path" or literal
                                  [--mode versioned|fail-if-exists|overwrite]
                                  [--author <name>] [--no-frontmatter]

Flags (global):
  --port <n>         CDP port (default 9222)
  --skills-root <p>  Override skills root (default ~/.claude/skills/domains)
  --max-skills <n>   Max skills to load on goto (default 10)
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { command: "", positional: [], flags: {} };
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

async function readBody(arg: string): Promise<string> {
  if (arg === "-") {
    return await new Promise<string>((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    });
  }
  if (arg.startsWith("@")) {
    return await readFile(arg.slice(1), "utf8");
  }
  return arg;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function emitError(err: unknown): number {
  if (
    err instanceof InvalidHostnameError ||
    err instanceof InvalidSkillNameError ||
    err instanceof SkillExistsError
  ) {
    emit({ error: err.name, message: err.message });
    return 2;
  }
  if (err instanceof PrivatePathLiteralError) {
    emit({ error: err.name, message: err.message, matched: err.matched });
    return 2;
  }
  const message = err instanceof Error ? err.message : String(err);
  emit({ error: "Error", message });
  return 1;
}

function num(v: string | boolean | undefined, fallback?: number): number | undefined {
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function bool(v: string | boolean | undefined): boolean {
  return v === true || v === "true";
}

function parseMode(v: string | boolean | undefined): SaveSkillMode | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (s === "versioned" || s === "fail-if-exists" || s === "overwrite") return s;
  throw new Error(`Unknown --mode: ${s}`);
}

async function dispatch(args: ParsedArgs): Promise<number> {
  const port = num(args.flags.port);
  const skillsRoot = str(args.flags["skills-root"]);
  const maxSkills = num(args.flags["max-skills"]);

  switch (args.command) {
    case "goto": {
      const [url] = args.positional;
      if (!url) throw new Error("usage: goto <url>");
      const result = await withLogging("goto", { url }, () =>
        goto(url, { port, skillsRoot, maxSkills }),
      );
      emit(result);
      return 0;
    }
    case "page-info": {
      const result = await pageInfo({ port });
      emit(result);
      return 0;
    }
    case "js": {
      const expr = args.positional.join(" ");
      if (!expr) throw new Error("usage: js <expression>");
      const result = await js(expr, { port });
      emit({ value: result });
      return 0;
    }
    case "click": {
      const [xs, ys] = args.positional;
      if (!xs || !ys) throw new Error("usage: click <x> <y>");
      await withLogging("click", { x: Number(xs), y: Number(ys) }, () =>
        click(Number(xs), Number(ys), { port }),
      );
      emit({ ok: true });
      return 0;
    }
    case "click-selector": {
      const [selector] = args.positional;
      if (!selector) throw new Error("usage: click-selector <css>");
      const pt = await withLogging("click-selector", { selector }, () =>
        clickSelector(selector, { port }),
      );
      emit(pt);
      return 0;
    }
    case "type": {
      const text = args.positional.join(" ");
      if (!text) throw new Error("usage: type <text>");
      await withLogging("type", { length: text.length }, () => inputType(text, { port }));
      emit({ ok: true });
      return 0;
    }
    case "clear-text": {
      const selector = str(args.flags.selector);
      await withLogging("clear-text", { selector: selector || null }, () =>
        clearText({ port, selector }),
      );
      emit({ ok: true });
      return 0;
    }
    case "press": {
      const [key] = args.positional;
      if (!key) throw new Error("usage: press <key>");
      const mods = str(args.flags.modifiers)?.split(",").filter(Boolean) ?? [];
      await withLogging("press", { key, modifiers: mods }, () =>
        press(key, { port, modifiers: mods as any }),
      );
      emit({ ok: true });
      return 0;
    }
    case "scroll": {
      const [dxs, dys] = args.positional;
      if (!dxs || !dys) throw new Error("usage: scroll <dx> <dy>");
      await withLogging("scroll", { dx: Number(dxs), dy: Number(dys) }, () =>
        scroll(Number(dxs), Number(dys), { port }),
      );
      emit({ ok: true });
      return 0;
    }
    case "collect": {
      const [selector] = args.positional;
      if (!selector) throw new Error("usage: collect <selector>");
      const options = {
        port,
        target: num(args.flags.target),
        maxScrolls: num(args.flags["max-scrolls"]),
        settle: num(args.flags.settle),
        stable: num(args.flags.stable),
        maxText: num(args.flags["max-text"]),
      };
      const result = await withLogging("collect", { selector, ...options }, () =>
        collect(selector, options),
      );
      emit(result);
      return 0;
    }
    case "screenshot": {
      const result = await screenshot({
        port,
        path: str(args.flags.path),
        fullPage: bool(args.flags.full),
        format: (str(args.flags.format) as "png" | "jpeg" | undefined) ?? "png",
        quality: num(args.flags.quality),
      });
      emit(result);
      return 0;
    }
    case "list-tabs": {
      const result = await listTabs({ port });
      emit(result);
      return 0;
    }
    case "switch-tab": {
      const [id] = args.positional;
      if (!id) throw new Error("usage: switch-tab <id>");
      await switchTab(id, { port });
      emit({ ok: true });
      return 0;
    }
    case "new-tab": {
      const [url] = args.positional;
      const result = await newTab(url ?? "about:blank", { port });
      emit(result);
      return 0;
    }
    case "close-tab": {
      const [id] = args.positional;
      if (!id) throw new Error("usage: close-tab <id>");
      await closeTab(id, { port });
      emit({ ok: true });
      return 0;
    }
    case "list-skills": {
      const [host] = args.positional;
      if (!host) throw new Error("usage: list-skills <hostname>");
      const result = await listSkills(host, { skillsRoot });
      emit(result);
      return 0;
    }
    case "save-skill": {
      const [host, name, bodyArg] = args.positional;
      if (!host || !name || bodyArg === undefined) {
        throw new Error('usage: save-skill <host> <name> <body|-|@file>');
      }
      const body = await readBody(bodyArg);
      const mode = parseMode(args.flags.mode);
      const autoFrontmatter = !bool(args.flags["no-frontmatter"]);
      const result = await withLogging(
        "save-skill",
        { hostname: host, name, mode, bytes: body.length },
        () =>
          saveSkill(host, name, body, {
            skillsRoot,
            mode,
            author: str(args.flags.author),
            autoFrontmatter,
          }),
      );
      emit(result);
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${args.command}\n${HELP}`);
      return 2;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.command || args.command === "--help" || args.command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    return await dispatch(args);
  } catch (err) {
    return emitError(err);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  },
);
