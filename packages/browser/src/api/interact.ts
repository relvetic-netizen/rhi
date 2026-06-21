import { withPage } from "../cdp.js";

export interface ClickOptions {
  port?: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface TypeOptions {
  port?: number;
}

export interface KeyOptions {
  port?: number;
  modifiers?: Array<"Alt" | "Ctrl" | "Meta" | "Shift">;
}

export interface ScrollOptions {
  port?: number;
}

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Meta: 4,
  Shift: 8,
};

const NON_SHIFT_MODIFIER_MASK = MODIFIER_BITS.Alt | MODIFIER_BITS.Ctrl | MODIFIER_BITS.Meta;

function modifierBits(mods: string[] | undefined): number {
  if (!mods) return 0;
  return mods.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0);
}

interface ResolvedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, Omit<ResolvedKey, "key">> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export function resolveKey(key: string, suppressText: boolean): ResolvedKey {
  const special = SPECIAL_KEYS[key];
  if (special) {
    return {
      key,
      code: special.code,
      windowsVirtualKeyCode: special.windowsVirtualKeyCode,
      ...(special.text !== undefined && !suppressText ? { text: special.text } : {}),
    };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    let code = "";
    let kc = key.charCodeAt(0);
    if (/[a-zA-Z]/.test(key)) {
      code = "Key" + upper;
      kc = upper.charCodeAt(0);
    } else if (/[0-9]/.test(key)) {
      code = "Digit" + key;
    }
    return {
      key,
      code,
      windowsVirtualKeyCode: kc,
      ...(suppressText ? {} : { text: key }),
    };
  }
  return { key, code: key, windowsVirtualKeyCode: 0 };
}

export async function click(x: number, y: number, opts: ClickOptions = {}): Promise<void> {
  const button = opts.button ?? "left";
  const clickCount = opts.clickCount ?? 1;
  await withPage(async ({ Input }) => {
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button, clickCount });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button, clickCount });
  }, { port: opts.port });
}

export async function type(text: string, opts: TypeOptions = {}): Promise<void> {
  await withPage(async ({ Input }) => {
    await Input.insertText({ text });
  }, { port: opts.port });
}

export async function press(key: string, opts: KeyOptions = {}): Promise<void> {
  const modifiers = modifierBits(opts.modifiers);
  const suppressText = (modifiers & NON_SHIFT_MODIFIER_MASK) !== 0;
  const r = resolveKey(key, suppressText);
  const base = {
    key: r.key,
    code: r.code,
    windowsVirtualKeyCode: r.windowsVirtualKeyCode,
    nativeVirtualKeyCode: r.windowsVirtualKeyCode,
    modifiers,
  };
  await withPage(async ({ Input }) => {
    await Input.dispatchKeyEvent({
      type: r.text !== undefined ? "keyDown" : "rawKeyDown",
      ...base,
      ...(r.text !== undefined ? { text: r.text } : {}),
    });
    await Input.dispatchKeyEvent({ type: "keyUp", ...base });
  }, { port: opts.port });
}

export async function scroll(dx: number, dy: number, opts: ScrollOptions = {}): Promise<void> {
  await withPage(async ({ Runtime }) => {
    await Runtime.evaluate({
      expression: `window.scrollBy(${Number(dx)}, ${Number(dy)})`,
      returnByValue: true,
    });
  }, { port: opts.port });
}

export interface ClearTextOptions {
  port?: number;
  selector?: string;
}

export async function clearText(opts: ClearTextOptions = {}): Promise<void> {
  if (opts.selector) {
    await clickSelector(opts.selector, { port: opts.port });
  }
  await press("a", { port: opts.port, modifiers: ["Ctrl"] });
  await press("Backspace", { port: opts.port });
}

export async function clickSelector(
  selector: string,
  opts: ClickOptions = {},
): Promise<{ x: number; y: number }> {
  return await withPage(async ({ Runtime, Input }) => {
    const expr = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()
    `;
    const res = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`clickSelector evaluation failed: ${res.exceptionDetails.text}`);
    }
    const pt = res.result.value;
    if (!pt) throw new Error(`Selector not found: ${selector}`);
    const button = opts.button ?? "left";
    const clickCount = opts.clickCount ?? 1;
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pt.x, y: pt.y, button, clickCount });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount });
    return pt;
  }, { port: opts.port });
}
