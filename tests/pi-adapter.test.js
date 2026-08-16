import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let piModule;
let configDirName;
let loadError;
try {
  [piModule, { CONFIG_DIR_NAME: configDirName }] = await Promise.all([
    import("../src/adapters/pi.js"),
    import("@earendil-works/pi-coding-agent"),
  ]);
} catch (error) {
  loadError = error;
}

const skipWithoutPiPeers = loadError ? `Pi peer dependencies unavailable: ${loadError.message}` : false;

test("Pi adapter keeps command registration and Sol-start persistence compatible", { skip: skipWithoutPiPeers }, async () => {
  const events = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  let failAppend = false;
  let agentToolPresent = false;
  const pi = {
    on(name, handler) {
      events.set(name, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    appendEntry(type, data) {
      if (failAppend) throw new Error("session store unavailable");
      entries.push({ type, data });
    },
    getAllTools() {
      return agentToolPresent ? [{ name: "Agent" }] : [];
    },
  };

  piModule.createPiAdapter(pi);
  assert.deepEqual([...events.keys()].sort(), ["before_agent_start", "session_start", "tool_call"]);
  assert.deepEqual([...tools.keys()], ["sol_luna_gate"]);
  assert.deepEqual([...commands.keys()].sort(), [
    "sol-luna-init",
    "sol-luna-remove",
    "sol-luna-reset",
    "sol-luna-status",
    "sol-luna-update",
  ]);

  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-adapter-"));
  try {
    const agents = join(root, configDirName, "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(root, configDirName, "sol-luna-router.json"), "{}\n");
    writeFileSync(join(agents, "luna-worker.md"), "luna\n");
    writeFileSync(join(agents, "sol-worker.md"), "sol\n");

    events.get("session_start")({}, {
      sessionManager: {
        getBranch: () => [{
          type: "custom",
          customType: "pi-sol-luna-router/state",
          data: {
            version: 1,
            state: {
              phase: "open",
              lunaValidationFailures: 2,
              solAttempted: false,
            },
          },
        }],
      },
    });

    const scheduled = events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker", schedule: "+5m" },
    }, { cwd: root });
    assert.equal(scheduled.block, true);
    assert.match(scheduled.reason, /Scheduled Sol\/Luna worker calls are blocked/);
    assert.equal(entries.length, 0);

    const overridden = events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker", model: "other/model" },
    }, { cwd: root });
    assert.equal(overridden.block, true);
    assert.match(overridden.reason, /Model overrides are blocked/);
    assert.equal(entries.length, 0);

    failAppend = true;
    const failedPersistence = events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker" },
    }, { cwd: root });
    assert.equal(failedPersistence.block, true);
    assert.match(failedPersistence.reason, /session store unavailable/);
    assert.equal(entries.length, 0);

    failAppend = false;
    const verdict = events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker" },
    }, { cwd: root });
    assert.equal(verdict, undefined);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, "pi-sol-luna-router/state");
    assert.equal(entries[0].data.version, 1);
    assert.equal(entries[0].data.state.phase, "sol-recovery");
    assert.equal(entries[0].data.state.solAttempted, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const initRoot = mkdtempSync(join(tmpdir(), "sol-luna-pi-model-route-"));
  try {
    agentToolPresent = true;
    let reloads = 0;
    const notifications = [];
    await commands.get("sol-luna-init").handler("", {
      cwd: initRoot,
      hasUI: false,
      isProjectTrusted: () => true,
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai", id: "gpt-5.6-luna" },
          { provider: "openai", id: "gpt-5.6-sol" },
        ],
      },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      async reload() {
        reloads += 1;
      },
    });

    const configDir = join(initRoot, configDirName);
    const lunaAgent = readFileSync(join(configDir, "agents", "luna-worker.md"), "utf8");
    const solAgent = readFileSync(join(configDir, "agents", "sol-worker.md"), "utf8");
    const marker = JSON.parse(readFileSync(join(configDir, "sol-luna-router.json"), "utf8"));
    const modelRoutes = JSON.parse(readFileSync(join(configDir, "sol-luna-models.json"), "utf8"));

    assert.match(lunaAgent, /model: "openai\/gpt-5\.6-luna"/);
    assert.match(solAgent, /model: "openai\/gpt-5\.6-sol"/);
    assert.doesNotMatch(lunaAgent, /__SOL_LUNA_MODEL__/);
    assert.equal(marker.resolvedModels.luna.provider, "openai");
    assert.equal(marker.resolvedModels.sol.provider, "openai");
    assert.equal(modelRoutes.luna.candidates[0].provider, "cliproxyapi");
    assert.equal(reloads, 1);
    assert.equal(notifications.at(-1).level, "success");
  } finally {
    rmSync(initRoot, { recursive: true, force: true });
  }

  const missingRoot = mkdtempSync(join(tmpdir(), "sol-luna-pi-model-missing-"));
  try {
    let reloads = 0;
    const notifications = [];
    await commands.get("sol-luna-init").handler("", {
      cwd: missingRoot,
      hasUI: false,
      isProjectTrusted: () => true,
      modelRegistry: { getAvailable: () => [] },
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
      async reload() {
        reloads += 1;
      },
    });
    assert.equal(reloads, 0);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /Create or edit/);
    assert.throws(
      () => readFileSync(join(missingRoot, configDirName, "sol-luna-models.json"), "utf8"),
      /ENOENT/,
    );
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});
