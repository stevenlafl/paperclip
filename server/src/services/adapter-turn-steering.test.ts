import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterSteeringOutcome, AdapterTurnSteering } from "@paperclipai/adapter-utils";
import {
  getAdapterTurnSteeringState,
  setAdapterTurnSteering,
  steerAdapterTurn,
} from "./adapter-turn-steering.js";

function turnSteering(outcome: AdapterSteeringOutcome, supported = true) {
  const steer = vi.fn(async () => outcome);
  const steering: AdapterTurnSteering = { isSupported: async () => supported, steer };
  return { steering, steer };
}

afterEach(() => {
  for (const runId of ["run-1", "run-2"]) setAdapterTurnSteering(runId, null);
});

describe("direct-adapter turn steering", () => {
  it("reports availability only while a supporting turn is registered", async () => {
    expect(await getAdapterTurnSteeringState("run-1")).toEqual({ disposition: "unsupported", activeTurnId: null });
    setAdapterTurnSteering("run-1", turnSteering("injected").steering);
    expect(await getAdapterTurnSteeringState("run-1")).toEqual({ disposition: "available", activeTurnId: "run-1" });
    setAdapterTurnSteering("run-2", turnSteering("injected", false).steering);
    expect((await getAdapterTurnSteeringState("run-2")).disposition).toBe("unsupported");
    setAdapterTurnSteering("run-1", null);
    expect((await getAdapterTurnSteeringState("run-1")).disposition).toBe("unsupported");
  });

  it("acknowledges an injected message once and delivers a retry only once", async () => {
    const { steering, steer } = turnSteering("injected");
    setAdapterTurnSteering("run-1", steering);
    const onAcknowledged = vi.fn(async () => {});
    const input = { runId: "run-1", message: "use the other fixture", correlationId: "comment-1", onAcknowledged };
    expect(await steerAdapterTurn(input)).toEqual({ turnId: "run-1" });
    expect(await steerAdapterTurn(input)).toEqual({ turnId: "run-1" });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith("use the other fixture");
  });

  it.each([
    ["noActivePrompt", "steering_stale_turn"],
    ["noActiveTurn", "steering_stale_turn"],
    ["promptRequired", "steering_stale_turn"],
    ["startedNewTurn", "steering_stale_turn"],
    ["failed", "steering_rejected"],
    ["unsupported", "steering_unsupported"],
  ] as const)("treats %s as not delivered (%s)", async (outcome, code) => {
    setAdapterTurnSteering("run-1", turnSteering(outcome).steering);
    await expect(steerAdapterTurn({ runId: "run-1", message: "x", correlationId: `c-${outcome}` }))
      .rejects.toMatchObject({ name: "NativeSessionSteeringError", code });
  });

  it("refuses a run without registered steering and times out an unanswered one", async () => {
    await expect(steerAdapterTurn({ runId: "run-2", message: "x", correlationId: "c-none" }))
      .rejects.toMatchObject({ code: "steering_unsupported" });
    setAdapterTurnSteering("run-1", {
      isSupported: async () => true,
      steer: () => new Promise<AdapterSteeringOutcome>(() => {}),
    });
    await expect(steerAdapterTurn({ runId: "run-1", message: "x", correlationId: "c-slow", timeoutMs: 20 }))
      .rejects.toMatchObject({ code: "steering_timeout" });
  });
});
