import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
  const missingOptionalPeer = error?.code === "ERR_MODULE_NOT_FOUND"
    && /Cannot find package '(?:@earendil-works\/pi-coding-agent|@earendil-works\/pi-ai|typebox)'/.test(error.message);
  if (!missingOptionalPeer || process.env.SOL_LUNA_REQUIRE_PI_PEERS === "1") throw error;
  loadError = error;
}

const skipWithoutPiPeers = loadError ? `Pi peer dependencies unavailable: ${loadError.message}` : false;
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

test("safe validation rejects intermediate directory symlinks before reading or executing", { skip: skipWithoutPiPeers }, async () => {
  const root = mkdtempSync(join(tmpdir(), "sol-luna-validation-"));
  const outside = mkdtempSync(join(tmpdir(), "sol-luna-outside-"));
  try {
    const fake = createFakePi();
    piModule.default(fake.pi);
    const ctx = commandContext(root);
    const validate = fake.tools.get("sol_luna_validate");
    writeFileSync(join(outside, "secret.json"), "{}");
    writeFileSync(join(outside, "script.js"), "const a = 1;");
    symlinkSync(outside, join(root, "escape"), "dir");
    for (const [check, path] of [["json-check", "escape/secret.json"], ["node-check", "escape/script.js"]]) {
      await assert.rejects(validate.execute("check", { check, path }, undefined, undefined, ctx), /symbolic link|inside the current project/);
    }
    mkdirSync(join(root, "..valid"));
    writeFileSync(join(root, "..valid", "local.json"), "{}");
    const valid = await validate.execute("check", { check: "json-check", path: "..valid/local.json" }, undefined, undefined, ctx);
    assert.equal(valid.details.passed, true);
    await assert.rejects(validate.execute("check", { check: "json-check", path: "../other.json" }, undefined, undefined, ctx), /inside the current project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

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

function createFakePi({ typesafeAvailable = false } = {}) {
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
    getAllTools() { return [...(agentToolPresent ? [{ name: "Agent" }] : []), ...(typesafeAvailable ? [{ name: "typesafe_evaluate" }] : [])]; },
    setThinkingLevel(level) { thinkingLevels.push(level); },
    async setModel(model) { selectedModels.push(model); return true; },
    async exec(command, args) { return { stdout: `${command} ${args.join(" ")}`, stderr: "", code: 0 }; },
  };
  return {
    pi, events, tools, commands, entries, thinkingLevels, selectedModels,
    emitShared(name, data) { pi.events.emit(name, data); },
    setFailAppend(value) { failAppend = value; },
    setAgentToolPresent(value) { agentToolPresent = value; },
    setTypeSafeAvailable(value) { typesafeAvailable = value; },
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
        if (overrides.setWidget) return overrides.setWidget(name, factory, options);
        if (factory === undefined) widgets.delete(name);
        else widgets.set(name, { factory, options });
      },
    },
    async reload() { if (overrides.reload) await overrides.reload(); },
    ...overrides.context,
  };
}

function createFakeScheduler() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    pendingCount() { return pending.size; },
    pendingDelays() { return [...pending.values()].map(({ delay }) => delay); },
    pendingCallbacks() { return [...pending.values()].map(({ callback }) => callback); },
    runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [id, task] = entry;
      pending.delete(id);
      task.callback();
      return true;
    },
    runAll(limit = 100) {
      let count = 0;
      while (pending.size > 0) {
        assert.ok(count < limit, "fake timer queue did not settle");
        this.runNext();
        count += 1;
      }
      return count;
    },
  };
}

function createFakeWatch() {
  const records = [];
  const watch = (path, options, callback) => {
    const record = {
      path,
      options,
      callback,
      closed: false,
      handlers: new Map(),
    };
    records.push(record);
    return {
      close() { record.closed = true; },
      on(name, handler) { record.handlers.set(name, handler); return this; },
    };
  };
  return { watch, records };
}

function createWidgetRegistry() {
  const widgets = new Map();
  const calls = [];
  let renderRequests = 0;
  return {
    widgets,
    calls,
    get renderRequests() { return renderRequests; },
    setWidget(name, factory, options) {
      calls.push({ name, factory, options });
      if (factory === undefined) {
        widgets.delete(name);
        return;
      }
      const component = factory({ requestRender() { renderRequests += 1; } });
      widgets.set(name, { factory, options, component });
    },
    installs(name = "sol-luna-token-ui") {
      return calls.filter((call) => call.name === name && call.factory !== undefined).length;
    },
    clears(name = "sol-luna-token-ui") {
      return calls.filter((call) => call.name === name && call.factory === undefined).length;
    },
  };
}

function tokenUiFile(root) {
  return join(root, configDirName, "sol-luna-ui.json");
}

function runtimeFile(root) {
  return join(root, configDirName, "sol-luna-runtime.json");
}

