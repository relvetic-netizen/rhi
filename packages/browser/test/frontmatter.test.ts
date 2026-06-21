import { describe, expect, it } from "vitest";
import {
  ensureFrontmatter,
  parseFrontmatter,
  stringifyFrontmatter,
} from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  it("extracts simple key/value pairs", () => {
    const { data, body } = parseFrontmatter("---\nhostname: x.com\nname: dm\n---\n# body\n");
    expect(data).toEqual({ hostname: "x.com", name: "dm" });
    expect(body).toBe("# body\n");
  });

  it("strips single and double quotes", () => {
    const { data } = parseFrontmatter('---\nkey: "quoted"\nother: \'also\'\n---\nbody');
    expect(data).toEqual({ key: "quoted", other: "also" });
  });

  it("returns body unchanged when no frontmatter", () => {
    const { data, body } = parseFrontmatter("just a body");
    expect(data).toEqual({});
    expect(body).toBe("just a body");
  });

  it("ignores comment and blank lines", () => {
    const { data } = parseFrontmatter("---\n# a comment\nkey: value\n\n---\nbody");
    expect(data).toEqual({ key: "value" });
  });
});

describe("stringifyFrontmatter", () => {
  it("round-trips via parse", () => {
    const out = stringifyFrontmatter({ a: "1", b: "two" }, "body content");
    const parsed = parseFrontmatter(out);
    expect(parsed.data).toEqual({ a: "1", b: "two" });
    expect(parsed.body).toBe("body content");
  });
});

describe("ensureFrontmatter", () => {
  it("adds defaults when missing", () => {
    const out = ensureFrontmatter("# plain body\n", { hostname: "x.com", author: "r" });
    const parsed = parseFrontmatter(out);
    expect(parsed.data.hostname).toBe("x.com");
    expect(parsed.data.author).toBe("r");
    expect(parsed.body).toBe("# plain body\n");
  });

  it("preserves user-supplied values over defaults", () => {
    const input = "---\nhostname: y.com\n---\nbody";
    const out = ensureFrontmatter(input, { hostname: "x.com", author: "r" });
    const parsed = parseFrontmatter(out);
    expect(parsed.data.hostname).toBe("y.com");
    expect(parsed.data.author).toBe("r");
  });
});
