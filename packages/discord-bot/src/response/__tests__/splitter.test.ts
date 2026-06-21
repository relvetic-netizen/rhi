import { describe, it, expect } from "vitest";
import { splitMessage, shouldAttachAsFile } from "../splitter.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("splits long messages at paragraph boundaries", () => {
    const text = "A".repeat(1000) + "\n\n" + "B".repeat(1000);
    const result = splitMessage(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result.join("").replace(/```\w*\n?/g, "")).toContain("A".repeat(1000));
  });

  it("handles messages at exactly max length", () => {
    const text = "A".repeat(1950);
    const result = splitMessage(text);
    expect(result).toEqual([text]);
  });

  it("preserves code blocks across splits", () => {
    const code = "```js\n" + "x = 1;\n".repeat(300) + "```";
    const result = splitMessage(code);
    // Each chunk should have balanced backticks
    for (const chunk of result) {
      const fences = (chunk.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }
  });
});

describe("shouldAttachAsFile", () => {
  it("returns false for short text", () => {
    expect(shouldAttachAsFile("short")).toBe(false);
  });

  it("returns true for text over 8000 chars", () => {
    expect(shouldAttachAsFile("A".repeat(8001))).toBe(true);
  });
});
