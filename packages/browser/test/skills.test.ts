import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostnameChain,
  listSkills,
  loadDomainSkills,
  saveSkill,
} from "../src/api/skills.js";
import {
  InvalidHostnameError,
  InvalidSkillNameError,
  PrivatePathLiteralError,
} from "../src/types.js";
import { parseFrontmatter } from "../src/frontmatter.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relvetia-browser-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("saveSkill", () => {
  it("writes a skill and returns its path", async () => {
    const res = await saveSkill("x.com", "hello", "# body", { skillsRoot: root });
    expect(res.path).toBe(path.join(root, "x.com", "hello.md"));
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.renamedFrom).toBeUndefined();
    const content = await readFile(res.path, "utf8");
    expect(parseFrontmatter(content).body).toBe("# body");
  });

  it("versions an existing skill on overwrite", async () => {
    await saveSkill("x.com", "hello", "first", { skillsRoot: root });
    const res = await saveSkill("x.com", "hello", "second", { skillsRoot: root });
    expect(res.renamedFrom).toBeDefined();
    expect(res.renamedFrom).toMatch(/hello\.\d{8}-\d{6}\.md$/);
    const content = await readFile(res.path, "utf8");
    expect(parseFrontmatter(content).body).toBe("second");
    const files = await readdir(path.join(root, "x.com"));
    expect(files.length).toBe(2);
  });

  it("rejects hostname with path traversal", async () => {
    await expect(saveSkill("../evil", "x", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidHostnameError,
    );
  });

  it("rejects hostname with slashes", async () => {
    await expect(saveSkill("x.com/y", "x", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidHostnameError,
    );
  });

  it("rejects hostname with null byte", async () => {
    await expect(saveSkill("x.com\0", "x", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidHostnameError,
    );
  });

  it("rejects empty hostname", async () => {
    await expect(saveSkill("", "x", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidHostnameError,
    );
  });

  it("rejects skill name with traversal", async () => {
    await expect(saveSkill("x.com", "../evil", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidSkillNameError,
    );
  });

  it("rejects skill name with slashes", async () => {
    await expect(saveSkill("x.com", "a/b", "body", { skillsRoot: root })).rejects.toBeInstanceOf(
      InvalidSkillNameError,
    );
  });

  it("rejects content with tilde private private path literal", async () => {
    const body = "see ~/.claude/memory/private/MANIFESTO.md";
    await expect(saveSkill("x.com", "leak", body, { skillsRoot: root })).rejects.toBeInstanceOf(
      PrivatePathLiteralError,
    );
  });

  it("rejects content with $HOME private private path literal", async () => {
    const body = "cat $HOME/.claude/relvetia/private/state.json";
    await expect(saveSkill("x.com", "leak", body, { skillsRoot: root })).rejects.toBeInstanceOf(
      PrivatePathLiteralError,
    );
  });

  it("rejects content with Windows private private path literal", async () => {
    const body = "file: C:\\Users\\alice\\.claude\\memory\\private\\diary.md";
    await expect(saveSkill("x.com", "leak", body, { skillsRoot: root })).rejects.toBeInstanceOf(
      PrivatePathLiteralError,
    );
  });

  it("rejects content referencing secrets directory", async () => {
    const body = "token at ~/.claude/secrets/x-dm-passcode";
    await expect(saveSkill("x.com", "leak", body, { skillsRoot: root })).rejects.toBeInstanceOf(
      PrivatePathLiteralError,
    );
  });

  it("accepts content that only references public paths", async () => {
    const body = "- see ~/.claude/skills/domains/x.com/other.md";
    const res = await saveSkill("x.com", "ok", body, { skillsRoot: root });
    expect(res.bytes).toBeGreaterThan(0);
  });
});

describe("listSkills", () => {
  it("returns empty for unknown hostname", async () => {
    const skills = await listSkills("unknown.example", { skillsRoot: root });
    expect(skills).toEqual([]);
  });

  it("returns skills sorted by mtime desc", async () => {
    await saveSkill("x.com", "first", "1", { skillsRoot: root });
    await new Promise((r) => setTimeout(r, 20));
    await saveSkill("x.com", "second", "2", { skillsRoot: root });
    const skills = await listSkills("x.com", { skillsRoot: root });
    expect(skills.map((s) => s.name)).toEqual(["second", "first"]);
  });

  it("ignores non-md files", async () => {
    await mkdir(path.join(root, "x.com"), { recursive: true });
    await writeFile(path.join(root, "x.com", "note.txt"), "ignore me");
    await saveSkill("x.com", "real", "body", { skillsRoot: root });
    const skills = await listSkills("x.com", { skillsRoot: root });
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });
});

describe("hostnameChain", () => {
  it("returns chain from specific to parent", () => {
    expect(hostnameChain("www.x.com")).toEqual(["www.x.com", "x.com"]);
  });

  it("handles single level hostname", () => {
    expect(hostnameChain("x.com")).toEqual(["x.com"]);
  });

  it("handles deep subdomains", () => {
    expect(hostnameChain("a.b.c.example.com")).toEqual([
      "a.b.c.example.com",
      "b.c.example.com",
      "c.example.com",
      "example.com",
    ]);
  });
});

describe("loadDomainSkills", () => {
  it("walks subdomain chain and dedupes by name", async () => {
    await saveSkill("x.com", "shared", "parent", { skillsRoot: root });
    await saveSkill("www.x.com", "shared", "child", { skillsRoot: root });
    await saveSkill("x.com", "parent-only", "parent", { skillsRoot: root });
    const skills = await loadDomainSkills("www.x.com", { skillsRoot: root });
    const byName = Object.fromEntries(
      skills.map((s) => [s.name, parseFrontmatter(s.content).body]),
    );
    expect(byName.shared).toBe("child");
    expect(byName["parent-only"]).toBe("parent");
  });

  it("respects maxSkills cap", async () => {
    for (let i = 0; i < 5; i++) {
      await saveSkill("x.com", `s${i}`, `body${i}`, { skillsRoot: root });
    }
    const skills = await loadDomainSkills("x.com", { skillsRoot: root, maxSkills: 2 });
    expect(skills.length).toBe(2);
  });
});
