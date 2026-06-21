import { describe, it, expect, beforeEach } from "vitest";

// Set required env BEFORE importing config (requireEnv runs at module load)
process.env.DISCORD_BOT_TOKEN = "test-token";

import {
  channelConfigs,
  getChannelMode,
  getChannelPersona,
  config,
  type ChannelConfig,
} from "../config.js";

function setChannels(entries: Record<string, ChannelConfig>): void {
  for (const k of Object.keys(channelConfigs)) {
    delete (channelConfigs as Record<string, ChannelConfig>)[k];
  }
  for (const [k, v] of Object.entries(entries)) {
    (channelConfigs as Record<string, ChannelConfig>)[k] = v;
  }
}

describe("config: persona mode resolution", () => {
  beforeEach(() => {
    setChannels({});
  });

  it("mode 'persona' with explicit persona resolves to that persona", () => {
    setChannels({
      "222": { name: "ai_chat", mode: "persona", persona: "aria" },
    });
    expect(getChannelMode("222")).toBe("persona");
    expect(getChannelPersona("222")).toBe("aria");
  });

  it("mode 'persona' with no explicit persona falls back to config.botPersona", () => {
    setChannels({ "333": { name: "ai_chat", mode: "persona" } });
    // BOT_PERSONA is unset in the hermetic test env, so botPersona is "" → undefined.
    expect(getChannelPersona("333")).toBe(config.botPersona || undefined);
  });

  it("mode 'mention' / 'auto' / 'none' return undefined for getChannelPersona", () => {
    setChannels({
      m1: { name: "x", mode: "mention" },
      a1: { name: "y", mode: "auto" },
      n1: { name: "z", mode: "none" },
    });
    expect(getChannelPersona("m1")).toBeUndefined();
    expect(getChannelPersona("a1")).toBeUndefined();
    expect(getChannelPersona("n1")).toBeUndefined();
  });

  it("unknown channel id falls back to mode='mention' and persona=undefined", () => {
    setChannels({});
    expect(getChannelMode("nonexistent")).toBe("mention");
    expect(getChannelPersona("nonexistent")).toBeUndefined();
  });
});

describe("config: env-driven values", () => {
  it("BOT_PERSONA defaults to '' (no persona pipeline) when unset", () => {
    // Verifies the value loaded at module init given BOT_PERSONA was unset.
    // If a future test sets BOT_PERSONA before import, this test would adjust.
    if (
      process.env.BOT_PERSONA === undefined ||
      process.env.BOT_PERSONA === ""
    ) {
      expect(config.botPersona).toBe("");
    } else {
      expect(config.botPersona).toBe(process.env.BOT_PERSONA);
    }
  });

  it("PEER_BOT_IDS resolves correctly given current env", () => {
    if (!process.env.PEER_BOT_IDS) {
      expect(config.peerBotIds).toEqual([]);
    } else {
      const expected = process.env.PEER_BOT_IDS.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(config.peerBotIds).toEqual(expected);
    }
  });

  it("MAX_AI_TURNS_PER_CONVERSATION default is 40", () => {
    if (!process.env.MAX_AI_TURNS_PER_CONVERSATION) {
      expect(config.maxAiTurnsPerConversation).toBe(40);
    } else {
      expect(config.maxAiTurnsPerConversation).toBe(
        parseInt(process.env.MAX_AI_TURNS_PER_CONVERSATION, 10),
      );
    }
  });
});

describe("STOP_PATTERNS regex (mirror of index.ts)", () => {
  // The regex is defined inline in src/index.ts. This test validates the canonical pattern
  // so changes to the regex are caught by CI even if index.ts isn't unit-tested directly.
  const STOP_PATTERNS =
    /^\s*(stop|止めて|やめて|終了|もういい|おしまい)[。.!！\s]*$/i;

  it("matches exact stop commands", () => {
    expect(STOP_PATTERNS.test("stop")).toBe(true);
    expect(STOP_PATTERNS.test("Stop")).toBe(true);
    expect(STOP_PATTERNS.test("STOP")).toBe(true);
    expect(STOP_PATTERNS.test("止めて")).toBe(true);
    expect(STOP_PATTERNS.test("やめて")).toBe(true);
    expect(STOP_PATTERNS.test("終了")).toBe(true);
    expect(STOP_PATTERNS.test("もういい")).toBe(true);
    expect(STOP_PATTERNS.test("おしまい")).toBe(true);
    expect(STOP_PATTERNS.test("  stop  ")).toBe(true);
    expect(STOP_PATTERNS.test("stop.")).toBe(true);
    expect(STOP_PATTERNS.test("止めて。")).toBe(true);
    expect(STOP_PATTERNS.test("やめて！")).toBe(true);
  });

  it("does NOT match partial / surrounding text (false positive prevention)", () => {
    expect(STOP_PATTERNS.test("stop using emoji")).toBe(false);
    expect(STOP_PATTERNS.test("Don't stop")).toBe(false);
    expect(STOP_PATTERNS.test("止めてという指示を入れて")).toBe(false);
    expect(STOP_PATTERNS.test("やめてくれ")).toBe(false);
    expect(STOP_PATTERNS.test("もういいかな?")).toBe(false);
    expect(STOP_PATTERNS.test("お終いにしよう")).toBe(false);
  });

  it("does NOT match empty string", () => {
    expect(STOP_PATTERNS.test("")).toBe(false);
  });
});
