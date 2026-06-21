import { withPage } from "../cdp.js";
import { loadDomainSkills } from "./skills.js";
import { GotoOptions, GotoResult } from "../types.js";

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function goto(url: string, opts: GotoOptions = {}): Promise<GotoResult> {
  const timeout = opts.navigateTimeoutMs ?? 15000;
  return await withPage(async ({ Page, Runtime }) => {
    const loadPromise = new Promise<void>((resolve) => {
      Page.loadEventFired(() => resolve());
    });
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeout));

    await Page.navigate({ url });
    await Promise.race([loadPromise, timeoutPromise]);

    const [titleRes, urlRes] = await Promise.all([
      Runtime.evaluate({ expression: "document.title", returnByValue: true }),
      Runtime.evaluate({ expression: "location.href", returnByValue: true }),
    ]);
    const title = typeof titleRes?.result?.value === "string" ? titleRes.result.value : "";
    const finalUrl = typeof urlRes?.result?.value === "string" ? urlRes.result.value : url;
    const hostname = extractHostname(finalUrl);

    const domainSkills = hostname
      ? await loadDomainSkills(hostname, {
          skillsRoot: opts.skillsRoot,
          maxSkills: opts.maxSkills,
        })
      : [];

    return { url: finalUrl, hostname, title, domainSkills };
  }, { port: opts.port });
}
