import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_NAMES,
  canInvokeAgent,
  hasExactAvailableModel,
  initialState,
  managedFileDecision,
  mergeSubagents,
  normalizeState,
  removeManagedSubagents,
  transitionState,
} from "../src/core.js";

test("initial state includes the v2 runtime fields", () => {
  assert.deepEqual(initialState(), {
    protocol: "2.0",
    taskLabel: null,
    taskId: null,
    contextId: null,
    phase: "idle",
    stage: "idle",
    activeRole: null,
    lunaValidationFailures: 0,
    solAttempted: false,
    attempts: { luna: 0, validator: 0, sol: 0 },
    latestFailureSnapshotId: null,
    reasoningProfile: null,
    validatorMode: null,
  });
  assert.deepEqual(AGENT_NAMES, ["luna-worker", "sol-worker", "validator-worker"]);
});

test("v2 planning, execution, validation, and success transitions are explicit", () => {
  const started = transitionState(initialState(), "start_task", {
    taskId: "t-v2",
    contextId: "ctx-v2",
    taskLabel: "router",
  });
  assert.equal(started.phase, "luna");
  assert.equal(started.stage, "planning");
  assert.equal(started.activeRole, "planner");

  const planned = transitionState(started, "plan_ready");
  assert.equal(planned.stage, "planning");
  const executing = transitionState(planned, "worker_started", { role: "luna" });
  assert.equal(executing.attempts.luna, 1);
  const validating = transitionState(executing, "worker_completed", { role: "luna" });
  assert.equal(validating.stage, "validating");
  assert.equal(canInvokeAgent(validating, "validator-worker").allowed, true);
  const passed = transitionState(validating, "validation_passed");
  assert.equal(passed.phase, "passed");
  assert.equal(passed.stage, "passed");
});

test("first Luna validation failure creates retry state", () => {
  const started = transitionState(initialState(), "start_task", { taskId: "t-1", taskLabel: "router" });
  const failed = transitionState(started, "luna_failed", {
    reason: "npm test failed",
    snapshotId: "failure-1",
  });
  assert.equal(failed.phase, "luna");
  assert.equal(failed.stage, "failure_snapshot");
  assert.equal(failed.lunaValidationFailures, 1);
  assert.equal(failed.latestFailureSnapshotId, "failure-1");
  assert.equal(canInvokeAgent(failed, "luna-worker").allowed, true);
  assert.throws(() => transitionState(started, "luna_failed"), /reason is required/i);
});

test("second Luna validation failure opens the circuit immediately", () => {
  const started = transitionState(initialState(), "start_task", { taskId: "t-2" });
  const once = transitionState(started, "luna_failed", { reason: "first validation failed", snapshotId: "f-1" });
  const twice = transitionState(once, "luna_failed", { reason: "second validation failed", snapshotId: "f-2" });
  assert.equal(twice.phase, "open");
  assert.equal(twice.stage, "failure_snapshot");
  assert.equal(twice.lunaValidationFailures, 2);
  assert.equal(canInvokeAgent(twice, "luna-worker").allowed, false);
});

test("Sol Recovery requires the current failure snapshot for v2 tasks and is allowed once", () => {
  const withoutSnapshot = normalizeState({
    taskId: "t",
    contextId: "ctx",
    phase: "open",
    stage: "failure_snapshot",
    lunaValidationFailures: 2,
  });
  assert.equal(canInvokeAgent(withoutSnapshot, "sol-worker").allowed, false);

  const open = { ...withoutSnapshot, latestFailureSnapshotId: "failure-2" };
  assert.equal(canInvokeAgent(open, "sol-worker").allowed, true);
  const recovery = transitionState(open, "sol_started");
  assert.equal(recovery.phase, "sol-recovery");
  assert.equal(recovery.stage, "recovery");
  assert.equal(recovery.solAttempted, true);
  assert.equal(recovery.attempts.sol, 1);
  assert.equal(canInvokeAgent(recovery, "sol-worker").allowed, false);
  assert.equal(canInvokeAgent(open, "sol-worker", { resume: true }).allowed, false);
});

