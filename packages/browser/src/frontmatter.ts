export interface Frontmatter {
  data: Record<string, string>;
  body: string;
  raw: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { data: {}, body: content, raw: "" };
  }
  const raw = match[1];
  const body = match[2] ?? "";
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) data[key] = value;
  }
  return { data, body, raw };
}

export function stringifyFrontmatter(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

export function ensureFrontmatter(
  content: string,
  defaults: Record<string, string>,
): string {
  const parsed = parseFrontmatter(content);
  const merged: Record<string, string> = { ...defaults, ...parsed.data };
  for (const key of Object.keys(defaults)) {
    if (!(key in parsed.data)) merged[key] = defaults[key];
  }
  return stringifyFrontmatter(merged, parsed.body);
}
