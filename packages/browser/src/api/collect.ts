import { withPage } from "../cdp.js";

export interface CollectedItem {
  key: string;
  text: string;
}

export type CollectReason = "target" | "dry" | "max-scrolls";

export interface CollectOptions {
  port?: number;
  target?: number;
  maxScrolls?: number;
  settle?: number;
  stable?: number;
  maxText?: number;
}

export interface CollectResult {
  items: CollectedItem[];
  count: number;
  scrolls: number;
  reason: CollectReason;
  targetReached: boolean;
}

interface ResolvedCollectOptions {
  target: number;
  maxScrolls: number;
  settle: number;
  stable: number;
  maxText: number;
}

export function mergeUnique(acc: Map<string, CollectedItem>, items: CollectedItem[]): number {
  let added = 0;
  for (const item of items) {
    if (acc.has(item.key)) continue;
    acc.set(item.key, item);
    added++;
  }
  return added;
}

function resolveOptions(opts: CollectOptions): ResolvedCollectOptions {
  return {
    target: opts.target ?? 30,
    maxScrolls: opts.maxScrolls ?? 20,
    settle: opts.settle ?? 1200,
    stable: opts.stable ?? 3,
    maxText: opts.maxText ?? 280,
  };
}

function snapshotExpression(selector: string, maxText: number): string {
  return `
    (() => {
      const selector = ${JSON.stringify(selector)};
      const maxText = ${JSON.stringify(maxText)};
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const hash = (value) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < value.length; i++) {
          h ^= value.charCodeAt(i);
          h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16);
      };
      return Array.from(document.querySelectorAll(selector)).map((el) => {
        const fullText = normalize(el.textContent);
        const source = fullText || el.outerHTML;
        return {
          key: hash(source),
          text: fullText.length > maxText ? fullText.slice(0, maxText) : fullText,
        };
      });
    })()
  `;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluateSnapshot(Runtime: any, selector: string, maxText: number): Promise<CollectedItem[]> {
  const res = await Runtime.evaluate({
    expression: snapshotExpression(selector, maxText),
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`collect snapshot failed: ${res.exceptionDetails.text}`);
  }
  return res.result.value as CollectedItem[];
}

async function scrollViewport(Runtime: any): Promise<void> {
  const res = await Runtime.evaluate({
    expression: "window.scrollBy(0, Math.round(window.innerHeight * 0.85))",
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(`collect scroll failed: ${res.exceptionDetails.text}`);
  }
}

function toResult(
  acc: Map<string, CollectedItem>,
  scrolls: number,
  reason: CollectReason,
  target: number,
): CollectResult {
  const items = Array.from(acc.values());
  return {
    items,
    count: items.length,
    scrolls,
    reason,
    targetReached: items.length >= target,
  };
}

export async function collect(
  selector: string,
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const config = resolveOptions(opts);

  return await withPage(async ({ Runtime }) => {
    const acc = new Map<string, CollectedItem>();
    let scrolls = 0;
    let dryStreak = 0;

    mergeUnique(acc, await evaluateSnapshot(Runtime, selector, config.maxText));
    if (acc.size >= config.target) {
      return toResult(acc, scrolls, "target", config.target);
    }
    if (scrolls >= config.maxScrolls) {
      return toResult(acc, scrolls, "max-scrolls", config.target);
    }

    while (scrolls < config.maxScrolls) {
      await scrollViewport(Runtime);
      scrolls++;
      await sleep(config.settle);

      const added = mergeUnique(acc, await evaluateSnapshot(Runtime, selector, config.maxText));
      if (acc.size >= config.target) {
        return toResult(acc, scrolls, "target", config.target);
      }

      dryStreak = added === 0 ? dryStreak + 1 : 0;
      if (dryStreak >= config.stable) {
        return toResult(acc, scrolls, "dry", config.target);
      }
      if (scrolls >= config.maxScrolls) {
        return toResult(acc, scrolls, "max-scrolls", config.target);
      }
    }

    return toResult(acc, scrolls, "max-scrolls", config.target);
  }, { port: opts.port });
}
