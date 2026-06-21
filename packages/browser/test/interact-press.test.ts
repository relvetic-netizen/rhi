import { describe, it, expect } from "vitest";
import { resolveKey } from "../src/api/interact.js";

describe("resolveKey", () => {
  it("special keys: Enter has code, keyCode, text", () => {
    const r = resolveKey("Enter", false);
    expect(r.code).toBe("Enter");
    expect(r.windowsVirtualKeyCode).toBe(13);
    expect(r.text).toBe("\r");
  });

  it("special keys: Backspace has code+keyCode, no text", () => {
    const r = resolveKey("Backspace", false);
    expect(r.code).toBe("Backspace");
    expect(r.windowsVirtualKeyCode).toBe(8);
    expect(r.text).toBeUndefined();
  });

  it("special keys: arrow keys", () => {
    expect(resolveKey("ArrowDown", false).windowsVirtualKeyCode).toBe(40);
    expect(resolveKey("ArrowUp", false).code).toBe("ArrowUp");
  });

  it("ASCII letter: lowercase a → KeyA, keyCode 65, text 'a'", () => {
    const r = resolveKey("a", false);
    expect(r.code).toBe("KeyA");
    expect(r.windowsVirtualKeyCode).toBe(65);
    expect(r.text).toBe("a");
  });

  it("ASCII letter with suppressText (modifier held): no text emitted", () => {
    const r = resolveKey("a", true);
    expect(r.code).toBe("KeyA");
    expect(r.windowsVirtualKeyCode).toBe(65);
    expect(r.text).toBeUndefined();
  });

  it("ASCII digit: '5' → Digit5", () => {
    const r = resolveKey("5", false);
    expect(r.code).toBe("Digit5");
    expect(r.windowsVirtualKeyCode).toBe(53);
    expect(r.text).toBe("5");
  });

  it("Enter with suppressText drops text", () => {
    const r = resolveKey("Enter", true);
    expect(r.text).toBeUndefined();
    expect(r.windowsVirtualKeyCode).toBe(13);
  });

  it("Tab special key with text", () => {
    expect(resolveKey("Tab", false).text).toBe("\t");
    expect(resolveKey("Tab", false).windowsVirtualKeyCode).toBe(9);
  });
});
