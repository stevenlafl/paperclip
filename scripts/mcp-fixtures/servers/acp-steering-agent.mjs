#!/usr/bin/env node
// A minimal ACP agent fixture that advertises the `_session/steering`
// extension (as claude-agent-acp and codex-acp do) and holds each prompt open
// until steered input arrives, then echoes that input and ends the turn. Used to
// prove that the patched acpx delivers steered input into the running turn.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const waitingPrompts = new Map();

async function handleRequest(request) {
  if (request.method === "initialize") {
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-steering-agent", version: "1.0.0" },
      _meta: { steering: { supported: true } },
    };
  }
  if (request.method === "session/new") return { sessionId: randomUUID() };
  if (request.method === "session/prompt") {
    const sessionId = request.params.sessionId;
    const steered = await new Promise((resolve) => {
      waitingPrompts.set(sessionId, resolve);
      setTimeout(() => resolve(null), 10_000);
    });
    waitingPrompts.delete(sessionId);
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: steered === null ? "not steered" : `steered: ${steered}` },
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (request.method === "_session/steering") {
    const resolve = waitingPrompts.get(request.params.sessionId);
    if (!resolve) return { outcome: "promptRequired", reason: "noRunningTurn" };
    resolve(request.params.prompt.map((block) => block.text ?? "").join(""));
    return { outcome: "injected" };
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});
