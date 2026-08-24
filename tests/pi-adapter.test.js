import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function implementationReport(role = "luna", overrides = {}) {
  return {
    status: role === "sol" ? "recovered" : "success",
    completed: [],
    inspected_files: [],
    changed_files: [],
    diff_summary: "",
    changes: [],
    commands: [],
    tests: [],
    risks: [],
    current_error: null,
    decision_summary: {
      attempt_goal: "complete the assigned task",
      approach: "apply the smallest relevant change",
      reason: "selected from the current task and evidence",
      evidence: [],
      not_attempted: [],
      next_action: "validate the result",
    },
    ...(role === "sol" ? { remaining_issues: [] } : {}),
    ...overrides,
  };
}

function validatorReport(overrides = {}) {
  return {
    passed: true,
    reason: "all checks passed",
    issues: [],
    tests: [],
    current_error: null,
    ...overrides,
  };
}

function createFakePi() {
  const events = new Map();
  const tools = new Map();
  const commands = new Map();
  const sharedEvents = new Map();
  const entries = [];
  let failAppend = false;
  let agentToolPresent = true;
  const thinkingLevels = [];
  const selectedModels = [];
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    events: {
      on(name, handler) {
        const handlers = sharedEvents.get(name) ?? new Set();
        handlers.add(handler);
        sharedEvents.set(name, handlers);
        return () => handlers.delete(handler);
      },
      emit(name, data) {
        for (const handler of sharedEvents.get(name) ?? []) handler(data);
      },
    },
    appendEntry(type, data) {
      if (failAppend) throw new Error("session store unavailable");
      entries.push({ type, data });
    },
    getAllTools() { return agentToolPresent ? [{ name: "Agent" }] : []; },
    setThinkingLevel(level) { thinkingLevels.push(level); },
    async setModel(model) { selectedModels.push(model); return true; },
    async exec(command, args) { return { stdout: `${command} ${args.join(" ")}`, stderr: "", code: 0 }; },
  };
  return {
    pi, events, tools, commands, entries, thinkingLevels, selectedModels,
    emitShared(name, data) { pi.events.emit(name, data); },
    setFailAppend(value) { failAppend = value; },
    setAgentToolPresent(value) { agentToolPresent = value; },
  };
}

function commandContext(root, notifications = [], overrides = {}) {
  const available = overrides.available ?? [
    { provider: "openai", id: "gpt-5.6-luna" },
    { provider: "openai", id: "gpt-5.6-sol" },
  ];
  const widgets = overrides.widgets ?? new Map();
  return {
    cwd: root,
    mode: overrides.mode ?? "print",
    hasUI: overrides.hasUI ?? false,
    isProjectTrusted: () => true,
    model: overrides.model,
    scopedModels: overrides.scopedModels ?? [],
    modelRegistry: {
      getAvailable: () => available,
      find: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
    },
    sessionManager: overrides.sessionManager ?? {
      getBranch: () => [],
      getSessionFile: () => join(root, "session.jsonl"),
    },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      select: overrides.select ?? (async () => undefined),
      confirm: overrides.confirm ?? (async () => false),
      setWidget(name, factory, options) {
        if (factory === undefined) widgets.delete(name);
        else widgets.set(name, { factory, options });
      },
    },
    async reload() { if (overrides.reload) await overrides.reload(); },
    ...overrides.context,
  };
}

