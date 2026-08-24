import test from "node:test";
import assert from "node:assert/strict";
import {
  createHarnessAdapter,
  createHarnessPromptPrefix,
} from "../src/adapters/harness.js";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { createDeepSeekAdapter } from "../src/adapters/deepseek.js";

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

function createTestAdapter(overrides = {}) {
  let request = 0;
  let failure = 0;
  return createHarnessAdapter({
    harnessName: "test-harness",
    taskIdFactory: () => "generated-task",
    contextIdFactory: ({ taskId }) => `context-${taskId}`,
    requestIdFactory: () => `request-${++request}`,
    snapshotIdFactory: () => `failure-${++failure}`,
    workerBindings: {
      luna: { worker: "luna-binding" },
      validator: { worker: "validator-binding" },
      sol: { worker: "sol-binding" },
    },
    invokeWorker: async ({ role }) => role === "validator"
      ? validatorReport()
      : implementationReport(role),
    saveSnapshot: async () => {},
    ...overrides,
  });
}

async function openCircuit(adapter) {
  await adapter.gate("start_task", { taskLabel: "adapter test" });
  await adapter.gate("luna_failed", { reason: "first validation failed" });
  await adapter.gate("luna_failed", { reason: "second validation failed" });
}

test("harness adapter validates callbacks and keeps validator optional", () => {
  assert.throws(() => createHarnessAdapter(), /invokeWorker must be a function/);
  assert.throws(
    () => createHarnessAdapter({ invokeWorker() {}, workerBindings: { luna: "only" } }),
    /workerBindings\.sol is required/,
  );
  assert.doesNotThrow(() => createHarnessAdapter({
    invokeWorker() {},
    workerBindings: { luna: "luna", sol: "sol" },
  }));
});

test("Luna receives the legacy fields and the v2 request envelope", async () => {
  const binding = { profile: "luna-profile" };
  const input = { prompt: "implement this" };
  const signal = new AbortController().signal;
  let received;
  const adapter = createTestAdapter({
    workerBindings: { luna: binding, validator: "validator", sol: "sol-profile" },
    invokeWorker: async (request) => {
      received = request;
      return implementationReport("luna", {
        changed_files: ["src/a.js"],
        diff_summary: "implemented",
        changes: ["implemented"],
      });
    },
  });

  await adapter.gate("start_task", { taskId: "task-forward", taskLabel: "forward" });
  const result = await adapter.invoke("luna", input, { signal, metadata: { trace: "abc" } });
  assert.equal(result.ok, true);
  assert.equal(received.harnessName, "test-harness");
  assert.equal(received.role, "luna");
  assert.equal(received.binding, binding);
  assert.equal(received.input, input);
  assert.equal(received.signal, signal);
  assert.deepEqual(received.metadata, { trace: "abc" });
  assert.equal(received.requestId, "request-1");
  assert.equal(received.contextId, "context-task-forward");
  assert.equal(received.contextEnvelope.runtime.role, "luna");
  assert.equal(received.budget.thinking, "medium");
  assert.equal(received.promptPrefix, adapter.getPromptPrefix().split("\n\n## Host", 1)[0]);
  assert.match(received.renderedPrompt, /<CURRENT_TASK>\nimplement this/);
  assert.equal(result.state.stage, "validating");
  assert.deepEqual(adapter.getMemory().artifact.modifiedFiles, ["src/a.js"]);
});

test("dedicated Validator results can pass the task automatically", async () => {
  const adapter = createTestAdapter();
  await adapter.gate("start_task", { taskId: "validate", taskLabel: "validate" });
  await adapter.invoke("luna", "implement");
  const result = await adapter.invoke("validator", "run approved checks");
  assert.equal(result.ok, true);
  assert.equal(result.state.phase, "passed");
});

test("Validator failure creates a snapshot and drives Luna retry then Sol recovery", async () => {
  let validationCount = 0;
  const adapter = createTestAdapter({
    invokeWorker: async ({ role }) => {
      if (role !== "validator") return implementationReport(role, { changed_files: ["src/a.js"] });
      validationCount += 1;
      return validatorReport({
        passed: false,
        issues: [`failure ${validationCount}`],
        reason: `failure ${validationCount}`,
        current_error: { type: "test_failure", message: `failure ${validationCount}`, log: "failed" },
      });
    },
  });
  await adapter.gate("start_task", { taskId: "recover", taskLabel: "recover" });
  await adapter.invoke("luna", "first implementation");
  await adapter.invoke("validator", "validate first");
  assert.equal(adapter.getState().phase, "luna");
  assert.equal(adapter.getState().validatorMode, "deep");
  assert.equal(adapter.getState().latestFailureSnapshotId, null);
  await adapter.invoke("validator", "deep validate first");
  assert.equal(adapter.getState().latestFailureSnapshotId, "failure-1");

  await adapter.invoke("luna", "retry implementation");
  await adapter.invoke("validator", "validate retry");
  assert.equal(adapter.getState().validatorMode, "deep");
  await adapter.invoke("validator", "deep validate retry");
  assert.equal(adapter.getState().phase, "open");
  assert.equal(adapter.getState().latestFailureSnapshotId, "failure-2");

  let solRequest;
  const recoveryAdapter = adapter;
  // The host callback above is enough to execute Sol; inspect its returned request.
  const sol = await recoveryAdapter.invoke("sol", "repair locally from snapshot");
  solRequest = sol.request;
  assert.equal(sol.ok, true);
  assert.equal(solRequest.snapshotId, "failure-2");
  assert.equal(solRequest.contextEnvelope.failure.current_snapshot_id, "failure-2");
  assert.equal(sol.state.stage, "validating");
});