test("Pi adapter registers v2 tools and materializes Luna, Validator, and Sol", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  assert.deepEqual([...fake.events.keys()].sort(), ["agent_settled", "before_agent_start", "message_end", "session_shutdown", "session_start", "tool_call", "tool_result", "turn_end"]);
  assert.deepEqual([...fake.tools.keys()].sort(), [
    "sol_luna_gate",
    "sol_luna_prepare_worker",
    "sol_luna_record_result",
    "sol_luna_record_usage",
    "sol_luna_route",
    "sol_luna_validate",
  ]);
  assert.deepEqual([...fake.commands.keys()].sort(), [
    "sol-luna-disable",
    "sol-luna-enable",
    "sol-luna-init",
    "sol-luna-jev",
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

test("project-local pause persists, isolates projects, preserves state, and gates only Sol-Luna tools", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const firstRoot = mkdtempSync(join(tmpdir(), "sol-luna-pause-a-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "sol-luna-pause-b-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(firstRoot));
    await fake.commands.get("sol-luna-init").handler("", commandContext(secondRoot));
    const widgets = new Map();
    const ctx = commandContext(firstRoot, [], { mode: "tui", hasUI: true, widgets });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    const beforeEntries = fake.entries.length;
    const markerBefore = readFileSync(join(firstRoot, configDirName, "sol-luna-router.json"), "utf8");
    const prompt = fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt;
    assert.match(prompt, /Host Orchestration Protocol/);

    await fake.commands.get("sol-luna-disable").handler("", ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-runtime.json"), "utf8")), { version: 1, paused: true });
    assert.equal(readFileSync(join(firstRoot, configDirName, "sol-luna-router.json"), "utf8"), markerBefore);
    assert.equal(fake.entries.length, beforeEntries);
    assert.equal(widgets.has("sol-luna-token-ui"), false);
    assert.equal(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "bash", input: {} }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type: "unrelated-worker" } }, ctx), undefined);
    const pausedManaged = fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type: "luna-worker" } }, ctx);
    assert.equal(pausedManaged.block, true);
    assert.match(pausedManaged.reason, /paused/i);
    const blocked = fake.events.get("tool_call")({ toolName: "sol_luna_gate", input: {} }, ctx);
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /paused/i);

    const pausedMessage = { role: "assistant", responseId: "paused", timestamp: 1, usage: { input: 100, output: 20 } };
    fake.events.get("message_end")({ message: pausedMessage }, ctx);
    fake.events.get("turn_end")({ message: pausedMessage }, ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-ui.json"), "utf8")).tokens, {
      planner: 0, luna: 0, validator: 0, sol: 0,
    });

    await fake.commands.get("sol-luna-enable").handler("", ctx);
    assert.deepEqual(JSON.parse(readFileSync(join(firstRoot, configDirName, "sol-luna-runtime.json"), "utf8")), { version: 1, paused: false });
    assert.equal(widgets.has("sol-luna-token-ui"), true);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /Host Orchestration Protocol/);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    const secondNotifications = [];
    const secondCtx = commandContext(secondRoot, secondNotifications, { mode: "tui", hasUI: true, widgets: new Map() });
    fake.events.get("session_start")({}, secondCtx);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, secondCtx).systemPrompt, /Host Orchestration Protocol/);
    assert.equal(fake.events.get("tool_call")({ toolName: "sol_luna_gate", input: {} }, secondCtx), undefined);
    await fake.commands.get("sol-luna-status").handler("", commandContext(firstRoot, secondNotifications));
    assert.match(secondNotifications.at(-1).message, /Runtime: paused/);
    await fake.commands.get("sol-luna-status").handler("", secondCtx);
    assert.match(secondNotifications.at(-1).message, /Runtime: active/);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("token UI commands preserve paused state and never re-show the widget", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pause-token-ui-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const widgets = new Map();
    const ctx = commandContext(root, [], { mode: "tui", hasUI: true, widgets });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), true);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);
    await fake.commands.get("sol-luna-token-ui").handler("reset", ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, configDirName, "sol-luna-runtime.json"), "utf8")), { version: 1, paused: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid runtime fails closed for Sol-Luna tools and managed Agents only", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-runtime-invalid-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const widgets = new Map();
    const ctx = commandContext(root, [], { mode: "tui", hasUI: true, widgets });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    await fake.tools.get("sol_luna_gate").execute("invalid-runtime-start", {
      action: "start_task",
      task_id: "invalid-runtime",
      task_label: "invalid runtime gating",
    }, undefined, undefined, ctx);
    await fake.tools.get("sol_luna_prepare_worker").execute("invalid-runtime-prepare", {
      role: "luna",
      instruction: "This prepared dispatch must not run after runtime corruption.",
    }, undefined, undefined, ctx);
    writeFileSync(join(root, configDirName, "sol-luna-runtime.json"), "{broken\\n");
    fake.events.get("message_end")({ message: { role: "assistant", responseId: "invalid-runtime" } }, ctx);
    assert.equal(widgets.has("sol-luna-token-ui"), false);

    for (const toolName of ["read", "edit", "write", "bash"]) {
      assert.equal(fake.events.get("tool_call")({ toolName, input: {} }, ctx), undefined);
    }
    assert.equal(fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type: "unrelated-worker" } }, ctx), undefined);

    for (const subagent_type of ["luna-worker", "validator-worker", "sol-worker"]) {
      const blocked = fake.events.get("tool_call")({ toolName: "Agent", input: { subagent_type } }, ctx);
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /invalid|unsafe/i);
    }
    for (const toolName of fake.tools.keys()) {
      const blocked = fake.events.get("tool_call")({ toolName, input: {} }, ctx);
      assert.equal(blocked.block, true);
      assert.match(blocked.reason, /invalid|unsafe/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project watcher refresh targets handle unnamed, runtime, and token events", { skip: skipWithoutPiPeers }, () => {
  assert.deepEqual(piModule.projectWatchRefreshTargets(null), { runtime: true, tokenUi: true });
  assert.deepEqual(piModule.projectWatchRefreshTargets(undefined), { runtime: true, tokenUi: true });
  assert.deepEqual(piModule.projectWatchRefreshTargets(""), { runtime: true, tokenUi: true });
  assert.deepEqual(piModule.projectWatchRefreshTargets("sol-luna-runtime.json"), { runtime: true, tokenUi: false });
  assert.deepEqual(piModule.projectWatchRefreshTargets("sol-luna-ui.json"), { runtime: false, tokenUi: true });
  assert.deepEqual(piModule.projectWatchRefreshTargets("settings.json"), { runtime: false, tokenUi: false });
});

