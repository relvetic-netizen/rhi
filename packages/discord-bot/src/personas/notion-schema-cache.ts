import { notionDatabaseIds } from "../config.js";

const NOTION_VERSION = "2022-06-28";
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export interface NotionPropertySchema {
  name: string;
  type: string;
  description?: string;
}

export interface NotionSchema {
  id: string;
  title: string;
  properties: Record<string, NotionPropertySchema>;
  fetchedAt: number;
}

const cache = new Map<string, NotionSchema>();

/** Clear cache. Pass a schema name (e.g. "accounting") or DS id to evict a single entry;
 *  call with no arg to clear all. */
export function invalidate(target?: string): void {
  if (!target) {
    cache.clear();
    return;
  }
  if (cache.has(target)) {
    cache.delete(target);
    return;
  }
  for (const [name, sch] of cache.entries()) {
    if (sch.id === target) cache.delete(name);
  }
}

let autoInvalidateOnWrite = true;

/** Toggle the auto-invalidation behavior (default: true). Useful for tests. */
export function setAutoInvalidateOnWrite(enabled: boolean): void {
  autoInvalidateOnWrite = enabled;
}

export function isAutoInvalidateOnWrite(): boolean {
  return autoInvalidateOnWrite;
}

/** Call from Notion write callsites (notion-create-pages / notion-update-page /
 *  notion-update-data-source / notion-move-pages) immediately after the write
 *  succeeds. When autoInvalidateOnWrite is enabled, the cached schema for the
 *  affected DS is evicted so the next getSchemas() refetches latest. Write
 *  failures must NOT call this (no rollback handling here). */
export function notifyWrite(
  dsIdOrName: string,
  opts?: { autoInvalidateOnWrite?: boolean }
): void {
  const enabled = opts?.autoInvalidateOnWrite ?? autoInvalidateOnWrite;
  if (!enabled) return;
  if (!dsIdOrName) return;
  invalidate(dsIdOrName);
}

export async function getSchemas(now: number = Date.now()): Promise<Record<string, NotionSchema>> {
  const apiKey = process.env.NOTION_API_KEY;
  const out: Record<string, NotionSchema> = {};
  if (!apiKey) {
    console.warn("[notion-cache] NOTION_API_KEY not set — schemas unavailable");
    return out;
  }
  for (const [name, id] of Object.entries(notionDatabaseIds)) {
    if (!id) continue;
    const cached = cache.get(name);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      out[name] = cached;
      continue;
    }
    const fresh = await fetchSchema(name, id, apiKey, now);
    if (fresh) {
      cache.set(name, fresh);
      out[name] = fresh;
    } else if (cached) {
      // Notion fetch failed — serve stale copy but flag it so downstream knows.
      console.warn(
        `[notion-cache] serving stale schema for ${name} (age=${Math.round((now - cached.fetchedAt) / 1000)}s)`
      );
      out[name] = cached;
    }
  }
  return out;
}

export function getSchemaNames(schemas: Record<string, NotionSchema>): string[] {
  return Object.keys(schemas);
}

export function serializeForFirstMessage(schemas: Record<string, NotionSchema>): string {
  const entries = Object.entries(schemas);
  if (entries.length === 0) return "";
  const lines: string[] = ["<notion_schemas>"];
  for (const [name, sch] of entries) {
    lines.push(`### ${name}${sch.title && sch.title !== name ? ` (${sch.title})` : ""}`);
    lines.push(`data_source_id: ${sch.id}`);
    lines.push(`properties:`);
    for (const [propName, prop] of Object.entries(sch.properties)) {
      const desc = prop.description ? ` — ${prop.description}` : "";
      lines.push(`  - ${propName} (${prop.type})${desc}`);
    }
    lines.push("");
  }
  lines.push("</notion_schemas>");
  return lines.join("\n");
}

async function fetchSchema(
  name: string,
  id: string,
  apiKey: string,
  now: number
): Promise<NotionSchema | null> {
  const endpoints = [
    `https://api.notion.com/v1/data_sources/${id}`,
    `https://api.notion.com/v1/databases/${id}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Notion-Version": NOTION_VERSION,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 404 && url.includes("data_sources")) continue;
      if (!res.ok) {
        console.warn(`[notion-cache] skip ${name}: ${res.status}`);
        return null;
      }
      const data = (await res.json()) as {
        id?: string;
        title?: Array<{ plain_text?: string }>;
        properties?: Record<string, unknown>;
      };
      return {
        id: data.id ?? id,
        title: extractTitle(data.title),
        properties: extractProperties(data.properties ?? {}),
        fetchedAt: now,
      };
    } catch (err) {
      console.warn(`[notion-cache] error ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  return null;
}

function extractTitle(raw: Array<{ plain_text?: string }> | undefined): string {
  if (!raw || !Array.isArray(raw)) return "";
  return raw.map((t) => t.plain_text ?? "").join("").trim();
}

function extractProperties(
  raw: Record<string, unknown>
): Record<string, NotionPropertySchema> {
  const out: Record<string, NotionPropertySchema> = {};
  for (const [key, val] of Object.entries(raw)) {
    const prop = val as Record<string, unknown>;
    const type = typeof prop.type === "string" ? prop.type : "unknown";
    const description = extractPropDescription(prop, type);
    out[key] = {
      name: typeof prop.name === "string" ? prop.name : key,
      type,
      description,
    };
  }
  return out;
}

function extractPropDescription(
  prop: Record<string, unknown>,
  type: string
): string | undefined {
  if (type === "status" || type === "select") {
    const body = prop[type] as { options?: Array<{ name?: string }> } | undefined;
    const names = body?.options?.map((o) => o.name).filter((n): n is string => !!n) ?? [];
    if (names.length > 0) return `options: ${names.join(" / ")}`;
  }
  if (type === "multi_select") {
    const body = prop.multi_select as { options?: Array<{ name?: string }> } | undefined;
    const names = body?.options?.map((o) => o.name).filter((n): n is string => !!n) ?? [];
    if (names.length > 0) return `tags: ${names.join(" / ")}`;
  }
  if (type === "relation") {
    const body = prop.relation as
      | { database_id?: string; data_source_id?: string }
      | undefined;
    const target = body?.data_source_id ?? body?.database_id;
    if (target) return `relation → ${target}`;
  }
  return undefined;
}
