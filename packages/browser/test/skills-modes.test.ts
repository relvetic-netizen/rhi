import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSkill } from "../src/api/skills.js";
import { SkillExistsError } from "../src/types.js";
import { parseFrontmatter } from "../src/frontmatter.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "relvetia-browser-modes-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("saveSkill modes", () => {
  it("fail-if-exists throws SkillExistsError on duplicate", async () => {
    await saveSkill("x.com", "hello", "first", { skillsRoot: root });
    await expect(
      saveSkill("x.com", "hello", "second", { skillsRoot: root, mode: "fail-if-exists" }),
    ).rejects.toBeInstanceOf(SkillExistsError);
  });

  it("overwrite mode replaces without versioning", async () => {
    await saveSkill("x.com", "hello", "first", { skillsRoot: root });
    const res = await saveSkill("x.com", "hello", "second", {
      skillsRoot: root,
      mode: "overwrite",
    });
    expect(res.renamedFrom).toBeUndefined();
    const files = await readdir(path.join(root, "x.com"));
    expect(files).toEqual(["hello.md"]);
  });

  it("versioned mode renames previous file", async () => {
    await saveSkill("x.com", "hello", "first", { skillsRoot: root });
    const res = await saveSkill("x.com", "hello", "second", {
      skillsRoot: root,
      mode: "versioned",
    });
    expect(res.renamedFrom).toMatch(/hello\.\d{8}-\d{6}\.md$/);
    const files = await readdir(path.join(root, "x.com"));
    expect(files.length).toBe(2);
  });
});

describe("saveSkill frontmatter injection", () => {
  it("auto-injects hostname/name/author/updated_at", async () => {
    const res = await saveSkill("x.com", "hello", "# body\n", {
      skillsRoot: root,
      author: "private",
    });
    const content = await readFile(res.path, "utf8");
    const { data } = parseFrontmatter(content);
    expect(data.hostname).toBe("x.com");
    expect(data.name).toBe("hello");
    expect(data.author).toBe("private");
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves user-supplied frontmatter values", async () => {
    const body = "---\nauthor: someone\n---\nbody";
    const res = await saveSkill("x.com", "hello", body, {
      skillsRoot: root,
      author: "private",
    });
    const content = await readFile(res.path, "utf8");
    const { data } = parseFrontmatter(content);
    expect(data.author).toBe("someone");
  });

  it("no-frontmatter mode stores content as-is", async () => {
    const body = "just raw text";
    const res = await saveSkill("x.com", "hello", body, {
      skillsRoot: root,
      autoFrontmatter: false,
    });
    const content = await readFile(res.path, "utf8");
    expect(content).toBe("just raw text");
  });
});
