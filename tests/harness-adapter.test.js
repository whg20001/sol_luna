import test from "node:test";
import assert from "node:assert/strict";
import { createHarnessAdapter } from "../src/adapters/harness.js";
import { createCodexAdapter } from "../src/adapters/codex.js";
import { createDeepSeekAdapter } from "../src/adapters/deepseek.js";

function createTestAdapter(overrides = {}) {
  return createHarnessAdapter({
    harnessName: "test-harness",
    taskIdFactory: () => "generated-task",
    workerBindings: {
      luna: { worker: "luna-binding" },
      sol: { worker: "sol-binding" },
    },
    invokeWorker: async ({ role }) => `${role}-result`,
    saveSnapshot: async () => {},
    ...overrides,
  });
}

async function openCircuit(adapter) {
  await adapter.gate("start_task", { taskLabel: "adapter test" });
  await adapter.gate("luna_failed", { reason: "first validation failed" });
  await adapter.gate("luna_failed", { reason: "second validation failed" });
}

test("harness adapter validates its host callbacks and bindings", () => {
  assert.throws(() => createHarnessAdapter(), /invokeWorker must be a function/);
  assert.throws(
    () => createHarnessAdapter({ invokeWorker() {}, workerBindings: { luna: "only" } }),
    /workerBindings\.sol is required/,
  );
});

test("Luna calls forward opaque host values without changing router state", async () => {
  const binding = { profile: "luna-profile" };
  const input = { prompt: "implement this" };
  const signal = new AbortController().signal;
  let received;
  const adapter = createTestAdapter({
    workerBindings: { luna: binding, sol: "sol-profile" },
    invokeWorker: async (request) => {
      received = request;
      return { completed: true };
    },
  });

  await adapter.gate("start_task", { taskId: "task-forward" });
  const result = await adapter.invoke("luna", input, { signal, metadata: { trace: "abc" } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { completed: true });
  assert.equal(received.harnessName, "test-harness");
  assert.equal(received.role, "luna");
  assert.equal(received.binding, binding);
  assert.equal(received.input, input);
  assert.equal(received.signal, signal);
  assert.deepEqual(received.metadata, { trace: "abc" });
  assert.equal(result.state.phase, "luna");
  assert.match(adapter.getInstructions(), /test-harness/);
  assert.match(adapter.getInstructions(), /task=task-forward/);
});

test("an open circuit blocks Luna without invoking the host executor", async () => {
  let invocations = 0;
  const adapter = createTestAdapter({
    invokeWorker: async () => {
      invocations += 1;
    },
  });
  await openCircuit(adapter);

  const result = await adapter.invoke("luna", "retry");
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(invocations, 0);
});

test("Sol state is persisted before execution and can be consumed only once", async () => {
  const events = [];
  const adapter = createTestAdapter({
    saveSnapshot: async (snapshot, metadata) => {
      events.push(`save:${metadata.reason}:${snapshot.state.phase}`);
    },
    invokeWorker: async ({ role, routerState }) => {
      events.push(`invoke:${role}:${routerState.phase}`);
      return "recovered";
    },
  });
  await openCircuit(adapter);
  events.length = 0;

  const first = await adapter.invoke("sol", "recover");
  assert.equal(first.ok, true);
  assert.deepEqual(events, ["save:sol_started:sol-recovery", "invoke:sol:sol-recovery"]);

  const second = await adapter.invoke("sol", "recover again");
  assert.equal(second.blocked, true);
  assert.equal(events.length, 2);
});

test("a failed Sol snapshot save rolls state back and prevents execution", async () => {
  let failSave = false;
  let invocations = 0;
  const adapter = createTestAdapter({
    saveSnapshot: async () => {
      if (failSave) throw new Error("store unavailable");
    },
    invokeWorker: async () => {
      invocations += 1;
    },
  });
  await openCircuit(adapter);
  failSave = true;

  await assert.rejects(adapter.invoke("sol", "recover"), /store unavailable/);
  assert.equal(invocations, 0);
  assert.equal(adapter.getState().phase, "open");
  assert.equal(adapter.getState().solAttempted, false);
});

test("worker execution errors do not restore a consumed Sol attempt", async () => {
  const adapter = createTestAdapter({
    invokeWorker: async () => {
      throw new Error("worker crashed");
    },
  });
  await openCircuit(adapter);

  await assert.rejects(adapter.invoke("sol", "recover"), /worker crashed/);
  assert.equal(adapter.getState().phase, "sol-recovery");
  assert.equal(adapter.getState().solAttempted, true);
});

test("gate persistence failures restore the previous state", async () => {
  const adapter = createTestAdapter({
    saveSnapshot: async () => {
      throw new Error("cannot persist gate");
    },
  });
  await assert.rejects(adapter.gate("start_task", { taskId: "not-saved" }), /cannot persist gate/);
  assert.equal(adapter.getState().phase, "idle");
});

test("state transactions serialize persistence so an old rollback cannot erase newer state", async () => {
  let releaseFirst;
  const firstCanFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const savedTaskIds = [];
  const adapter = createTestAdapter({
    saveSnapshot: async (snapshot) => {
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
  assert.equal(adapter.getState().phase, "luna");
});

test("Codex and DeepSeek adapters supply only their harness identity", async () => {
  const names = [];
  const common = {
    workerBindings: { luna: "luna", sol: "sol" },
    invokeWorker: async ({ harnessName }) => {
      names.push(harnessName);
    },
  };
  const codex = createCodexAdapter(common);
  const deepseek = createDeepSeekAdapter(common);
  await codex.invoke("luna", "task");
  await deepseek.invoke("luna", "task");
  assert.deepEqual(names, ["codex", "deepseek"]);
});
