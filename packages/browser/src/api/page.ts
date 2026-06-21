import { promises as fs } from "node:fs";
import { withPage } from "../cdp.js";

export interface PageInfo {
  url: string;
  title: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  scroll: { x: number; y: number; maxX: number; maxY: number };
}

export interface ScreenshotOptions {
  port?: number;
  path?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
}

export interface ScreenshotResult {
  path?: string;
  bytes: number;
  width: number;
  height: number;
  format: "png" | "jpeg";
}

export interface JsOptions {
  port?: number;
  awaitPromise?: boolean;
  returnByValue?: boolean;
}

export async function pageInfo(opts: { port?: number } = {}): Promise<PageInfo> {
  return await withPage(async ({ Runtime }) => {
    const expr = `
      (() => ({
        url: location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
        scroll: {
          x: window.scrollX,
          y: window.scrollY,
          maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        },
      }))()
    `;
    const res = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`pageInfo failed: ${res.exceptionDetails.text}`);
    }
    return res.result.value as PageInfo;
  }, { port: opts.port });
}

export async function screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
  const format = opts.format ?? "png";
  const fullPage = opts.fullPage ?? false;
  const quality = opts.quality;

  return await withPage(async ({ Page }) => {
    const params: any = { format };
    if (format === "jpeg" && typeof quality === "number") params.quality = quality;

    let width = 0;
    let height = 0;

    if (fullPage) {
      const metrics = await Page.getLayoutMetrics();
      const cs = metrics.cssContentSize ?? metrics.contentSize;
      width = Math.ceil(cs.width);
      height = Math.ceil(cs.height);
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
      params.captureBeyondViewport = true;
    }

    const res = await Page.captureScreenshot(params);
    const buf = Buffer.from(res.data, "base64");

    if (!fullPage) {
      const metrics = await Page.getLayoutMetrics();
      const vp = metrics.cssVisualViewport ?? metrics.visualViewport;
      width = Math.ceil(vp.clientWidth);
      height = Math.ceil(vp.clientHeight);
    }

    const result: ScreenshotResult = { bytes: buf.length, width, height, format };
    if (opts.path) {
      await fs.writeFile(opts.path, buf);
      result.path = opts.path;
    }
    return result;
  }, { port: opts.port });
}

export async function js<T = unknown>(expression: string, opts: JsOptions = {}): Promise<T> {
  return await withPage(async ({ Runtime }) => {
    const res = await Runtime.evaluate({
      expression,
      returnByValue: opts.returnByValue ?? true,
      awaitPromise: opts.awaitPromise ?? true,
    });
    if (res.exceptionDetails) {
      throw new Error(`js evaluation failed: ${res.exceptionDetails.text}`);
    }
    return res.result.value as T;
  }, { port: opts.port });
}
