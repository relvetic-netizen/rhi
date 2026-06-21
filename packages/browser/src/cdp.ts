import CDP from "chrome-remote-interface";

export interface CdpPage {
  Page: any;
  Runtime: any;
  Target: any;
  Network: any;
  Input: any;
  close: () => Promise<void>;
}

export interface ConnectOptions {
  port?: number;
  host?: string;
  target?: string;
}

export async function listTargets(opts: ConnectOptions = {}): Promise<any[]> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";
  return await CDP.List({ host, port });
}

export async function withPage<T>(
  fn: (page: CdpPage) => Promise<T>,
  opts: ConnectOptions = {},
): Promise<T> {
  const port = opts.port ?? 9222;
  const host = opts.host ?? "localhost";

  const targets = await CDP.List({ host, port });
  const pageTarget =
    targets.find((t: any) => t.id === opts.target) ??
    targets.find((t: any) => t.type === "page" && !t.url.startsWith("devtools://")) ??
    targets.find((t: any) => t.type === "page");

  if (!pageTarget) {
    throw new Error(`No page target found on CDP ${host}:${port}`);
  }

  const client = await CDP({ host, port, target: pageTarget.id });
  try {
    const { Page, Runtime, Target, Network, Input } = client;
    await Promise.all([Page.enable(), Runtime.enable()]);
    const page: CdpPage = {
      Page,
      Runtime,
      Target,
      Network,
      Input,
      close: () => client.close(),
    };
    return await fn(page);
  } finally {
    await client.close().catch(() => {});
  }
}
