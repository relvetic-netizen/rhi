import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  DomainSkill,
  InvalidHostnameError,
  InvalidSkillNameError,
  PrivatePathLiteralError,
  SaveSkillOptions,
  SaveSkillResult,
  SkillExistsError,
} from "../types.js";
import { ensureFrontmatter } from "../frontmatter.js";

const HOSTNAME_RE = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/i;
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const MAX_SKILLS_DEFAULT = 10;

const PRIVATE_LITERALS = [
  "~/.claude/memory/private",
  "~/.claude/relvetia/private",
  "~/.claude/secrets",
  "$HOME/.claude/memory/private",
  "$HOME/.claude/relvetia/private",
  "$HOME/.claude/secrets",
];

function defaultSkillsRoot(): string {
  return path.join(homedir(), ".claude", "skills", "domains");
}

function validateHostname(hostname: string): void {
  if (!hostname || hostname.length > 253) throw new InvalidHostnameError(hostname);
  if (hostname.includes("..") || hostname.includes("/") || hostname.includes("\\")) {
    throw new InvalidHostnameError(hostname);
  }
  if (!HOSTNAME_RE.test(hostname)) throw new InvalidHostnameError(hostname);
}

function validateSkillName(name: string): void {
  if (!name || name.length > 120) throw new InvalidSkillNameError(name);
  if (!SKILL_NAME_RE.test(name)) throw new InvalidSkillNameError(name);
}

function checkPrivateLiterals(content: string): void {
  const normalized = content.toLowerCase();
  for (const literal of PRIVATE_LITERALS) {
    if (normalized.includes(literal.toLowerCase())) {
      throw new PrivatePathLiteralError(literal);
    }
  }
  const winRe = /[a-z]:[\\/]users[\\/][^\\/\s"']+[\\/]\.claude[\\/](?:memory[\\/]private|relvetia[\\/]private|secrets)/i;
  const winMatch = content.match(winRe);
  if (winMatch) throw new PrivatePathLiteralError(winMatch[0]);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export async function saveSkill(
  hostname: string,
  name: string,
  content: string,
  opts: SaveSkillOptions = {},
): Promise<SaveSkillResult> {
  validateHostname(hostname);
  validateSkillName(name);
  checkPrivateLiterals(content);

  const mode = opts.mode ?? "versioned";
  const autoFrontmatter = opts.autoFrontmatter ?? true;
  const root = opts.skillsRoot ?? defaultSkillsRoot();
  const dir = path.join(root, hostname.toLowerCase());
  await fs.mkdir(dir, { recursive: true });

  const target = path.join(dir, `${name}.md`);
  let renamedFrom: string | undefined;

  let existed = false;
  try {
    const existing = await fs.stat(target);
    if (existing.isFile()) existed = true;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  if (existed) {
    if (mode === "fail-if-exists") throw new SkillExistsError(target);
    if (mode === "versioned") {
      const versioned = path.join(dir, `${name}.${timestamp()}.md`);
      await fs.rename(target, versioned);
      renamedFrom = versioned;
    }
  }

  const finalContent = autoFrontmatter
    ? ensureFrontmatter(content, {
        hostname: hostname.toLowerCase(),
        name,
        updated_at: new Date().toISOString(),
        author: opts.author ?? "relvetia-browser",
      })
    : content;

  checkPrivateLiterals(finalContent);

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, finalContent, "utf8");
  await fs.rename(tmp, target);

  const stat = await fs.stat(target);
  return { path: target, bytes: stat.size, renamedFrom };
}

export async function listSkills(
  hostname: string,
  opts: SaveSkillOptions = {},
): Promise<DomainSkill[]> {
  validateHostname(hostname);
  const root = opts.skillsRoot ?? defaultSkillsRoot();
  const dir = path.join(root, hostname.toLowerCase());

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const results: DomainSkill[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full);
    if (!stat.isFile()) continue;
    const content = await fs.readFile(full, "utf8");
    results.push({
      path: full,
      hostname: hostname.toLowerCase(),
      name: entry.slice(0, -3),
      content,
      mtime: stat.mtimeMs,
    });
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

export async function loadDomainSkills(
  hostname: string,
  opts: SaveSkillOptions & { maxSkills?: number } = {},
): Promise<DomainSkill[]> {
  const max = opts.maxSkills ?? MAX_SKILLS_DEFAULT;
  const candidates = hostnameChain(hostname);
  const seen = new Set<string>();
  const acc: DomainSkill[] = [];
  for (const host of candidates) {
    let skills: DomainSkill[] = [];
    try {
      skills = await listSkills(host, opts);
    } catch (err) {
      if (err instanceof InvalidHostnameError) continue;
      throw err;
    }
    for (const skill of skills) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      acc.push(skill);
      if (acc.length >= max) return acc;
    }
  }
  return acc;
}

export function hostnameChain(hostname: string): string[] {
  const h = hostname.toLowerCase();
  const parts = h.split(".");
  const chain: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join(".");
    if (candidate.includes(".")) chain.push(candidate);
  }
  if (chain[0] !== h) chain.unshift(h);
  return chain;
}

export const __internal = { validateHostname, validateSkillName, checkPrivateLiterals };
