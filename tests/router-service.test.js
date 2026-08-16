import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_STATE_VERSION,
  createRouterService,
} from "../src/router-service.js";

function openCircuit(router) {
  router.gate("start_task", { taskId: "task-open", taskLabel: "open circuit" });
  router.gate("luna_failed", { reason: "first validation failed" });
  router.gate("luna_failed", { reason: "second validation failed" });
}

test("router service exposes versioned copies of its state", () => {
  const router = createRouterService();
  const state = router.getState();
  state.phase = "escalated";
  assert.equal(router.getState().phase, "idle");
  assert.deepEqual(router.snapshot(), {
    version: ROUTER_STATE_VERSION,
    state: {
      taskLabel: null,
      taskId: null,
      phase: "idle",
      lunaValidationFailures: 0,
      solAttempted: false,
    },
  });
});

test("router service restores raw and versioned persisted state", () => {
  const router = createRouterService({
    snapshot: { version: 1, state: { phase: "luna", lunaValidationFailures: 1, taskId: "restored" } },
  });
  assert.equal(router.getState().taskId, "restored");
  assert.equal(router.getState().phase, "luna");

  router.restore({ phase: "open", lunaValidationFailures: 2 });
  assert.equal(router.getState().phase, "open");
});

test("start_task uses the injected ID factory only for nullish IDs", () => {
  let calls = 0;
  const router = createRouterService({ taskIdFactory: () => `generated-${++calls}` });
  const generated = router.gate("start_task", { taskLabel: "generated" });
  assert.equal(generated.state.taskId, "generated-1");
  assert.equal(calls, 1);

  const explicit = router.gate("start_task", { taskId: "explicit" });
  assert.equal(explicit.state.taskId, "explicit");
  assert.equal(calls, 1);

  const blank = router.gate("start_task", { taskId: "" });
  assert.equal(blank.state.taskId, null);
  assert.equal(calls, 1);
});

test("status is read-only and reset returns to the initial state", () => {
  const router = createRouterService();
  router.gate("start_task", { taskId: "task-status" });
  const status = router.gate("status");
  assert.equal(status.changed, false);
  assert.equal(status.state.phase, "luna");

  const reset = router.reset();
  assert.equal(reset.changed, true);
  assert.equal(router.getState().phase, "idle");
});

test("worker preparation enforces Luna circuit and atomically starts Sol", () => {
  const router = createRouterService();
  openCircuit(router);

  const luna = router.prepareWorkerCall({ role: "luna" });
  assert.equal(luna.allowed, false);
  assert.equal(luna.changed, false);

  const sol = router.prepareWorkerCall({ role: "sol" });
  assert.equal(sol.allowed, true);
  assert.equal(sol.changed, true);
  assert.equal(sol.previousState.phase, "open");
  assert.equal(sol.state.phase, "sol-recovery");
  assert.equal(sol.state.solAttempted, true);

  const secondSol = router.prepareWorkerCall({ role: "sol" });
  assert.equal(secondSol.allowed, false);
});

test("Sol resume is rejected without consuming the recovery attempt", () => {
  const router = createRouterService();
  openCircuit(router);
  const result = router.prepareWorkerCall({ role: "sol", resume: true });
  assert.equal(result.allowed, false);
  assert.equal(router.getState().phase, "open");
  assert.equal(router.getState().solAttempted, false);
});

test("generic Agent authorization preserves the Pi resume rule", () => {
  const router = createRouterService();
  openCircuit(router);
  const result = router.prepareAgentCall({ agentType: "other-agent", resume: true });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /resume is blocked/i);
});

test("unknown host-independent worker roles are rejected", () => {
  const router = createRouterService();
  assert.throws(() => router.prepareWorkerCall({ role: "builder" }), /Unknown router worker role/);
});
