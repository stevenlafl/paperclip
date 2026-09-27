import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";

// Drives a REAL acpx runtime against a fixture agent that advertises the
// `_session/steering` extension. `steer` and `isSteeringSupported` come from
// patches/acpx@0.12.0.patch: steered input must reach the running turn, and
// input sent when no turn is running must not start one.

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const fixturePath = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-steering-agent.mjs");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function startSteerableSession() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acpx-steering-"));
  tempRoots.push(root);
  const agentCommand = `${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(fixturePath.replaceAll("\\", "/"))}`;
  const runtime = createAcpRuntime({
    cwd: root,
    sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
    agentRegistry: createAgentRegistry({ overrides: { custom: agentCommand } }),
    permissionMode: "approve-all",
    nonInteractivePermissions: "deny",
  });
  const handle = await runtime.ensureSession({
    sessionKey: "steering-smoke",
    agent: "custom",
    mode: "persistent",
    cwd: root,
  });
  return { runtime, handle };
}

it("delivers steered input into the running turn through _session/steering", async () => {
  const { runtime, handle } = await startSteerableSession();
  try {
    const turn = runtime.startTurn({ handle, text: "wait for guidance", mode: "prompt", requestId: "turn-1" });
    const text: string[] = [];
    const drained = (async () => {
      for await (const event of turn.events) if (event.type === "text_delta") text.push(event.text);
    })();

    let outcome = "";
    for (let attempt = 0; attempt < 100 && outcome !== "injected"; attempt += 1) {
      if (await runtime.isSteeringSupported({ handle })) {
        outcome = (await runtime.steer({ handle, text: "use the other fixture" })).outcome;
      }
      if (outcome !== "injected") await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(outcome).toBe("injected");
    expect(await turn.result).toMatchObject({ status: "completed" });
    await drained;
    expect(text.join("")).toBe("steered: use the other fixture");
    expect((await runtime.steer({ handle, text: "too late" })).outcome).toMatch(/^no(ActivePrompt|ActiveTurn)$/);
  } finally {
    await runtime.close({ handle, reason: "done" }).catch(() => {});
  }
});
