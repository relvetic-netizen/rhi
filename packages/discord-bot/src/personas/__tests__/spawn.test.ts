import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";

// Prevent spawning actual claude subprocess in unit tests.
vi.mock("../../claude/subprocess.js", () => {
  return {
    ClaudeSubprocess: class MockSubprocess {
      alive = true;
      sessionId = "";
      setSessionId(id: string) {
        this.sessionId = id;
      }
      async start(_opts?: unknown) {
        /* noop */
      }
      async sendUserMessage(_content: string) {
        /* noop */
      }
      kill() {
        this.alive = false;
      }
      on(_event: string, _fn: unknown) {
        // no-op listener registration
      }
    },
  };
});

vi.mock("../../config.js", () => ({
  config: {
    claudeModel: "claude-sonnet-4-6",
    defaultWorkingDir: process.cwd(),
  },
  notionDatabaseIds: {},
}));

import {
  ensureSession,
  killSession,
  getSession,
  getLiveSessionCount,
  destroyAllSessions,
  sendUserMessage,
  getTurnCount,
  writeStopTombstone,
  isStopTombstoned,
  clearStopTombstone,
  __testing,
} from "../spawn.js";
import {
  requirePersona,
  knownPersonas,
  __testing as registryTesting,
} from "../registry.js";

// Inject two neutral, clearly-fictional personas for the test suite. Their dir
// layout is derived generically from the name (vesselDir, soulDir, env, etc.).
registryTesting.setPersonas({});
registryTesting.registerPersonas([{ name: "aria" }, { name: "nova" }]);

const ARIA = requirePersona("aria");
const NOVA = requirePersona("nova");

async function cleanStateDir(stateDir: string) {
  try {
    const files = await fs.readdir(stateDir);
    for (const f of files) {
      if (f.startsWith("G_TEST")) {
        await fs.unlink(path.join(stateDir, f)).catch(() => undefined);
      }
    }
  } catch {
    /* dir may not exist yet */
  }
}

