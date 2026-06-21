import { describe, it, expect } from "vitest";
import { Status, type Client } from "discord.js";

import { buildClientReadyProbe } from "../client-ready-probe.js";

function clientWith(ws: { status?: Status; ping?: number } | undefined): Client {
  return { ws } as unknown as Client;
}

describe("buildClientReadyProbe", () => {
  it("returns false when ws manager is missing", () => {
    expect(buildClientReadyProbe(clientWith(undefined))()).toBe(false);
  });

  it("returns false while connecting (status != Ready)", () => {
    expect(
      buildClientReadyProbe(clientWith({ status: Status.Connecting, ping: -1 }))()
    ).toBe(false);
  });

  it("returns false during reconnect (status != Ready)", () => {
    expect(
      buildClientReadyProbe(clientWith({ status: Status.Reconnecting, ping: 50 }))()
    ).toBe(false);
  });

  it("returns false when Ready but no heartbeat yet (ping < 0)", () => {
    // discord.js exposes ping as -1 while no shard is connected or no
    // heartbeat has completed. /health must not advertise readiness then.
    expect(
      buildClientReadyProbe(clientWith({ status: Status.Ready, ping: -1 }))()
    ).toBe(false);
  });

  it("returns true only when Ready AND ping >= 0", () => {
    expect(buildClientReadyProbe(clientWith({ status: Status.Ready, ping: 0 }))()).toBe(
      true
    );
    expect(buildClientReadyProbe(clientWith({ status: Status.Ready, ping: 75 }))()).toBe(
      true
    );
  });

  it("returns false when ping is not a number (defensive)", () => {
    expect(
      buildClientReadyProbe(
        clientWith({ status: Status.Ready, ping: undefined as unknown as number })
      )()
    ).toBe(false);
  });
});