test("project watcher schedules only requested refresh targets", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  const scheduler = createFakeScheduler();
  const watched = createFakeWatch();
  piModule.createPiAdapter(fake.pi, {
    watch: watched.watch,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  const root = mkdtempSync(join(tmpdir(), "sol-luna-watch-targets-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root, [], { mode: "tui", hasUI: true });
    fake.events.get("session_start")({}, ctx);
    const watcher = watched.records.at(-1);

    watcher.callback("rename", "sol-luna-runtime.json");
    assert.equal(scheduler.pendingCount(), 1);
    assert.deepEqual(scheduler.pendingDelays(), [75]);
    scheduler.runAll();

    watcher.callback("change", "sol-luna-ui.json");
    assert.equal(scheduler.pendingCount(), 1);
    assert.deepEqual(scheduler.pendingDelays(), [75]);
    scheduler.runAll();

    watcher.callback("rename", undefined);
    assert.equal(scheduler.pendingCount(), 2);
    assert.deepEqual(scheduler.pendingDelays().sort((a, b) => a - b), [75, 75]);
    scheduler.runAll();

    watcher.callback("change", "settings.json");
    assert.equal(scheduler.pendingCount(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("token watcher grace preserves replacements then hides stable deletion and malformed state", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  const scheduler = createFakeScheduler();
  const watched = createFakeWatch();
  const registry = createWidgetRegistry();
  const notifications = [];
  piModule.createPiAdapter(fake.pi, {
    watch: watched.watch,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  const root = mkdtempSync(join(tmpdir(), "sol-luna-token-watch-grace-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root, notifications, {
      mode: "tui",
      hasUI: true,
      setWidget: registry.setWidget.bind(registry),
    });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    assert.equal(registry.widgets.has("sol-luna-token-ui"), true);
    const initialInstalls = registry.installs();

    let watcher = watched.records.at(-1);
    const replacement = readFileSync(tokenUiFile(root), "utf8");
    unlinkSync(tokenUiFile(root));
    watcher.callback("rename", "sol-luna-ui.json");
    scheduler.runNext();
    assert.equal(registry.widgets.has("sol-luna-token-ui"), true);
    assert.equal(scheduler.pendingCount(), 1);
    writeFileSync(tokenUiFile(root), replacement);
    scheduler.runAll();
    assert.equal(registry.widgets.has("sol-luna-token-ui"), true);
    assert.equal(registry.installs(), initialInstalls);

    unlinkSync(tokenUiFile(root));
    watcher.callback("rename", "sol-luna-ui.json");
    scheduler.runAll();
    assert.equal(registry.widgets.has("sol-luna-token-ui"), false);

    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    watcher = watched.records.at(-1);
    writeFileSync(tokenUiFile(root), "{malformed\n");
    watcher.callback("change", "sol-luna-ui.json");
    scheduler.runAll();
    assert.equal(registry.widgets.has("sol-luna-token-ui"), false);
    assert.equal(notifications.some(({ level, message }) => level === "warning" && /invalid json/i.test(message)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime watcher never re-shows paused state during replacement and activates after stable deletion", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  const scheduler = createFakeScheduler();
  const watched = createFakeWatch();
  const registry = createWidgetRegistry();
  piModule.createPiAdapter(fake.pi, {
    watch: watched.watch,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  const root = mkdtempSync(join(tmpdir(), "sol-luna-runtime-watch-grace-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root, [], {
      mode: "tui",
      hasUI: true,
      setWidget: registry.setWidget.bind(registry),
    });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    assert.equal(registry.widgets.has("sol-luna-token-ui"), false);

    let watcher = watched.records.at(-1);
    unlinkSync(runtimeFile(root));
    watcher.callback("rename", "sol-luna-runtime.json");
    scheduler.runNext();
    assert.equal(registry.widgets.has("sol-luna-token-ui"), false);
    writeFileSync(runtimeFile(root), `${JSON.stringify({ version: 1, paused: true })}\n`);
    while (scheduler.runNext()) assert.equal(registry.widgets.has("sol-luna-token-ui"), false);

    unlinkSync(runtimeFile(root));
    watcher.callback("rename", "sol-luna-runtime.json");
    let becameVisible = false;
    while (scheduler.runNext()) {
      if (registry.widgets.has("sol-luna-token-ui")) becameVisible = true;
      if (scheduler.pendingCount() > 0) assert.equal(registry.widgets.has("sol-luna-token-ui"), false);
    }
    assert.equal(becameVisible, true);
    assert.equal(registry.widgets.has("sol-luna-token-ui"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("widget ownership reuses normal registration and agent_settled repairs a stale registry once", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  const scheduler = createFakeScheduler();
  const watched = createFakeWatch();
  const registry = createWidgetRegistry();
  piModule.createPiAdapter(fake.pi, {
    watch: watched.watch,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  const root = mkdtempSync(join(tmpdir(), "sol-luna-widget-ownership-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(root));
    const ctx = commandContext(root, [], {
      mode: "tui",
      hasUI: true,
      setWidget: registry.setWidget.bind(registry),
    });
    fake.events.get("session_start")({}, ctx);
    await fake.commands.get("sol-luna-token-ui").handler("on", ctx);
    const installed = registry.installs();
    const state = JSON.parse(readFileSync(tokenUiFile(root), "utf8"));
    state.tokens.planner = 25;
    writeFileSync(tokenUiFile(root), `${JSON.stringify(state)}\n`);
    watched.records.at(-1).callback("change", "sol-luna-ui.json");
    scheduler.runAll();
    assert.equal(registry.installs(), installed);
    assert.ok(registry.renderRequests > 0);

    registry.widgets.clear();
    fake.events.get("agent_settled")({}, ctx);
    assert.equal(registry.installs(), installed + 1);
    assert.equal(registry.widgets.size, 1);
    assert.equal(registry.widgets.has("sol-luna-token-ui"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session switch and shutdown close watchers, cancel timers, and reject stale callbacks", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  const scheduler = createFakeScheduler();
  const watched = createFakeWatch();
  const registry = createWidgetRegistry();
  piModule.createPiAdapter(fake.pi, {
    watch: watched.watch,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });
  const firstRoot = mkdtempSync(join(tmpdir(), "sol-luna-watch-switch-a-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "sol-luna-watch-switch-b-"));
  try {
    await fake.commands.get("sol-luna-init").handler("", commandContext(firstRoot));
    await fake.commands.get("sol-luna-init").handler("", commandContext(secondRoot));
    const visibleState = {
      version: 1,
      visible: true,
      tokens: { planner: 0, luna: 0, validator: 0, sol: 0 },
      seen: { plannerMessages: [], workerRuns: [] },
    };
    writeFileSync(tokenUiFile(firstRoot), `${JSON.stringify(visibleState)}\n`);
    writeFileSync(tokenUiFile(secondRoot), `${JSON.stringify(visibleState)}\n`);
    const firstCtx = commandContext(firstRoot, [], {
      mode: "tui",
      hasUI: true,
      setWidget: registry.setWidget.bind(registry),
    });
    const secondCtx = commandContext(secondRoot, [], {
      mode: "tui",
      hasUI: true,
      setWidget: registry.setWidget.bind(registry),
    });
    fake.events.get("session_start")({}, firstCtx);
    const firstWatcher = watched.records.at(-1);
    unlinkSync(tokenUiFile(firstRoot));
    firstWatcher.callback("rename", "sol-luna-ui.json");
    scheduler.runNext();
    const staleRetry = scheduler.pendingCallbacks()[0];
    assert.equal(typeof staleRetry, "function");

    fake.events.get("session_start")({}, secondCtx);
    const secondWatcher = watched.records.at(-1);
    assert.equal(firstWatcher.closed, true);
    assert.equal(scheduler.pendingCount(), 0);
    const installsAfterSwitch = registry.installs();
    const secondBefore = readFileSync(tokenUiFile(secondRoot), "utf8");
    firstWatcher.callback("rename", undefined);
    staleRetry();
    assert.equal(scheduler.pendingCount(), 0);
    assert.equal(registry.installs(), installsAfterSwitch);
    assert.equal(readFileSync(tokenUiFile(secondRoot), "utf8"), secondBefore);

    secondWatcher.callback("rename", "sol-luna-ui.json");
    assert.equal(scheduler.pendingCount(), 1);
    const staleShutdown = scheduler.pendingCallbacks()[0];
    fake.events.get("session_shutdown")({}, secondCtx);
    assert.equal(secondWatcher.closed, true);
    assert.equal(scheduler.pendingCount(), 0);
    staleShutdown();
    secondWatcher.callback("rename", undefined);
    assert.equal(scheduler.pendingCount(), 0);
    assert.equal(registry.widgets.has("sol-luna-token-ui"), false);
  } finally {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  }
});

test("pause enable repairs malformed regular runtime state and rejects unsafe paths", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pause-security-"));
  const target = mkdtempSync(join(tmpdir(), "sol-luna-pause-target-"));
  try {
    const configDir = join(root, configDirName);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "sol-luna-runtime.json"), "{broken\\n");
    const notifications = [];
    const ctx = commandContext(root, notifications);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    assert.equal(notifications.at(-1).level, "error");
    await fake.commands.get("sol-luna-enable").handler("", ctx);
    assert.equal(notifications.at(-1).level, "success");
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "sol-luna-runtime.json"), "utf8")), { version: 1, paused: false });
    rmSync(configDir, { recursive: true, force: true });
    symlinkSync(target, configDir);
    await fake.commands.get("sol-luna-enable").handler("", ctx);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /unsafe project configuration directory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("pause state persists across adapter reloads and rejects future-version and symlink runtime files", { skip: skipWithoutPiPeers }, async () => {
  const first = createFakePi();
  piModule.createPiAdapter(first.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-runtime-reload-"));
  const target = mkdtempSync(join(tmpdir(), "sol-luna-runtime-target-"));
  try {
    await first.commands.get("sol-luna-init").handler("", commandContext(root));
    const firstCtx = commandContext(root);
    await first.commands.get("sol-luna-disable").handler("", firstCtx);

    const second = createFakePi();
    piModule.createPiAdapter(second.pi);
    const secondCtx = commandContext(root);
    second.events.get("session_start")({}, secondCtx);
    assert.equal(second.events.get("before_agent_start")({ systemPrompt: "BASE" }, secondCtx), undefined);
    assert.equal(second.events.get("tool_call")({ toolName: "sol_luna_gate", input: {} }, secondCtx).block, true);

    writeFileSync(join(root, configDirName, "sol-luna-runtime.json"), JSON.stringify({ version: 99, paused: false }));
    const futureNotifications = [];
    await second.commands.get("sol-luna-status").handler("", commandContext(root, futureNotifications));
    assert.match(futureNotifications.at(-1).message, /Runtime: invalid/);
    assert.equal(second.events.get("tool_call")({ toolName: "sol_luna_gate", input: {} }, secondCtx).block, true);

    rmSync(join(root, configDirName, "sol-luna-runtime.json"));
    symlinkSync(join(target, "runtime.json"), join(root, configDirName, "sol-luna-runtime.json"));
    const symlinkBlocked = second.events.get("tool_call")({ toolName: "sol_luna_gate", input: {} }, secondCtx);
    assert.equal(symlinkBlocked.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
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

test("runtime integrity distinguishes an absent installation from incomplete or incompatible managed files", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi(); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-integrity-contract-"));
  try {
    const ctx = commandContext(root);
    const call = () => fake.events.get("tool_call")({ toolName: "bash", input: { command: "pwd" } }, ctx);
    assert.equal(call(), undefined);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    assert.doesNotMatch(call().reason, /integrity verification failed/i);
    const markerPath = join(root, configDirName, "sol-luna-router.json");
    const original = readFileSync(markerPath, "utf8");
    const marker = JSON.parse(original);
    for (const invalid of [
      null,
      { ...marker, version: "incompatible" },
      { ...marker, managedMarker: "pi-sol-luna-router:managed:v1" },
      { ...marker, managedFiles: { ...marker.managedFiles, "agents/luna-worker.md": "0".repeat(64) } },
    ]) {
      writeFileSync(markerPath, JSON.stringify(invalid));
      assert.equal(call().block, true);
      assert.match(call().reason, /integrity verification failed/i);
    }
    writeFileSync(markerPath, original);
    unlinkSync(join(root, configDirName, "agents", "validator-worker.md"));
    assert.match(call().reason, /integrity verification failed/i);
    unlinkSync(markerPath);
    assert.match(call().reason, /integrity verification failed/i);
    rmSync(join(root, configDirName), { recursive: true, force: true });
    assert.equal(call(), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test("init, update, remove, and reset preserve the project pause file", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi();
  piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-pause-lifecycle-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    const runtimePath = join(root, configDirName, "sol-luna-runtime.json");
    const paused = readFileSync(runtimePath, "utf8");
    await fake.commands.get("sol-luna-update").handler("", ctx);
    assert.equal(readFileSync(runtimePath, "utf8"), paused);
    await fake.commands.get("sol-luna-reset").handler("", ctx);
    assert.equal(readFileSync(runtimePath, "utf8"), paused);
    await fake.commands.get("sol-luna-remove").handler("", ctx);
    assert.equal(readFileSync(runtimePath, "utf8"), paused);
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

test("project Jev opt-out persists across reloads without changing other projects or pause state", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-preference-"));
  const other = mkdtempSync(join(tmpdir(), "sol-luna-jev-other-"));
  try {
    const notifications = [];
    const ctx = commandContext(root, notifications);
    const otherCtx = commandContext(other);
    for (const context of [ctx, otherCtx]) await fake.commands.get("sol-luna-init").handler("", context);
    const command = fake.commands.get("sol-luna-jev");
    assert.deepEqual(command.getArgumentCompletions("of"), [{ value: "off", label: "off" }]);
    const preference = join(root, configDirName, "sol-luna-jev.json");
    await command.handler("off", ctx);
    assert.deepEqual(JSON.parse(readFileSync(preference, "utf8")), { version: 1, enabled: false });
    assert.throws(() => readFileSync(runtimeFile(root)), /ENOENT/);
    const route = (params, context = ctx) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, context);
    const disabled = await route({ action: "entry", summary: "Task" });
    assert.equal(disabled.details.reason, "jev_disabled");
    assert.equal(disabled.details.strategy, "legacy");
    assert.doesNotMatch(disabled.details.notice, /pi install/);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    assert.ok((await route({ action: "entry", summary: "Other task" }, otherCtx)).details.evaluation_request);
    await route({ action: "cancel_assessment" }, otherCtx);
    await command.handler("status", ctx);
    assert.match(notifications.at(-1).message, /disabled/);
    await fake.commands.get("sol-luna-status").handler("", ctx);
    assert.match(notifications.at(-1).message, /Jev routing: disabled/);
    const reloaded = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(reloaded.pi);
    reloaded.events.get("session_start")({}, ctx);
    assert.match(reloaded.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /original serial Plan-Act/);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    const paused = readFileSync(runtimeFile(root), "utf8");
    await command.handler("on", ctx);
    assert.equal(readFileSync(runtimeFile(root), "utf8"), paused);
    await fake.commands.get("sol-luna-enable").handler("", ctx);
    assert.ok((await route({ action: "entry", summary: "Re-enabled task" })).details.evaluation_request);
    const beforeInvalid = readFileSync(preference, "utf8");
    await command.handler("off --force", ctx);
    assert.equal(notifications.at(-1).level, "error");
    assert.equal(readFileSync(preference, "utf8"), beforeInvalid);
  } finally {
    rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true });
  }
});

test("opting out cancels pending Jev work and blocks its late dispatch without blocking unrelated TypeSafe", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-opt-out-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "entry", summary: "Task" });
    const input = prepared.details.evaluation_request;
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "pending", input }, ctx);
    await fake.commands.get("sol-luna-jev").handler("off", ctx);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    assert.equal(fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "pending", details: jevResponse(input), content: [] }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "late", input }, ctx).block, true);
    assert.equal(fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "unrelated", input: { state: "Other plugin task", questions: { urgent: { type: "noul", instructions: "Is this urgent?" } } } }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await fake.commands.get("sol-luna-jev").handler("on", ctx);
    const next = await route({ action: "entry", summary: "Task" });
    assert.equal(fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "new", input: next.details.evaluation_request }, ctx), undefined);
    const reply = fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "new", details: jevResponse(next.details.evaluation_request), content: [] }, ctx);
    assert.equal(reply.details.routingAdvice.recommendation, "direct");
    // External preference changes are checked at dispatch, not just next turn.
    const third = await route({ action: "entry", summary: "Third task" });
    writeFileSync(join(root, configDirName, "sol-luna-jev.json"), JSON.stringify({ version: 1, enabled: false }));
    assert.equal(fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "external-off", input: third.details.evaluation_request }, ctx).block, true);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    await fake.commands.get("sol-luna-jev").handler("on", ctx);
    const fourth = await route({ action: "entry", summary: "Fourth task" });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "in-flight", input: fourth.details.evaluation_request }, ctx);
    writeFileSync(join(root, configDirName, "sol-luna-jev.json"), JSON.stringify({ version: 1, enabled: false }));
    assert.equal(fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "in-flight", details: jevResponse(fourth.details.evaluation_request), content: [] }, ctx), undefined);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    assert.equal((await route({ action: "status" })).details.jev.entry.advice.reason, "evaluation_unavailable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("turning Jev off preserves a prepared parallel batch through integration", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-active-batch-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Independent modules" }, undefined, undefined, ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "parallel", summary: "Independent modules", subtasks: ["a", "b"].map((id) => ({ id, instruction: `Implement ${id}`, acceptance: ["tests pass"], dependsOn: [], writeScopes: [`src/${id}.js`] })) });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "judge", input: prepared.details.evaluation_request }, ctx);
    fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "judge", details: jevResponse(prepared.details.evaluation_request), content: [] }, ctx);
    fake.pi.exec = async () => ({ stdout: "", stderr: "", code: 0 });
    const { requests } = (await route({ action: "dispatch_parallel", reason: "independent work" })).details;
    await fake.commands.get("sol-luna-jev").handler("off", ctx);
    assert.equal((await route({ action: "status" })).details.requests.length, 2);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /Finish the active direct\/parallel task/);
    for (const request of requests) {
      const input = { subagent_type: "luna-worker", prompt: request.renderedPrompt, isolation: "worktree" };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: request.requestId, input }, ctx), undefined);
      await fake.tools.get("sol_luna_record_result").execute("record", { role: "luna", request_id: request.requestId, report_json: JSON.stringify(implementationReport()) }, undefined, undefined, ctx);
    }
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx), undefined);
    await route({ action: "complete", report_json: JSON.stringify(implementationReport()) });
    assert.equal((await route({ action: "status" })).details.status, "validating");
    assert.equal((await route({ action: "dispatch_parallel" })).details.reason, "jev_disabled");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid Jev preferences fall back safely and explicit commands reject symlinks and untrusted projects", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-config-"));
  const outside = mkdtempSync(join(tmpdir(), "sol-luna-jev-outside-"));
  try {
    const notifications = [];
    const ctx = commandContext(root, notifications);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const preference = join(root, configDirName, "sol-luna-jev.json");
    const command = fake.commands.get("sol-luna-jev");
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    for (const value of ["{broken", "[]", JSON.stringify({ version: 99, enabled: true }), JSON.stringify({ version: 1, enabled: "false" }), JSON.stringify({ version: 1, enabled: true, extra: true })]) {
      writeFileSync(preference, value);
      assert.equal((await route({ action: "entry", summary: "Task" })).details.reason, "jev_config_invalid");
      assert.equal((await route({ action: "status" })).details.jev.pending, null);
    }
    await command.handler("off", ctx);
    assert.deepEqual(JSON.parse(readFileSync(preference, "utf8")), { version: 1, enabled: false });
    await command.handler("on", { ...ctx, isProjectTrusted: () => false });
    assert.equal(notifications.at(-1).level, "error");
    assert.equal(JSON.parse(readFileSync(preference, "utf8")).enabled, false);
    unlinkSync(preference);
    const target = join(outside, "setting.json");
    const original = JSON.stringify({ version: 1, enabled: true });
    writeFileSync(target, original);
    symlinkSync(target, preference);
    await command.handler("off", ctx);
    assert.equal(notifications.at(-1).level, "error");
    assert.equal(readFileSync(target, "utf8"), original);
    assert.equal((await route({ action: "entry", summary: "Task" })).details.reason, "jev_config_invalid");
    rmSync(join(root, configDirName), { recursive: true, force: true });
    symlinkSync(outside, join(root, configDirName), "dir");
    await command.handler("on", ctx);
    assert.equal(notifications.at(-1).level, "error");
    assert.throws(() => readFileSync(join(outside, "sol-luna-jev.json")), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("init, update, remove and circuit reset preserve the Jev opt-out preference", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-lifecycle-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-jev").handler("off", ctx);
    const preference = join(root, configDirName, "sol-luna-jev.json");
    const expected = readFileSync(preference, "utf8");
    for (const name of ["sol-luna-init", "sol-luna-update", "sol-luna-reset", "sol-luna-remove"]) {
      await fake.commands.get(name).handler("", ctx);
      assert.equal(readFileSync(preference, "utf8"), expected);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing TypeSafe uses the original serial circuit and gives one optional-install reminder", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi(); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-no-typesafe-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    fake.pi.exec = async () => { throw new Error("Fallback must not execute installation or shell commands"); };
    const first = fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
    assert.match(first.systemPrompt, /original serial Plan-Act/);
    assert.doesNotMatch(first.systemPrompt, /sol_luna_route\(action=entry/);
    assert.equal(first.message.display, true);
    assert.match(first.message.content, /Optional installation: pi install -l npm:pi-typesafe/);
    assert.equal(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).message, undefined);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const entry = await route({ action: "entry", summary: "Fix typo" });
    assert.equal(entry.details.strategy, "legacy");
    assert.equal(entry.details.source, "policy");
    assert.equal(entry.details.reason, "typesafe_missing");
    assert.equal(entry.details.evaluation_request, undefined);
    assert.equal(entry.details.assessment_id, undefined);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Fix typo" }, undefined, undefined, ctx);
    for (const action of ["parallel", "dispatch_parallel"]) assert.equal((await route({ action })).details.strategy, "legacy");
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    for (const role of ["luna", "validator"]) {
      const prepared = await fake.tools.get("sol_luna_prepare_worker").execute("prepare", { role, instruction: "Do the assigned work" }, undefined, undefined, ctx);
      assert.ok(prepared.details.request_id);
      const input = { subagent_type: `${role}-worker`, prompt: prepared.details.rendered_prompt };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: role, input }, ctx), undefined);
      assert.equal(input.run_in_background, false);
      const report = role === "luna" ? implementationReport() : validatorReport();
      const recorded = await fake.tools.get("sol_luna_record_result").execute("record", { role, request_id: prepared.details.request_id, report_json: JSON.stringify(report) }, undefined, undefined, ctx);
      assert.equal(recorded.details.state.stage, role === "luna" ? "validating" : "passed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("TypeSafe removal releases a pending judgment and late results cannot grant permissions", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-typesafe-removed-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "entry", summary: "Task" });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "late", input: prepared.details.evaluation_request }, ctx);
    fake.setTypeSafeAvailable(false);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /original serial/);
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
    assert.equal(fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "late", details: jevResponse(prepared.details.evaluation_request), content: [] }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Task" }, undefined, undefined, ctx);
    fake.setTypeSafeAvailable(true);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /sol_luna_route\(action=entry/);
    assert.ok((await route({ action: "entry", summary: "Task" })).details.evaluation_request);
    // Directly calling the route tool also handles removal, without a new turn.
    fake.setTypeSafeAvailable(false);
    assert.equal((await route({ action: "entry", summary: "Task" })).details.strategy, "legacy");
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inactive or undiscoverable TypeSafe degrades without claiming it needs reinstalling", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-typesafe-inactive-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    fake.pi.getActiveTools = () => ["Agent"];
    const inactive = await route({ action: "entry", summary: "Task" });
    assert.equal(inactive.details.reason, "typesafe_inactive");
    assert.doesNotMatch(inactive.details.notice, /pi install/);
    fake.pi.getActiveTools = () => ["Agent", "typesafe_evaluate"];
    assert.ok((await route({ action: "entry", summary: "Task" })).details.evaluation_request);
    await route({ action: "cancel_assessment" });
    fake.pi.getAllTools = () => { throw new Error("tool registry unavailable"); };
    assert.equal((await route({ action: "entry", summary: "Task" })).details.reason, "typesafe_discovery_unavailable");
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fallback persistence failures preserve the pending judgment for safe recovery", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-typesafe-persist-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "entry", summary: "Task" });
    fake.setTypeSafeAvailable(false); fake.setFailAppend(true);
    await assert.rejects(route({ action: "entry", summary: "Task" }), /store unavailable/);
    assert.equal((await route({ action: "status" })).details.jev.pending.assessmentId, prepared.details.assessment_id);
    fake.setFailAppend(false);
    assert.equal((await route({ action: "entry", summary: "Task" })).details.strategy, "legacy");
    assert.equal((await route({ action: "status" })).details.jev.pending, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function jevResponse(request, choice = "direct") {
  return { model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    const selected = id === "entry" ? choice : keys[0];
    return [id, { type: "choice", choice: selected, confidence: 0.99, probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])) }];
  })) };
}