test("invalid structured output becomes a recoverable failure snapshot", async () => {
  const adapter = createTestAdapter({ invokeWorker: async () => ({ status: "success" }) });
  await adapter.gate("start_task", { taskId: "invalid-output", taskLabel: "invalid" });
  await assert.rejects(adapter.invoke("luna", "implement"), /strict JSON schema/i);
  assert.equal(adapter.getState().lunaValidationFailures, 1);
  assert.equal(adapter.getState().stage, "failure_snapshot");
  assert.equal(adapter.getFailureSnapshot() !== null, true);
});

test("an open circuit blocks Luna without invoking the executor", async () => {
  let invocations = 0;
  const adapter = createTestAdapter({ invokeWorker: async () => { invocations += 1; } });
  await openCircuit(adapter);
  const result = await adapter.invoke("luna", "retry");
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(invocations, 0);
});

test("worker start is persisted before execution", async () => {
  const events = [];
  const adapter = createTestAdapter({
    saveSnapshot: async (snapshot, metadata) => {
      events.push(`save:${metadata.reason}:${snapshot.state.stage}`);
    },
    invokeWorker: async ({ role, routerState }) => {
      events.push(`invoke:${role}:${routerState.stage}`);
      return implementationReport(role);
    },
  });
  await adapter.gate("start_task", { taskId: "persist", taskLabel: "persist" });
  events.length = 0;
  await adapter.invoke("luna", "implement");
  assert.deepEqual(events, [
    "save:worker_started:executing",
    "invoke:luna:executing",
    "save:worker_result:validating",
  ]);
});

test("a failed worker-start snapshot save rolls state back and prevents execution", async () => {
  let failSave = false;
  let invocations = 0;
  const adapter = createTestAdapter({
    saveSnapshot: async (_snapshot, metadata) => {
      if (failSave && metadata.reason === "worker_started") throw new Error("store unavailable");
    },
    invokeWorker: async () => { invocations += 1; },
  });
  await adapter.gate("start_task", { taskId: "rollback", taskLabel: "rollback" });
  failSave = true;
  await assert.rejects(adapter.invoke("luna", "implement"), /store unavailable/);
  assert.equal(invocations, 0);
  assert.equal(adapter.getState().stage, "planning");
});

test("worker execution errors generate failure state and preserve consumed Sol attempts", async () => {
  const adapter = createTestAdapter({
    invokeWorker: () => { throw new Error("worker crashed"); },
  });
  await openCircuit(adapter);
  await assert.rejects(adapter.invoke("sol", "recover"), /worker crashed/);
  assert.equal(adapter.getState().phase, "escalated");
  assert.equal(adapter.getState().solAttempted, true);
  assert.match(adapter.getFailureSnapshot().currentError.message, /worker crashed/i);
});

test("gate persistence failures restore the complete previous snapshot", async () => {
  const adapter = createTestAdapter({ saveSnapshot: async () => { throw new Error("cannot persist gate"); } });
  await assert.rejects(adapter.gate("start_task", { taskId: "not-saved" }), /cannot persist gate/);
  assert.equal(adapter.getState().phase, "idle");
  assert.equal(adapter.getMemory().runtime.taskId, null);
});

test("transactions serialize persistence so old rollbacks cannot erase newer state", async () => {
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => { releaseFirst = resolve; });
  const savedTaskIds = [];
  const adapter = createTestAdapter({
    saveSnapshot: async (snapshot, metadata) => {
      if (metadata.reason !== "gate") return;
      savedTaskIds.push(snapshot.state.taskId);
      if (snapshot.state.taskId === "first") {
        await firstCanFinish;
        throw new Error("first save failed");
      }
    },
  });

  const first = adapter.gate("start_task", { taskId: "first" });
  await Promise.resolve();
  const second = adapter.gate("start_task", { taskId: "second" });
  await Promise.resolve();
  assert.deepEqual(savedTaskIds, ["first"]);
  releaseFirst();
  await assert.rejects(first, /first save failed/);
  await second;
  assert.deepEqual(savedTaskIds, ["first", "second"]);
  assert.equal(adapter.getState().taskId, "second");
});

test("static harness prefix does not change with runtime state", async () => {
  const adapter = createTestAdapter();
  const before = adapter.getPromptPrefix();
  await adapter.gate("start_task", { taskId: "prefix", taskLabel: "prefix" });
  const after = adapter.getPromptPrefix();
  assert.equal(before, after);
  assert.equal(before, createHarnessPromptPrefix({ harnessName: "test-harness" }));
  assert.doesNotMatch(before, /task=|context=|failure-/);
  assert.match(adapter.getRuntimeContext(), /task=prefix/);
});

test("Codex and DeepSeek adapters preserve their harness identity", async () => {
  const names = [];
  const common = {
    workerBindings: { luna: "luna", sol: "sol" },
    strictWorkerOutput: false,
    invokeWorker: async ({ harnessName }) => { names.push(harnessName); return {}; },
  };
  const codex = createCodexAdapter(common);
  const deepseek = createDeepSeekAdapter(common);
  await codex.invoke("luna", "task");
  await deepseek.invoke("luna", "task");
  assert.deepEqual(names, ["codex", "deepseek"]);
});
