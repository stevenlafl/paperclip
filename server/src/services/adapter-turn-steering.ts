import type { AdapterTurnSteering } from "@paperclipai/adapter-utils";
import {
  NativeSessionSteeringError,
  type NativeSessionSteeringState,
} from "./native-runtime/native-session-executor.js";

/**
 * Same-turn steering for direct-adapter (legacy) runs. An adapter whose running
 * turn can take steered input registers it here through
 * `AdapterExecutionContext.onSteeringChange`; the queued-comment routes probe and
 * steer through it exactly as they do for native sessions. A direct run has a
 * single turn, so the run id stands in as its turn id.
 */
const adapterTurnSteering = new Map<string, AdapterTurnSteering>();

export function setAdapterTurnSteering(runId: string, steering: AdapterTurnSteering | null) {
  if (steering) adapterTurnSteering.set(runId, steering);
  else {
    adapterTurnSteering.delete(runId);
    clearSteeringDeliveries(runId);
  }
}

export async function getAdapterTurnSteeringState(runId: string): Promise<NativeSessionSteeringState> {
  const steering = adapterTurnSteering.get(runId);
  if (!steering) return { disposition: "unsupported", activeTurnId: null };
  return (await steering.isSupported())
    ? { disposition: "available", activeTurnId: runId }
    : { disposition: "unsupported", activeTurnId: null };
}

// Receipts live as long as this server process, like native steering receipts.
const steeringDeliveries = new Map<string, Promise<{ turnId: string }>>();
function clearSteeringDeliveries(runId: string) {
  for (const key of steeringDeliveries.keys())
    if (key.startsWith(`${runId}:`)) steeringDeliveries.delete(key);
}

/** Delivers a queued message into the run's current turn and resolves only once the agent took it. */
export async function steerAdapterTurn(input: {
  runId: string;
  message: string;
  correlationId: string;
  timeoutMs?: number;
  onAcknowledged?: () => Promise<void>;
}): Promise<{ turnId: string }> {
  const steering = adapterTurnSteering.get(input.runId);
  if (!steering || !(await steering.isSupported())) {
    throw new NativeSessionSteeringError(
      "steering_unsupported",
      "This agent does not support same-turn steering.",
    );
  }
  const deliveryKey = `${input.runId}:${input.correlationId}`;
  let delivery = steeringDeliveries.get(deliveryKey);
  if (!delivery) {
    delivery = steering.steer(input.message).then((outcome) => {
      if (outcome === "injected") return { turnId: input.runId };
      if (outcome === "unsupported") {
        throw new NativeSessionSteeringError(
          "steering_unsupported",
          "This agent does not support same-turn steering.",
        );
      }
      if (outcome === "failed") {
        throw new NativeSessionSteeringError(
          "steering_rejected",
          "The agent rejected the steering message.",
        );
      }
      // promptRequired, noActivePrompt, noActiveTurn, startedNewTurn: the
      // message did not reach the turn this run is executing.
      throw new NativeSessionSteeringError(
        "steering_stale_turn",
        "The target turn is no longer active.",
      );
    });
    steeringDeliveries.set(deliveryKey, delivery);
    void delivery.catch(() => {
      steeringDeliveries.delete(deliveryKey);
    });
  }
  if (input.onAcknowledged)
    void delivery.then(input.onAcknowledged).catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      delivery,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new NativeSessionSteeringError(
                "steering_timeout",
                "The agent did not acknowledge steering in time.",
              ),
            ),
          input.timeoutMs ?? 10_000,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof NativeSessionSteeringError) throw error;
    throw new NativeSessionSteeringError(
      "steering_rejected",
      "The agent rejected the steering message.",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