test("legacy state without context remains recoverable", () => {
  const open = normalizeState({ phase: "open", lunaValidationFailures: 2 });
  assert.equal(canInvokeAgent(open, "sol-worker").allowed, true);
});

test("validator is read-only-call gated to validation stage", () => {
  const started = transitionState(initialState(), "start_task", { taskId: "v" });
  assert.equal(canInvokeAgent(started, "validator-worker").allowed, false);
  const validating = transitionState(started, "validation_started");
  assert.equal(canInvokeAgent(validating, "validator-worker").allowed, true);
  assert.equal(canInvokeAgent(validating, "validator-worker", { resume: true }).allowed, false);
});

test("legacy passed and Sol failure actions remain compatible", () => {
  assert.throws(() => transitionState(initialState(), "passed"), /from phase idle/i);
  const started = transitionState(initialState(), "start_task", { taskId: "t-pass" });
  assert.equal(transitionState(started, "passed").phase, "passed");
  const escalated = transitionState({
    phase: "sol-recovery",
    stage: "validating",
    lunaValidationFailures: 2,
    solAttempted: true,
  }, "sol_failed", { reason: "recovery validation failed" });
  assert.equal(escalated.phase, "escalated");
  assert.equal(escalated.stage, "escalated");
});

test("state normalization migrates and repairs persisted v1 values", () => {
  const normalized = normalizeState({
    phase: "luna",
    lunaValidationFailures: 99,
    solAttempted: "yes",
    taskLabel: "  build  ",
  });
  assert.equal(normalized.protocol, "2.0");
  assert.equal(normalized.taskLabel, "build");
  assert.equal(normalized.phase, "open");
  assert.equal(normalized.stage, "failure_snapshot");
  assert.deepEqual(normalized.attempts, { luna: 0, validator: 0, sol: 0 });
  assert.equal(normalizeState({ phase: "unknown", lunaValidationFailures: -2 }).phase, "idle");
  assert.equal(normalizeState({ phase: "sol-recovery", lunaValidationFailures: 1, solAttempted: true }).phase, "luna");
  assert.equal(normalizeState({ phase: "sol-recovery", lunaValidationFailures: 2, solAttempted: false }).phase, "open");
  assert.equal(normalizeState({ phase: "open", lunaValidationFailures: 2, solAttempted: true }).phase, "sol-recovery");
});

test("model availability requires exact provider and model ID", () => {
  const available = [{ provider: "cliproxyapi", id: "gpt-5.6-sol" }];
  assert.equal(hasExactAvailableModel(available, { provider: "cliproxyapi", model: "gpt-5.6-sol" }), true);
  assert.equal(hasExactAvailableModel(available, { provider: "other", model: "gpt-5.6-sol" }), false);
  assert.equal(hasExactAvailableModel([], { provider: "cliproxyapi", model: "gpt-5.6-sol" }), false);
});

test("subagents merge and removal preserve unrelated keys", () => {
  const existing = { custom: { enabled: true }, disableDefaultAgents: false };
  const refused = mergeSubagents(existing);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.conflicts, ["disableDefaultAgents"]);
  const merged = mergeSubagents(existing, { force: true });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.value.custom, { enabled: true });
  assert.deepEqual(removeManagedSubagents({ ...merged.value, custom: 1 }), { custom: 1 });
});

test("safe overwrite decision upgrades unchanged managed files", () => {
  assert.equal(managedFileDecision(undefined, "desired").action, "create");
  assert.equal(managedFileDecision("desired", "desired").action, "skip");
  assert.equal(managedFileDecision("old", "desired", { currentHash: "old-sha", managedHash: "old-sha" }).action, "upgrade");
  assert.equal(managedFileDecision("edited", "desired", { currentHash: "edited-sha", managedHash: "old-sha" }).action, "conflict");
  assert.equal(managedFileDecision("edited", "desired", { force: true }).action, "overwrite");
});
