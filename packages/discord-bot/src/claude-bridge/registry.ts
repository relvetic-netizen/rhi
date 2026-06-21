import fs from "fs";
import path from "path";

export interface ClaudeEntry {
  name: string;
  pid: number;
  cwd: string;
  startedAt: string;
}

export class ClaudeRegistry {
  constructor(private readonly registryPath: string) {}

  list(): ClaudeEntry[] {
    try {
      const raw = fs.readFileSync(this.registryPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed as ClaudeEntry[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  add(entry: ClaudeEntry): void {
    const entries = this.list();
    if (entries.some((e) => e.name === entry.name)) {
      throw new Error(`Claude "${entry.name}" already in registry`);
    }
    entries.push(entry);
    this.write(entries);
  }

  remove(pid: number): void {
    const entries = this.list().filter((e) => e.pid !== pid);
    this.write(entries);
  }

  clear(): void {
    this.write([]);
  }

  private write(entries: ClaudeEntry[]): void {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    fs.writeFileSync(this.registryPath, JSON.stringify(entries, null, 2));
  }
}

export function defaultRegistryPath(): string {
  return path.resolve(__dirname, "..", "..", "claudes", "registry.json");
}