test("Pi adapter registers v2 tools and materializes Luna, Validator, and Sol", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  assert.deepEqual([...fake.events.keys()].sort(), ["before_agent_start", "message_end", "session_shutdown", "session_start", "tool_call", "tool_result", "turn_end"]);
  assert.deepEqual([...fake.tools.keys()].sort(), [
    "sol_luna_gate",
    "sol_luna_prepare_worker",
    "sol_luna_record_result",
    "sol_luna_record_usage",
    "sol_luna_validate",
  ]);
  assert.deepEqual([...fake.commands.keys()].sort(), [
    "sol-luna-init",
    "sol-luna-models",
    "sol-luna-remove",
    "sol-luna-reset",
    "sol-luna-status",
    "sol-luna-token-ui",
    "sol-luna-update",
  ]);

  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-v2-"));
  try {
    const notifications = [];
    await fake.commands.get("sol-luna-init").handler("", commandContext(root, notifications));
    const configDir = join(root, configDirName);
    const lunaAgent = readFileSync(join(configDir, "agents", "luna-worker.md"), "utf8");
    const validatorAgent = readFileSync(join(configDir, "agents", "validator-worker.md"), "utf8");
    const solAgent = readFileSync(join(configDir, "agents", "sol-worker.md"), "utf8");
    const marker = JSON.parse(readFileSync(join(configDir, "sol-luna-router.json"), "utf8"));
    const modelRoutes = JSON.parse(readFileSync(join(configDir, "sol-luna-models.json"), "utf8"));

    assert.doesNotMatch(lunaAgent, /^model:/mu);
    assert.doesNotMatch(validatorAgent, /^model:/mu);
    assert.doesNotMatch(solAgent, /^model:/mu);
    assert.doesNotMatch(lunaAgent, /^thinking:/mu);
    assert.doesNotMatch(validatorAgent, /^thinking:/mu);
    assert.doesNotMatch(solAgent, /^thinking:/mu);
    assert.match(validatorAgent, /^tools: read, grep, find, ls, sol_luna_validate$/mu);
    assert.doesNotMatch(validatorAgent.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "", /\b(?:edit|write)\b/);
    assert.equal(marker.managedMarker, "pi-sol-luna-router:managed:v2");
    assert.equal(marker.resolvedModels.validator.thinking, "low");
    assert.equal(Object.keys(marker.managedFiles).length, 3);
    assert.equal(modelRoutes.version, 2);
    assert.equal(modelRoutes.planner.mode, "inherit");
    assert.equal(notifications.at(-1).level, "success");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi runtime remains inactive when a managed worker template fails marker integrity", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-integrity-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const tampered = "tampered\n";
    writeFileSync(join(root, configDirName, "agents", "luna-worker.md"), tampered);
    const markerPath = join(root, configDirName, "sol-luna-router.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    marker.managedFiles["agents/luna-worker.md"] = sha256(tampered);
    writeFileSync(markerPath, JSON.stringify(marker));
    assert.match(
      fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, { cwd: root }).systemPrompt,
      /Integrity Failure/,
    );
    const blocked = fake.events.get("tool_call")({ toolName: "bash", input: { command: "pwd" } }, { cwd: root });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /integrity verification failed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi workflow injects only a static system prefix and uses prepared worker prompts", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-flow-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    fake.events.get("session_start")({}, { sessionManager: { getBranch: () => [] } });

    const before = fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, { cwd: root }).systemPrompt;
    const blockedBash = fake.events.get("tool_call")({ toolName: "bash", input: { command: "echo bypass > file" } }, { cwd: root });
    assert.equal(blockedBash.block, true);
    const blockedAgent = fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type: "other-agent" } }, { cwd: root });
    assert.equal(blockedAgent.block, true);
    const safeValidation = await fake.tools.get("sol_luna_validate").execute("safe", { check: "git-diff-check" }, undefined, undefined, { cwd: root });
    assert.equal(safeValidation.details.passed, true);
    await fake.tools.get("sol_luna_gate").execute("gate", {
      action: "start_task",
      task_id: "task-pi",
      task_label: "implement",
      objective: "Implement v2",
      acceptance: ["tests pass"],
      constraints: ["no API break"],
    }, undefined, undefined, commandContext(root));
    assert.equal(fake.thinkingLevels.at(-1), "high");
    await assert.rejects(
      fake.tools.get("sol_luna_gate").execute("bypass", { action: "passed" }),
      /must be recorded with sol_luna_record_result/i,
    );
    const after = fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, { cwd: root }).systemPrompt;
    assert.equal(before, after);
    assert.doesNotMatch(after, /Current gate state|task-pi/);

    const prepared = await fake.tools.get("sol_luna_prepare_worker").execute("prepare", {
      role: "luna",
      instruction: "Implement the approved task",
      complexity: "medium",
    }, undefined, undefined, commandContext(root));
    assert.equal(prepared.details.request.role, "luna");
    assert.equal(prepared.details.request.contextEnvelope.runtime.task_id, "task-pi");
    assert.equal(prepared.details.request.contextEnvelope.goal.objective, "Implement v2");
    assert.equal(prepared.details.request.budget.thinking, "medium");
    assert.equal(prepared.details.request.routing.thinking, "medium");

    const input = { subagent_type: "luna-worker", prompt: "wrong", inherit_context: true };
    const verdict = fake.events.get("tool_call")({ toolName: "Agent", input }, { cwd: root });
    assert.equal(verdict, undefined);
    assert.equal(input.prompt, prepared.details.rendered_prompt);
    assert.equal(input.model, "openai/gpt-5.6-luna");
    assert.equal(input.thinking, "medium");
    assert.equal(input.inherit_context, false);
    assert.equal(input.run_in_background, false);
    const duplicateDispatch = fake.events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "luna-worker" },
    }, { cwd: root });
    assert.equal(duplicateDispatch.block, true);
    assert.match(duplicateDispatch.reason, /already been dispatched/i);

    const recorded = await fake.tools.get("sol_luna_record_result").execute("record", {
      role: "luna",
      request_id: prepared.details.request_id,
      report_json: JSON.stringify(implementationReport("luna", {
        changed_files: ["src/a.js"],
        diff_summary: "implemented",
        changes: ["implemented"],
      })),
    });
    assert.equal(recorded.details.state.stage, "validating");
    await assert.rejects(
      fake.tools.get("sol_luna_record_result").execute("fake-validator", {
        role: "validator",
        implementation_role: "luna",
        report_json: JSON.stringify(validatorReport()),
      }),
      /prepared Validator request is required/i,
    );

    const validator = await fake.tools.get("sol_luna_prepare_worker").execute("validate", {
      role: "validator",
      instruction: "Run approved checks",
    });
    const validatorInput = { subagent_type: "validator-worker" };
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: validatorInput }, { cwd: root }), undefined);
    assert.equal(validatorInput.prompt, validator.details.rendered_prompt);

    const passed = await fake.tools.get("sol_luna_record_result").execute("record-validator", {
      role: "validator",
      implementation_role: "luna",
      request_id: validator.details.request_id,
      report_json: JSON.stringify(validatorReport()),
    });
    assert.equal(passed.details.state.phase, "passed");
    const usage = await fake.tools.get("sol_luna_record_usage").execute("usage", {
      request_id: validator.details.request_id,
      role: "validator",
      input_tokens: 1200,
      output_tokens: 200,
      latency_ms: 500,
      success: true,
      validator_mode: "fast",
      provider: "openai",
      model: "gpt-5.6-luna",
      quality: 1,
      cost: 0.01,
    });
    assert.equal(usage.details.usage_feedback.length, 1);
    assert.ok(fake.entries.length >= 6);
    assert.equal(fake.entries.at(-1).data.version, 1);
    assert.equal(fake.entries.at(-1).data.state.memory.version, "2.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi gate creates Failure Snapshots and permits one prepared Sol call", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-sol-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root);
    fake.events.get("session_start")({}, ctx);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", task_id: "sol-task", task_label: "recover" }, undefined, undefined, ctx);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const luna = await fake.tools.get("sol_luna_prepare_worker").execute(`prepare-luna-${attempt}`, {
        role: "luna",
        instruction: `Implement attempt ${attempt}`,
      });
      const lunaInput = { subagent_type: "luna-worker" };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: lunaInput }, { cwd: root }), undefined);
      fake.emitShared("subagents:started", { id: `luna-agent-${attempt}`, type: "luna-worker", description: lunaInput.description });
      fake.emitShared("subagents:completed", { id: `luna-agent-${attempt}`, type: "luna-worker", tokens: { total: 110 } });
      await fake.tools.get("sol_luna_record_result").execute(`record-luna-${attempt}`, {
        role: "luna",
        request_id: luna.details.request_id,
        report_json: JSON.stringify(implementationReport("luna", {
          completed: [`attempt ${attempt}`],
          changed_files: ["src/a.js"],
        })),
      });
      const validator = await fake.tools.get("sol_luna_prepare_worker").execute(`prepare-validator-${attempt}`, {
        role: "validator",
        instruction: `Validate attempt ${attempt}`,
      });
      const validatorInput = { subagent_type: "validator-worker" };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: validatorInput }, { cwd: root }), undefined);
      fake.emitShared("subagents:started", { id: `validator-fast-${attempt}`, type: "validator-worker", description: validatorInput.description });
      fake.emitShared("subagents:completed", { id: `validator-fast-${attempt}`, type: "validator-worker", tokens: { total: 40 } });
      await fake.tools.get("sol_luna_record_result").execute(`record-validator-${attempt}`, {
        role: "validator",
        implementation_role: "luna",
        request_id: validator.details.request_id,
        report_json: JSON.stringify(validatorReport({
          passed: false,
          reason: `fast failure ${attempt}`,
          issues: [`fast failure ${attempt}`],
          current_error: { type: "test_failure", message: `fast failure ${attempt}`, log: "failed" },
        })),
      });
      const deepValidator = await fake.tools.get("sol_luna_prepare_worker").execute(`prepare-deep-validator-${attempt}`, {
        role: "validator",
        validator_mode: "deep",
        instruction: `Deep validate attempt ${attempt}`,
      });
      const deepInput = { subagent_type: "validator-worker" };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: deepInput }, { cwd: root }), undefined);
      fake.emitShared("subagents:started", { id: `validator-deep-${attempt}`, type: "validator-worker", description: deepInput.description });
      fake.emitShared("subagents:completed", { id: `validator-deep-${attempt}`, type: "validator-worker", tokens: { total: 60 } });
      await fake.tools.get("sol_luna_record_result").execute(`record-deep-validator-${attempt}`, {
        role: "validator",
        implementation_role: "luna",
        request_id: deepValidator.details.request_id,
        report_json: JSON.stringify(validatorReport({
          passed: false,
          reason: `deep failure ${attempt}`,
          issues: [`deep failure ${attempt}`],
          current_error: { type: "test_failure", message: `deep failure ${attempt}`, log: "failed" },
        })),
      });
    }

    const prepared = await fake.tools.get("sol_luna_prepare_worker").execute("prepare-sol", {
      role: "sol",
      instruction: "Repair only affected files",
    });
    assert.equal(prepared.details.request.snapshotId !== null, true);
    assert.equal(prepared.details.request.contextEnvelope.failure.snapshot.snapshot_id, prepared.details.request.snapshotId);

    const scheduled = fake.events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker", schedule: "+5m" },
    }, { cwd: root });
    assert.equal(scheduled.block, true);
    assert.match(scheduled.reason, /Scheduled/);

    const overridden = fake.events.get("tool_call")({
      toolName: "Agent",
      input: { subagent_type: "sol-worker", model: "other/model" },
    }, { cwd: root });
    assert.equal(overridden.block, true);
    assert.match(overridden.reason, /Model overrides/);

    const input = { subagent_type: "sol-worker" };
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input }, { cwd: root }), undefined);
    assert.equal(input.prompt, prepared.details.rendered_prompt);
    fake.emitShared("subagents:started", { id: "sol-agent-1", type: "sol-worker", description: input.description });
    fake.emitShared("subagents:completed", { id: "sol-agent-1", type: "sol-worker", tokens: { total: 300 } });
    const tokenState = JSON.parse(readFileSync(join(root, configDirName, "sol-luna-ui.json"), "utf8"));
    assert.deepEqual(tokenState.tokens, { planner: 0, luna: 220, validator: 200, sol: 300 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed Agent tool results clear dispatched pending state", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-agent-failure-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    fake.events.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", task_id: "agent-failure", task_label: "agent failure" });
    await fake.tools.get("sol_luna_prepare_worker").execute("prepare", { role: "luna", instruction: "Implement" });
    const input = { subagent_type: "luna-worker" };
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: "agent-call-1", input }, { cwd: root }), undefined);
    fake.events.get("tool_result")({
      toolName: "Agent",
      toolCallId: "agent-call-1",
      isError: true,
      content: [{ type: "text", text: "worker process failed to start" }],
    }, { cwd: root });
    const status = await fake.tools.get("sol_luna_gate").execute("status", { action: "status" });
    assert.equal(status.details.state.lunaValidationFailures, 1);
    assert.equal(status.details.state.stage, "failure_snapshot");
    const retry = await fake.tools.get("sol_luna_prepare_worker").execute("retry", { role: "luna", instruction: "Retry" });
    assert.equal(retry.details.request.role, "luna");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid dispatched output becomes a failure snapshot instead of deadlocking", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-invalid-output-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    fake.events.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", task_id: "invalid", task_label: "invalid" });
    const prepared = await fake.tools.get("sol_luna_prepare_worker").execute("prepare", { role: "luna", instruction: "Implement" });
    const input = { subagent_type: "luna-worker" };
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input }, { cwd: root }), undefined);
    await assert.rejects(
      fake.tools.get("sol_luna_record_result").execute("invalid-result", {
        role: "luna",
        request_id: prepared.details.request_id,
        report_json: JSON.stringify({ status: "success" }),
      }),
      /strict JSON schema/i,
    );
    const status = await fake.tools.get("sol_luna_gate").execute("status", { action: "status" });
    assert.equal(status.details.state.lunaValidationFailures, 1);
    assert.equal(status.details.state.stage, "failure_snapshot");
    assert.equal(status.details.memory.failure.currentSnapshotId !== null, true);
    const retry = await fake.tools.get("sol_luna_prepare_worker").execute("retry", { role: "luna", instruction: "Retry" });
    assert.equal(retry.details.request.role, "luna");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi persistence failure rolls back a prepared worker request", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-rollback-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    fake.events.get("session_start")({}, { sessionManager: { getBranch: () => [] } });
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", task_id: "rollback", task_label: "rollback" });
    fake.setFailAppend(true);
    await assert.rejects(
      fake.tools.get("sol_luna_prepare_worker").execute("prepare", { role: "luna", instruction: "Implement" }),
      /session store unavailable/,
    );
    fake.setFailAppend(false);
    const blocked = fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type: "luna-worker" } }, { cwd: root });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /No prepared luna request/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy two-agent markers upgrade safely to v2", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-upgrade-"));
  try {
    const configDir = join(root, configDirName);
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const luna = "<!-- pi-sol-luna-router:managed:v1 -->\nlegacy luna\n";
    const sol = "<!-- pi-sol-luna-router:managed:v1 -->\nlegacy sol\n";
    writeFileSync(join(agentsDir, "luna-worker.md"), luna);
    writeFileSync(join(agentsDir, "sol-worker.md"), sol);
    writeFileSync(join(configDir, "sol-luna-router.json"), JSON.stringify({
      package: "pi-sol-luna-router",
      version: "0.3.0",
      managedMarker: "pi-sol-luna-router:managed:v1",
      managedFiles: {
        "agents/luna-worker.md": sha256(luna),
        "agents/sol-worker.md": sha256(sol),
      },
    }));

    await fake.commands.get("sol-luna-update").handler("", commandContext(root));
    const marker = JSON.parse(readFileSync(join(configDir, "sol-luna-router.json"), "utf8"));
    assert.equal(marker.managedMarker, "pi-sol-luna-router:managed:v2");
    assert.equal(Object.keys(marker.managedFiles).length, 3);
    assert.match(readFileSync(join(agentsDir, "validator-worker.md"), "utf8"), /Validator read-only worker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic initialization falls back to the current authenticated Pi model", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-auto-current-"));
  try {
    const current = { provider: "custom", id: "current-model", reasoning: true };
    await fake.commands.get("sol-luna-init").handler("", commandContext(root, [], {
      available: [{ provider: "other", id: "a-model", reasoning: true }, current],
      model: current,
      scopedModels: [{ model: current, thinkingLevel: "high" }],
    }));
    const configDir = join(root, configDirName);
    const routes = JSON.parse(readFileSync(join(configDir, "sol-luna-models.json"), "utf8"));
    assert.equal(routes.version, 2);
    assert.equal(`${routes.luna.candidates[0].provider}/${routes.luna.candidates[0].model}`, "custom/current-model");
    assert.equal(`${routes.validator.candidates[0].provider}/${routes.validator.candidates[0].model}`, "custom/current-model");
    assert.equal(`${routes.sol.candidates[0].provider}/${routes.sol.candidates[0].model}`, "custom/current-model");
    assert.equal(routes.planner.thinking, "high");
    assert.equal(routes.luna.thinking, "high");
    assert.equal(routes.validator.thinking, "high");
    assert.equal(routes.sol.thinking, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Sol routes must support fixed high thinking", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-sol-thinking-"));
  try {
    const configDir = join(root, configDirName);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "sol-luna-models.json"), JSON.stringify({
      version: 2,
      planner: { mode: "inherit", thinking: "high" },
      luna: { thinking: "off", candidates: [{ provider: "local", model: "plain" }] },
      validator: { thinking: "off", candidates: [{ provider: "local", model: "plain" }] },
      sol: { thinking: "high", candidates: [{ provider: "local", model: "plain" }] },
    }));
    const notifications = [];
    await fake.commands.get("sol-luna-init").handler("", commandContext(root, notifications, {
      available: [{ provider: "local", id: "plain", reasoning: false }],
    }));
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /fixed high thinking/);
    assert.throws(() => readFileSync(join(configDir, "sol-luna-router.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit routes cannot select models outside the current Pi scope", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-scoped-routes-"));
  try {
    const configDir = join(root, configDirName);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "sol-luna-models.json"), JSON.stringify({
      version: 2,
      planner: { mode: "inherit", thinking: "high" },
      luna: { thinking: "medium", candidates: [{ provider: "openai", model: "outside" }] },
      validator: { thinking: "low", candidates: [{ provider: "openai", model: "outside" }] },
      sol: { thinking: "high", candidates: [{ provider: "openai", model: "outside" }] },
    }));
    const notifications = [];
    const available = [
      { provider: "openai", id: "inside", reasoning: true },
      { provider: "openai", id: "outside", reasoning: true },
    ];
    await fake.commands.get("sol-luna-init").handler("", commandContext(root, notifications, {
      available,
      scopedModels: [{ model: available[0], thinkingLevel: "medium" }],
    }));
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /No available model route/);
    assert.throws(() => readFileSync(join(configDir, "sol-luna-router.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit route files remain strict and are not rewritten by init or update", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-explicit-routes-"));
  try {
    const configDir = join(root, configDirName);
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  "version": 1,\n  "luna": { "thinking": "medium", "candidates": [{ "provider": "openai", "model": "gpt-5.6-luna" }] },\n  "sol": { "thinking": "high", "candidates": [{ "provider": "openai", "model": "gpt-5.6-sol" }] }\n}\n';
    writeFileSync(join(configDir, "sol-luna-models.json"), original);
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    assert.equal(readFileSync(join(configDir, "sol-luna-models.json"), "utf8"), original);
    await fake.commands.get("sol-luna-update").handler("", commandContext(root));
    assert.equal(readFileSync(join(configDir, "sol-luna-models.json"), "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi model command supports status, auto replacement, and explicit set without JSON editing", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-model-command-"));
  try {
    const notifications = [];
    const available = [
      { provider: "openai", id: "general", reasoning: true },
      { provider: "openai", id: "validator", reasoning: true },
      { provider: "openai", id: "recovery", reasoning: true },
    ];
    const ctx = commandContext(root, notifications, { available, model: available[0] });
    await fake.commands.get("sol-luna-models").handler("auto", ctx);
    let routes = JSON.parse(readFileSync(join(root, configDirName, "sol-luna-models.json"), "utf8"));
    assert.equal(routes.version, 2);
    await fake.commands.get("sol-luna-models").handler("status", ctx);
    assert.match(notifications.at(-1).message, /Route source:/);

    await fake.commands.get("sol-luna-models").handler(
      "set --planner-mode inherit --luna openai/general --validator openai/validator --sol openai/recovery --luna-thinking medium --validator-thinking low --force",
      ctx,
    );
    routes = JSON.parse(readFileSync(join(root, configDirName, "sol-luna-models.json"), "utf8"));
    assert.equal(routes.luna.candidates[0].model, "general");
    assert.equal(routes.validator.candidates[0].model, "validator");
    assert.equal(routes.sol.candidates[0].model, "recovery");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interactive Pi model configuration writes selected explicit routes", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-model-wizard-"));
  try {
    const available = [
      { provider: "openai", id: "one", reasoning: true },
      { provider: "openai", id: "two", reasoning: true },
      { provider: "openai", id: "three", reasoning: true },
    ];
    const answers = [
      "inherit current Pi model", "high",
      "openai/one", "medium",
      "openai/two", "low",
      "openai/three",
    ];
    const ctx = commandContext(root, [], {
      available,
      model: available[0],
      hasUI: true,
      select: async () => answers.shift(),
      confirm: async () => true,
    });
    await fake.commands.get("sol-luna-models").handler("", ctx);
    const routes = JSON.parse(readFileSync(join(root, configDirName, "sol-luna-models.json"), "utf8"));
    assert.equal(routes.planner.mode, "inherit");
    assert.equal(routes.luna.candidates[0].model, "one");
    assert.equal(routes.validator.candidates[0].model, "two");
    assert.equal(routes.sol.candidates[0].model, "three");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project token UI is opt-in, right-aligned, persistent, and isolated by project", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const firstRoot = mkdtempSync(join(tmpdir(), "sol-luna-token-ui-a-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "sol-luna-token-ui-b-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(firstRoot));
    const notifications = [];
    const widgets = new Map();
    const ctx = commandContext(firstRoot, notifications, { mode: "tui", hasUI: true, widgets });
    fake.events.get("session_start")({}, ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);

    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    const widget = widgets.get("sol-luna-token-ui");
    assert.equal(widget.options.placement, "belowEditor");
    const component = widget.factory({ requestRender() {} });
    const rendered = component.render(60)[0];
    assert.equal(rendered.length, 60);
    assert.equal(rendered.trim(), "P(0%),L(0%),V(0%),S(0%)");

    const plannerMessage = {
      role: "assistant",
      provider: "openai",
      model: "planner",
      responseId: "planner-start",
      timestamp: 123,
      stopReason: "toolUse",
      usage: { input: 100, output: 20, cacheWrite: 5, cacheRead: 100_000 },
      content: [{
        type: "toolCall",
        id: "start-call",
        name: "sol_luna_gate",
        arguments: { action: "start_task" },
      }],
    };
    fake.events.get("message_end")({ message: plannerMessage }, ctx);
    await fake.tools.get("sol_luna_gate").execute("start-call", {
      action: "start_task",
      task_id: "project-token-task",
      objective: "Track project tokens",
    }, undefined, undefined, ctx);
    fake.events.get("turn_end")({ message: plannerMessage }, ctx);
    fake.events.get("message_end")({ message: plannerMessage }, ctx);
    fake.events.get("turn_end")({ message: plannerMessage }, ctx);

    let state = JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-ui.json"), "utf8"));
    assert.equal(state.visible, true);
    assert.equal(state.tokens.planner, 125);
    assert.equal(state.seen.plannerMessages.length, 1);

    await fake.commands.get("sol-luna-token-ui").handler("off", ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);
    const nextPlannerMessage = {
      ...plannerMessage,
      responseId: "planner-next",
      timestamp: 124,
      content: [],
      usage: { input: 20, output: 5, cacheWrite: 0, cacheRead: 50_000 },
    };
    fake.events.get("message_end")({ message: nextPlannerMessage }, ctx);
    fake.events.get("turn_end")({ message: nextPlannerMessage }, ctx);
    state = JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-ui.json"), "utf8"));
    assert.equal(state.tokens.planner, 150);

    const secondNotifications = [];
    const secondCtx = commandContext(secondRoot, secondNotifications);
    await fake.commands.get("sol-luna-token-ui").handler("status", secondCtx);
    assert.match(secondNotifications.at(-1).message, /P=0, L=0, V=0, S=0/);

    await fake.commands.get("sol-luna-token-ui").handler("reset", ctx);
    state = JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-ui.json"), "utf8"));
    assert.deepEqual(state.tokens, { planner: 0, luna: 0, validator: 0, sol: 0 });
    assert.equal(state.visible, false);
    assert.equal(state.seen.plannerMessages.length, 2);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("project token UI refuses untrusted writes and symlinked project configuration", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-token-security-"));
  const target = mkdtempSync(join(tmpdir(), "sol-luna-token-target-"));
  try {
    const notifications = [];
    const untrusted = commandContext(root, notifications, {
      context: { isProjectTrusted: () => false },
    });
    await fake.commands.get("sol-luna-token-ui").handler("on", untrusted);
    assert.equal(notifications.at(-1).level, "error");
    assert.throws(() => readFileSync(join(root, configDirName, "sol-luna-ui.json"), "utf8"), /ENOENT/);

    const configDir = join(root, configDirName);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "sol-luna-ui.json"), "{invalid json\n");
    const trusted = commandContext(root, notifications);
    await fake.commands.get("sol-luna-token-ui").handler("reset", trusted);
    assert.equal(notifications.at(-1).level, "success");
    assert.match(notifications.at(-1).message, /repaired the malformed project token file/i);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "sol-luna-ui.json"), "utf8")).tokens, {
      planner: 0, luna: 0, validator: 0, sol: 0,
    });

    rmSync(configDir, { recursive: true, force: true });
    symlinkSync(target, configDir);
    await fake.commands.get("sol-luna-token-ui").handler("on", trusted);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /unsafe project configuration directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("managed worker lifecycle events add project-local token totals exactly once", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-token-worker-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root);
    fake.events.get("session_start")({}, ctx);
    await fake.tools.get("sol_luna_gate").execute("start", {
      action: "start_task",
      task_id: "worker-token-task",
      objective: "Track worker tokens",
    }, undefined, undefined, ctx);
    const prepared = await fake.tools.get("sol_luna_prepare_worker").execute("prepare", {
      role: "luna",
      instruction: "Implement token tracking",
    }, undefined, undefined, ctx);
    const input = { subagent_type: "luna-worker" };
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: "agent-luna", input }, ctx), undefined);

    fake.emitShared("subagents:started", { id: "unmanaged-luna", type: "luna-worker", description: "unmanaged same-role worker" });
    fake.emitShared("subagents:completed", {
      id: "unmanaged-luna",
      type: "luna-worker",
      tokens: { total: 9999 },
    });
    fake.emitShared("subagents:started", { id: "worker-luna-1", type: "luna-worker", description: input.description });
    fake.emitShared("subagents:failed", {
      id: "worker-luna-1",
      type: "luna-worker",
      usage: { input: 200, output: 30, cacheWrite: 10, cacheRead: 9999 },
    });
    fake.emitShared("subagents:failed", {
      id: "worker-luna-1",
      type: "luna-worker",
      usage: { input: 200, output: 30, cacheWrite: 10, cacheRead: 9999 },
    });
    fake.emitShared("subagents:completed", {
      id: "unmanaged",
      type: "general-purpose",
      usage: { input: 999, output: 999, cacheWrite: 999 },
    });
    fake.events.get("tool_result")({
      toolName: "Agent",
      toolCallId: "agent-luna",
      isError: false,
      content: [{ type: "text", text: "completed" }],
    }, ctx);

    const state = JSON.parse(readFileSync(join(root, configDirName, "sol-luna-ui.json"), "utf8"));
    assert.equal(state.tokens.luna, 240);
    assert.equal(state.seen.workerRuns.length, 1);
    assert.equal(state.visible, false);
    assert.equal(prepared.details.request.role, "luna");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization reports unavailable model routes without writing files", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pi-model-missing-"));
  try {
    const notifications = [];
    let reloads = 0;
    await fake.commands.get("sol-luna-init").handler("", {
      ...commandContext(root, notifications),
      modelRegistry: { getAvailable: () => [] },
      async reload() { reloads += 1; },
    });
    assert.equal(reloads, 0);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /No authenticated models are available/);
    assert.throws(() => readFileSync(join(root, configDirName, "sol-luna-models.json"), "utf8"), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
