import fs from "fs";
import os from "os";
import path from "path";
import type { PersonaConfig, PersonaName } from "./types.js";

function homeJoin(...parts: string[]): string {
  return path.join(os.homedir(), ...parts);
}

/** Subset of {@link PersonaConfig} a config file may specify. All fields are optional —
 *  anything omitted is derived generically from the persona name + home dir. */
export interface PersonaConfigInput {
  name: string;
  vesselDir?: string;
  soulDir?: string;
  discordWakePath?: string;
  env?: Record<string, string>;
  additionalDirs?: string[];
  sessionStateDir?: string;
}

interface PersonaConfigFile {
  personas: PersonaConfigInput[];
}

/** Build a full PersonaConfig from a (possibly partial) input.
 *  The directory layout (vesselDir/soulDir/etc.) is derived generically from the
 *  persona name and the user's home dir, so no per-name layout is hardcoded. */
export function buildPersona(input: PersonaConfigInput): PersonaConfig {
  const name = input.name;
  const vesselDir = input.vesselDir ?? homeJoin(".claude", "relvetia", name);
  const soulDir = input.soulDir ?? homeJoin(".claude", "memory", name);
  return {
    name,
    vesselDir,
    soulDir,
    discordWakePath:
      input.discordWakePath ??
      path.join(vesselDir, "prompts", "discord-wake.md"),
    env: input.env ?? { [`RELVETIA_INCLUDE_${name.toUpperCase()}`]: "1" },
    // additionalDirs are intentionally scoped to this persona only: each persona
    // gets its OWN memory dir plus the shared roots, never another persona's
    // memory dir. This keeps personas' read/write surfaces isolated from one another.
    additionalDirs: input.additionalDirs ?? [
      homeJoin(".claude"),
      homeJoin(".claude", "memory"),
      soulDir,
      homeJoin(".claude", "relvetia"),
      homeJoin("workspace"),
      "/tmp",
    ],
    sessionStateDir:
      input.sessionStateDir ??
      path.join(vesselDir, "state", "discord-sessions"),
  };
}

/** Resolve the persona config file path: env `RHI_PERSONA_CONFIG` wins, else the
 *  package-local (gitignored, user-supplied) `persona.config.json`. */
function resolveConfigPath(): string {
  if (process.env.RHI_PERSONA_CONFIG) return process.env.RHI_PERSONA_CONFIG;
  return path.resolve(__dirname, "..", "..", "persona.config.json");
}

function loadPersonas(): Record<PersonaName, PersonaConfig> {
  const out: Record<PersonaName, PersonaConfig> = {};
  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    // No config file — ship NO built-in persona identities. Tests inject via __testing.
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as PersonaConfigFile;
    for (const input of parsed.personas ?? []) {
      if (!input?.name) continue;
      out[input.name] = buildPersona(input);
    }
  } catch (err) {
    console.error(
      `[persona-registry] Failed to parse ${configPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  return out;
}

let PERSONAS: Record<PersonaName, PersonaConfig> = loadPersonas();

export function getPersona(name: PersonaName): PersonaConfig | null {
  return PERSONAS[name] ?? null;
}

export function requirePersona(name: PersonaName): PersonaConfig {
  const persona = PERSONAS[name];
  if (!persona) {
    throw new Error(
      `Unknown persona: ${name}. Known: ${Object.keys(PERSONAS).join(", ")}`,
    );
  }
  return persona;
}

export function knownPersonas(): PersonaName[] {
  return Object.keys(PERSONAS);
}

export const __testing = {
  get PERSONAS() {
    return PERSONAS;
  },
  /** Replace the in-memory persona registry (test-only injection). */
  setPersonas(personas: Record<PersonaName, PersonaConfig>): void {
    PERSONAS = personas;
  },
  /** Register persona(s) from partial input(s), deriving the dir layout generically. */
  registerPersonas(inputs: PersonaConfigInput[]): void {
    for (const input of inputs) {
      PERSONAS[input.name] = buildPersona(input);
    }
  },
  /** Reload from the resolved config file (env or package-local). */
  reload(): void {
    PERSONAS = loadPersonas();
  },
  buildPersona,
};
