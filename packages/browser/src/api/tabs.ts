import CDP from "chrome-remote-interface";

export interface TabInfo {
  id: string;
  type: string;
  url: string;
  title: string;
}

export interface TabsOptions {
  port?: number;
  host?: string;
}

export async function listTabs(opts: TabsOptions = {}): Promise<TabInfo[]> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  const targets = await CDP.List({ host, port });
  return targets
    .filter((t: any) => t.type === "page")
    .map((t: any) => ({ id: t.id, type: t.type, url: t.url ?? "", title: t.title ?? "" }));
}

export async function switchTab(id: string, opts: TabsOptions = {}): Promise<void> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  await CDP.Activate({ host, port, id });
}

export async function newTab(url: string = "about:blank", opts: TabsOptions = {}): Promise<TabInfo> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  const target = (await CDP.New({ host, port, url })) as any;
  return {
    id: target.id,
    type: target.type ?? "page",
    url: target.url ?? url,
    title: target.title ?? "",
  };
}

export async function closeTab(id: string, opts: TabsOptions = {}): Promise<void> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  await CDP.Close({ host, port, id });
}
