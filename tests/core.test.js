import test from "node:test";
import assert from "node:assert/strict";
import {
  canInvokeAgent,
  hasExactAvailableModel,
  initialState,
  managedFileDecision,
  mergeSubagents,
  normalizeState,
  removeManagedSubagents,
  transitionState,
} from "../src/core.js";

test("initial state is idle and clear", () => {
  assert.deepEqual(initialState(), {
    taskLabel: null,
    taskId: null,
    phase: "idle",
    lunaValidationFailures: 0,
    solAttempted: false,
  });
});

test("first Luna validation failure keeps recovery on Luna", () => {
  const started = transitionState(initialState(), "start_task", { taskId: "t-1", taskLabel: "router" });
  const failed = transitionState(started, "luna_failed", { reason: "npm test failed" });
  assert.equal(failed.phase, "luna");
  assert.equal(failed.lunaValidationFailures, 1);
  assert.throws(() => transitionState(started, "luna_failed"), /reason is required/i);
});

test("second Luna validation failure opens the circuit immediately", () => {
  const started = transitionState(initialState(), "start_task", { taskId: "t-2" });
  const once = transitionState(started, "luna_failed", { reason: "first validation failed" });
  const twice = transitionState(once, "luna_failed", { reason: "second validation failed" });
  assert.equal(twice.phase, "open");
  assert.equal(twice.lunaValidationFailures, 2);
  assert.equal(canInvokeAgent(twice, "luna-worker").allowed, false);
});

test("Sol Recovery is allowed exactly once", () => {
  const open = { ...initialState(), phase: "open", lunaValidationFailures: 2 };
  assert.equal(canInvokeAgent(open, "sol-worker").allowed, true);
  const recovery = transitionState(open, "sol_started");
  assert.equal(recovery.phase, "sol-recovery");
  assert.equal(recovery.solAttempted, true);
  assert.equal(canInvokeAgent(recovery, "sol-worker").allowed, false);
  assert.equal(canInvokeAgent(open, "sol-worker", { resume: true }).allowed, false);
});

test("passed is allowed only for an active Luna or Sol task", () => {
  assert.throws(() => transitionState(initialState(), "passed"), /from phase idle/i);
  const started = transitionState(initialState(), "start_task", { taskId: "t-pass" });
  assert.equal(transitionState(started, "passed").phase, "passed");
  assert.throws(() => transitionState({ ...started, phase: "open", lunaValidationFailures: 2 }, "passed"), /from phase open/i);
});

test("Sol failure requires the exact started recovery state", () => {
  assert.throws(
    () => transitionState({ ...initialState(), phase: "open", lunaValidationFailures: 2 }, "sol_failed", { reason: "x" }),
    /only after its one allowed attempt has started/i,
  );
  assert.throws(
    () => transitionState({ ...initialState(), phase: "sol-recovery", lunaValidationFailures: 2, solAttempted: false }, "sol_failed", { reason: "x" }),
    /only after its one allowed attempt has started/i,
  );
  const escalated = transitionState({ phase: "sol-recovery", lunaValidationFailures: 2, solAttempted: true }, "sol_failed", { reason: "recovery validation failed" });
  assert.equal(escalated.phase, "escalated");
  assert.equal(escalated.solAttempted, true);
});

test("Luna failures are rejected outside the active Luna phase", () => {
  for (const phase of ["idle", "open", "sol-recovery", "passed", "escalated"]) {
    assert.throws(
      () => transitionState({ phase, lunaValidationFailures: phase === "open" || phase === "sol-recovery" || phase === "escalated" ? 2 : 0, solAttempted: phase === "sol-recovery" || phase === "escalated" }, "luna_failed", { reason: "x" }),
      /Cannot record a Luna failure from phase/i,
    );
  }
});

test("state normalization clamps and repairs persisted values", () => {
  assert.deepEqual(normalizeState({ phase: "luna", lunaValidationFailures: 99, solAttempted: "yes", taskLabel: "  build  " }), {
    taskLabel: "build",
    taskId: null,
    phase: "open",
    lunaValidationFailures: 2,
    solAttempted: false,
  });
  assert.equal(normalizeState({ phase: "unknown", lunaValidationFailures: -2 }).phase, "idle");
  assert.equal(normalizeState({ phase: "sol-recovery", lunaValidationFailures: 1, solAttempted: true }).phase, "luna");
  assert.equal(normalizeState({ phase: "sol-recovery", lunaValidationFailures: 2, solAttempted: false }).phase, "open");
  assert.equal(normalizeState({ phase: "open", lunaValidationFailures: 1, solAttempted: false }).phase, "luna");
  assert.equal(normalizeState({ phase: "open", lunaValidationFailures: 2, solAttempted: true }).phase, "sol-recovery");
  assert.equal(normalizeState({ phase: "idle", lunaValidationFailures: 2, solAttempted: true }).phase, "sol-recovery");
  assert.equal(normalizeState({ phase: "passed", lunaValidationFailures: 2, solAttempted: false }).phase, "open");
});

test("model availability requires an exact provider and model ID", () => {
  const available = [{ provider: "cliproxyapi", id: "gpt-5.6-sol" }];
  assert.equal(hasExactAvailableModel(available, { provider: "cliproxyapi", model: "gpt-5.6-sol" }), true);
});

test("model availability rejects the same model ID from the wrong provider", () => {
  const available = [{ provider: "other-provider", id: "gpt-5.6-sol" }];
  assert.equal(hasExactAvailableModel(available, { provider: "cliproxyapi", model: "gpt-5.6-sol" }), false);
});

test("model availability rejects a missing model ID", () => {
  const available = [{ provider: "cliproxyapi", id: "gpt-5.6-luna" }];
  assert.equal(hasExactAvailableModel(available, { provider: "cliproxyapi", model: "gpt-5.6-sol" }), false);
});

test("model availability rejects an empty available catalog", () => {
  assert.equal(hasExactAvailableModel([], { provider: "cliproxyapi", model: "gpt-5.6-sol" }), false);
});

test("subagents merge preserves unrelated keys and refuses conflicts by default", () => {
  const existing = { custom: { enabled: true }, disableDefaultAgents: false };
  const refused = mergeSubagents(existing);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.conflicts, ["disableDefaultAgents"]);
  assert.deepEqual(refused.value, existing);
  const merged = mergeSubagents(existing, { force: true });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.value.custom, { enabled: true });
  assert.equal(merged.value.disableDefaultAgents, true);
  assert.equal(merged.value.fallbackSubagent, "none");
  assert.equal(merged.value.strictAgentFiles, true);
});

test("subagents removal removes only still-managed values", () => {
  const value = removeManagedSubagents({
    custom: 1,
    disableDefaultAgents: true,
    fallbackSubagent: "user-choice",
    strictAgentFiles: true,
  });
  assert.deepEqual(value, { custom: 1, fallbackSubagent: "user-choice" });
});

test("safe overwrite decision upgrades an unchanged old managed version", () => {
  assert.equal(managedFileDecision(undefined, "desired").action, "create");
  assert.equal(managedFileDecision("desired", "desired").action, "skip");
  assert.equal(managedFileDecision("old", "desired", { currentHash: "old-sha", managedHash: "old-sha" }).action, "upgrade");
  assert.equal(managedFileDecision("edited", "desired", { currentHash: "edited-sha", managedHash: "old-sha" }).action, "conflict");
  assert.equal(managedFileDecision("edited", "desired", { force: true }).action, "overwrite");
});