test("Pi correlates actual Jev tool results without granting permissions and supports direct execution", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-direct-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "entry", summary: "Fix a local typo" });
    const request = prepared.details.evaluation_request;
    fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "unrelated", details: jevResponse(request), content: [] }, ctx);
    assert.ok((await route({ action: "status" })).details.jev.pending);
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "actual", input: request }, ctx);
    assert.equal(fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "duplicate", input: request }, ctx).block, true);
    const reply = fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "actual", details: jevResponse(request), content: [] }, ctx);
    assert.equal(reply.details.routingAdvice.recommendation, "direct");
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Fix typo", complexity: "low", jev_assessment_id: prepared.details.assessment_id }, undefined, undefined, ctx);
    await route({ action: "direct", reason: "Explicit root decision for local change" });
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx), undefined);
    assert.equal(fake.events.get("tool_call")({ toolName: "bash", input: {} }, ctx), undefined);
    fake.setTypeSafeAvailable(false);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /Finish the active direct\/parallel task/);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx), undefined);
    await route({ action: "complete", report_json: JSON.stringify(implementationReport()), validation_json: JSON.stringify(validatorReport({ tests: [{ command: "node --test", passed: true, evidence: "passed" }] })) });
    assert.equal(fake.events.get("tool_call")({ toolName: "write", input: {} }, ctx).block, true);
    assert.equal((await route({ action: "status" })).details.status, "passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi Jev errors fall back, cancellation rejects late results, and persistence fails closed", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-errors-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    let prepared = await route({ action: "entry", summary: "Task" });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "error", input: prepared.details.evaluation_request }, ctx);
    const failed = fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "error", isError: true, content: [] }, ctx);
    assert.equal(failed.details.routingAdvice.recommendation, "planner_review");
    prepared = await route({ action: "entry", summary: "Other task" });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "late", input: prepared.details.evaluation_request }, ctx);
    await route({ action: "cancel_assessment" });
    fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "late", details: jevResponse(prepared.details.evaluation_request), content: [] }, ctx);
    assert.equal((await route({ action: "status" })).details.jev.entry.advice.recommendation, "planner_review");
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Task" }, undefined, undefined, ctx);
    fake.setFailAppend(true);
    await assert.rejects(route({ action: "direct", reason: "Main chooses" }), /store unavailable/);
    fake.setFailAppend(false);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await fake.commands.get("sol-luna-disable").handler("", ctx);
    await assert.rejects(route({ action: "entry", summary: "Task" }), /paused/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("oversized routing output rolls back before persistence without leaving a Jev wait", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-routing-output-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Independent modules" }, undefined, undefined, ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const before = (await route({ action: "status" })).details;
    const entryCount = fake.entries.length;
    const subtasks = Array.from({ length: 4 }, (_, index) => ({ id: `task-${index}`, instruction: "长".repeat(3900), acceptance: ["Tests pass"], writeScopes: [`src/${index}.js`], dependsOn: [] }));
    await assert.rejects(route({ action: "parallel", summary: "Independent modules", subtasks }), /Routing output exceeds 48 KiB/);
    assert.deepEqual((await route({ action: "status" })).details, before);
    assert.equal(fake.entries.length, entryCount);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi parallel dispatch is background, isolated, separately correlated, and joins before integration", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-parallel-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    assert.doesNotMatch(readFileSync(join(root, configDirName, "agents/luna-worker.md"), "utf8"), /^run_in_background:/m);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Independent modules" }, undefined, undefined, ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "parallel", summary: "Independent modules", subtasks: ["a", "b"].map((id) => ({ id, instruction: `Implement ${id}`, acceptance: ["tests pass"], dependsOn: [], writeScopes: [`src/${id}.js`] })) });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "judge", input: prepared.details.evaluation_request }, ctx);
    fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "judge", details: jevResponse(prepared.details.evaluation_request), content: [] }, ctx);
    await assert.rejects(route({ action: "dispatch_parallel", reason: "Dirty repository must not launch" }), /clean, committed/);
    fake.pi.exec = async () => ({ stdout: "", stderr: "", code: 0 });
    const batch = await route({ action: "dispatch_parallel", reason: "Dispatch independent work in isolated copies" });
    const requests = batch.details.requests;
    for (const [index, request] of requests.entries()) {
      const input = { subagent_type: "luna-worker", prompt: request.renderedPrompt };
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: `bad-${index}`, input }, ctx).block, true);
      input.isolation = "worktree";
      assert.equal(fake.events.get("tool_call")({ toolName: "Agent", toolCallId: `agent-${index}`, input }, ctx), undefined);
      assert.equal(input.run_in_background, true);
      assert.equal(input.inherit_context, false);
      fake.events.get("tool_result")({ toolName: "Agent", toolCallId: `agent-${index}`, isError: false, content: [] }, ctx);
    }
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await assert.rejects(route({ action: "complete", report_json: JSON.stringify(implementationReport()) }), /ready/);
    fake.setTypeSafeAvailable(false);
    assert.match(fake.events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx).systemPrompt, /Finish the active direct\/parallel task/);
    assert.equal((await route({ action: "status" })).details.requests.length, 2);
    for (const request of [...requests].reverse()) await fake.tools.get("sol_luna_record_result").execute("record", { role: "luna", request_id: request.requestId, report_json: JSON.stringify(implementationReport()) }, undefined, undefined, ctx);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx), undefined);
    await route({ action: "complete", report_json: JSON.stringify(implementationReport()) });
    assert.equal(fake.events.get("tool_call")({ toolName: "bash", input: {} }, ctx).block, true);
    assert.equal((await route({ action: "status" })).details.status, "validating");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi background failures and malformed reports settle only their own executor", { skip: skipWithoutPiPeers }, async () => {
  const fake = createFakePi({ typesafeAvailable: true }); piModule.createPiAdapter(fake.pi);
  const root = mkdtempSync(join(tmpdir(), "sol-luna-jev-failures-"));
  try {
    const ctx = commandContext(root);
    await fake.commands.get("sol-luna-init").handler("", ctx);
    fake.events.get("session_start")({}, ctx);
    await fake.tools.get("sol_luna_gate").execute("start", { action: "start_task", objective: "Independent modules" }, undefined, undefined, ctx);
    const route = (params) => fake.tools.get("sol_luna_route").execute("route", params, undefined, undefined, ctx);
    const prepared = await route({ action: "parallel", summary: "Independent modules", subtasks: ["a", "b"].map((id) => ({ id, instruction: `Implement ${id}`, acceptance: ["tests pass"], dependsOn: [], writeScopes: [`src/${id}.js`] })) });
    fake.events.get("tool_call")({ toolName: "typesafe_evaluate", toolCallId: "judge", input: prepared.details.evaluation_request }, ctx);
    fake.events.get("tool_result")({ toolName: "typesafe_evaluate", toolCallId: "judge", details: jevResponse(prepared.details.evaluation_request), content: [] }, ctx);
    fake.pi.exec = async () => ({ stdout: "", stderr: "", code: 0 });
    const { requests } = (await route({ action: "dispatch_parallel", reason: "independent work" })).details;
    for (const [index, request] of requests.entries()) {
      const input = { subagent_type: "luna-worker", prompt: request.renderedPrompt, isolation: "worktree" };
      fake.events.get("tool_call")({ toolName: "Agent", toolCallId: `call-${index}`, input }, ctx);
      fake.emitShared("subagents:started", { id: `agent-${index}`, type: "luna-worker", description: input.description });
      fake.events.get("tool_result")({ toolName: "Agent", toolCallId: `call-${index}`, isError: false, content: [] }, ctx);
    }
    fake.emitShared("subagents:failed", { id: "agent-0", type: "luna-worker", error: "No output produced" });
    fake.emitShared("subagents:failed", { id: "agent-0", type: "luna-worker", error: "Duplicate notification" });
    assert.equal((await route({ action: "status" })).details.requests.length, 1);
    assert.equal(fake.events.get("tool_call")({ toolName: "edit", input: {} }, ctx).block, true);
    await assert.rejects(fake.tools.get("sol_luna_record_result").execute("bad", { role: "luna", request_id: requests[1].requestId, report_json: "not JSON" }, undefined, undefined, ctx));
    const final = (await route({ action: "status" })).details;
    assert.equal(final.requests.length, 0);
    assert.equal(final.status, "failed");
    assert.equal(final.reports.length, 2);
    const status = await fake.tools.get("sol_luna_gate").execute("status", { action: "status" }, undefined, undefined, ctx);
    assert.equal(status.details.state.lunaValidationFailures, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
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
