import { describe, expect, it } from "vitest";
import { type CollectedItem, mergeUnique } from "../src/api/collect.js";

describe("mergeUnique", () => {
  it("adds all unique items", () => {
    const acc = new Map<string, CollectedItem>();
    const added = mergeUnique(acc, [
      { key: "a", text: "alpha" },
      { key: "b", text: "bravo" },
    ]);

    expect(added).toBe(2);
    expect(Array.from(acc.values())).toEqual([
      { key: "a", text: "alpha" },
      { key: "b", text: "bravo" },
    ]);
  });

  it("skips duplicate keys", () => {
    const acc = new Map<string, CollectedItem>([["a", { key: "a", text: "alpha" }]]);
    const added = mergeUnique(acc, [
      { key: "a", text: "new alpha" },
      { key: "b", text: "bravo" },
    ]);

    expect(added).toBe(1);
    expect(Array.from(acc.keys())).toEqual(["a", "b"]);
  });

  it("returns the number of newly added items", () => {
    const acc = new Map<string, CollectedItem>([["a", { key: "a", text: "alpha" }]]);
    const added = mergeUnique(acc, [
      { key: "a", text: "alpha duplicate" },
      { key: "b", text: "bravo" },
      { key: "c", text: "charlie" },
    ]);

    expect(added).toBe(2);
  });

  it("does not overwrite existing text and preserves order", () => {
    const acc = new Map<string, CollectedItem>([["a", { key: "a", text: "alpha" }]]);
    mergeUnique(acc, [
      { key: "b", text: "bravo" },
      { key: "a", text: "updated alpha" },
      { key: "c", text: "charlie" },
    ]);

    expect(Array.from(acc.values())).toEqual([
      { key: "a", text: "alpha" },
      { key: "b", text: "bravo" },
      { key: "c", text: "charlie" },
    ]);
  });
});
