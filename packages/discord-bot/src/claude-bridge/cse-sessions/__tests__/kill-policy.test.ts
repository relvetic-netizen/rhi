import { describe, it, expect } from "vitest";
import { canKill, type KillContext } from "../kill-policy.js";

const baseCtx: KillContext = {
  botPid: 1000,
  registryPids: [2000, 2001],
  cseSessionPids: [3000, 3001],
};

describe("canKill", () => {
  it("denies bot self-kill", () => {
    const d = canKill(1000, baseCtx);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/self-kill/);
  });

  it("allows registry PID with kind=registry", () => {
    const d = canKill(2000, baseCtx);
    expect(d).toEqual({ allowed: true, kind: "registry" });
  });

  it("allows cse PID with kind=cse", () => {
    const d = canKill(3000, baseCtx);
    expect(d).toEqual({ allowed: true, kind: "cse" });
  });

  it("denies unknown PID", () => {
    const d = canKill(9999, baseCtx);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toMatch(/該当しない/);
  });

  it("registry takes precedence when PID appears in both", () => {
    const ctx: KillContext = {
      botPid: 1000,
      registryPids: [5000],
      cseSessionPids: [5000],
    };
    const d = canKill(5000, ctx);
    expect(d).toEqual({ allowed: true, kind: "registry" });
  });

  it("rejects non-integer PID", () => {
    const d = canKill(NaN, baseCtx);
    expect(d.allowed).toBe(false);
  });

  it("rejects zero or negative PID", () => {
    expect(canKill(0, baseCtx).allowed).toBe(false);
    expect(canKill(-1, baseCtx).allowed).toBe(false);
  });

  it("self-kill check takes precedence over registry membership", () => {
    const ctx: KillContext = {
      botPid: 7000,
      registryPids: [7000],
      cseSessionPids: [],
    };
    const d = canKill(7000, ctx);
    expect(d.allowed).toBe(false);
  });
});