describe("personas/spawn", () => {
  beforeEach(async () => {
    destroyAllSessions();
    await cleanStateDir(ARIA.sessionStateDir);
    await cleanStateDir(NOVA.sessionStateDir);
  });
  afterEach(async () => {
    destroyAllSessions();
    await cleanStateDir(ARIA.sessionStateDir);
    await cleanStateDir(NOVA.sessionStateDir);
  });

  for (const personaName of ["aria", "nova"] as const) {
    describe(`persona=${personaName}`, () => {
      const persona = requirePersona(personaName);

      it("ensureSession creates a new handle for an unseen guild", async () => {
        const handle = await ensureSession(persona, "G_TEST_1");
        expect(handle.persona).toBe(personaName);
        expect(handle.guildKey).toBe("G_TEST_1");
        expect(handle.subprocess).toBeDefined();
        expect(handle.turnCount).toBe(0);
      });

      it("ensureSession reuses an alive session", async () => {
        const h1 = await ensureSession(persona, "G_TEST_2");
        const h2 = await ensureSession(persona, "G_TEST_2");
        expect(h1).toBe(h2);
      });

      it("ensureSession recreates after killSession", async () => {
        const h1 = await ensureSession(persona, "G_TEST_3");
        killSession(personaName, "G_TEST_3");
        expect(getSession(personaName, "G_TEST_3")).toBeUndefined();
        const h2 = await ensureSession(persona, "G_TEST_3");
        expect(h2).not.toBe(h1);
        expect(h2.turnCount).toBe(0); // counter reset on recreate
      });

      it("persists sessionId atomically when captured from init message", async () => {
        await ensureSession(persona, "G_TEST_4");
        await __testing.writeSpawnState(persona, "G_TEST_4", {
          sessionId: "sess-abc-123",
          lastActivity: Date.now(),
        });
        const persisted = await __testing.readSpawnState(persona, "G_TEST_4");
        expect(persisted?.sessionId).toBe("sess-abc-123");
        killSession(personaName, "G_TEST_4");
        const stillThere = await __testing.readSpawnState(persona, "G_TEST_4");
        expect(stillThere?.sessionId).toBe("sess-abc-123");
      });

      it("reads prior sessionId from disk and preseeds subprocess", async () => {
        await __testing.writeSpawnState(persona, "G_TEST_5", {
          sessionId: "resume-sess-xyz",
          lastActivity: Date.now(),
        });
        const handle = await ensureSession(persona, "G_TEST_5");
        expect(
          (handle.subprocess as unknown as { sessionId: string }).sessionId,
        ).toBe("resume-sess-xyz");
      });

      it("DM guildKey is handled by file-name sanitizer", async () => {
        const dmKey = "DM:user-with-id_12345";
        await ensureSession(persona, dmKey);
        const statePath = __testing.stateFilePath(persona, dmKey);
        expect(statePath).toContain("DM_user-with-id_12345");
      });

      it("sendUserMessage increments turnCount", async () => {
        await sendUserMessage(persona, "G_TEST_6", "hi");
        expect(getTurnCount(personaName, "G_TEST_6")).toBe(1);
        await sendUserMessage(persona, "G_TEST_6", "hi 2");
        expect(getTurnCount(personaName, "G_TEST_6")).toBe(2);
      });
    });
  }

  it("session keys are persona-isolated (aria vs nova on same guild)", async () => {
    await ensureSession(ARIA, "G_SAME");
    await ensureSession(NOVA, "G_SAME");
    expect(getLiveSessionCount()).toBe(2);
    expect(getSession("aria", "G_SAME")).toBeDefined();
    expect(getSession("nova", "G_SAME")).toBeDefined();
    killSession("aria", "G_SAME");
    expect(getSession("aria", "G_SAME")).toBeUndefined();
    expect(getSession("nova", "G_SAME")).toBeDefined();
  });

  it("destroyAllSessions clears live map across personas", async () => {
    await ensureSession(ARIA, "G_TEST_A");
    await ensureSession(NOVA, "G_TEST_B");
    expect(getLiveSessionCount()).toBe(2);
    destroyAllSessions();
    expect(getLiveSessionCount()).toBe(0);
  });

  it("registry exposes both injected personas", () => {
    const names = knownPersonas();
    expect(names).toContain("aria");
    expect(names).toContain("nova");
  });

  it("personas have distinct vesselDir, soulDir, env, sessionStateDir", () => {
    expect(ARIA.vesselDir).not.toBe(NOVA.vesselDir);
    expect(ARIA.soulDir).not.toBe(NOVA.soulDir);
    expect(ARIA.sessionStateDir).not.toBe(NOVA.sessionStateDir);
    expect(ARIA.env.RELVETIA_INCLUDE_ARIA).toBe("1");
    expect(NOVA.env.RELVETIA_INCLUDE_NOVA).toBe("1");
    // A persona does NOT auto-include another persona's include-flag in its env.
    expect(NOVA.env.RELVETIA_INCLUDE_ARIA).toBeUndefined();
  });

  it("persona additionalDirs do not include another persona's memory dir", () => {
    const novaDirs = NOVA.additionalDirs;
    const ariaSoul = ARIA.soulDir;
    expect(novaDirs).not.toContain(ariaSoul);
  });

  describe("stop tombstone", () => {
    const guildKey = "G_TOMB";

    it("writeStopTombstone creates a tombstone file", async () => {
      await writeStopTombstone(ARIA, guildKey);
      expect(await isStopTombstoned(ARIA, guildKey)).toBe(true);
      await clearStopTombstone(ARIA, guildKey);
    });

    it("isStopTombstoned returns false when no tombstone", async () => {
      await clearStopTombstone(ARIA, "G_NEVER_STOPPED");
      expect(await isStopTombstoned(ARIA, "G_NEVER_STOPPED")).toBe(false);
    });

    it("isStopTombstoned auto-clears stale tombstones (older than TTL)", async () => {
      await writeStopTombstone(ARIA, guildKey);
      const future = Date.now() + __testing.STOP_TOMBSTONE_TTL_MS + 1000;
      expect(await isStopTombstoned(ARIA, guildKey, future)).toBe(false);
      // After auto-clear, file should be gone — second check returns false too
      expect(await isStopTombstoned(ARIA, guildKey)).toBe(false);
    });

    it("tombstones are persona-isolated", async () => {
      await writeStopTombstone(ARIA, guildKey);
      expect(await isStopTombstoned(ARIA, guildKey)).toBe(true);
      expect(await isStopTombstoned(NOVA, guildKey)).toBe(false);
      await clearStopTombstone(ARIA, guildKey);
    });

    it("clearStopTombstone is idempotent", async () => {
      await clearStopTombstone(ARIA, "G_NOPE");
      await clearStopTombstone(ARIA, "G_NOPE"); // should not throw
    });
  });
});
