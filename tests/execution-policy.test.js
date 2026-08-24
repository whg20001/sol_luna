import test from "node:test";
import assert from "node:assert/strict";
import {
  REASONING_PROFILE_VERSION,
  VALIDATOR_MODES,
  evaluateExecutionPolicy,
  freezeReasoningProfile,
  normalizeReasoningProfile,
} from "../src/execution-policy.js";

function state(overrides = {}) {
  return {
    phase: "luna",
    stage: "planning",
    taskId: "task-1",
    lunaValidationFailures: 0,
    solAttempted: false,
    latestFailureSnapshotId: null,
    ...overrides,
  };
}

test("Reasoning Profile normalization has v2.1 defaults, strips unknown fields, and deep-copies", () => {
  const input = {
    taskId: " task-1 ",
    complexity: "HIGH",
    roles: {
      planner: { thinking: "low", metadata: { mutable: true } },
      luna: "high",
      validator: { fast: "medium", deep: { thinking: "high" }, ignored: true },
      sol: { thinking: "low" },
    },
    unknown: { retained: false },
  };
  const normalized = normalizeReasoningProfile(input);

  assert.deepEqual(normalized, {
    version: REASONING_PROFILE_VERSION,
    taskId: "task-1",
    complexity: "high",
    roles: {
      planner: { thinking: "low" },
      luna: { thinking: "high" },
      validator: {
        fast: { thinking: "medium" },
        deep: { thinking: "high" },
      },
      sol: { thinking: "high" },
    },
    frozenAtRevision: null,
  });
  input.roles.planner.thinking = "medium";
  assert.equal(normalized.roles.planner.thinking, "low");
  assert.deepEqual(VALIDATOR_MODES, ["fast", "deep"]);

  const defaults = normalizeReasoningProfile({ taskId: "defaults" });
  assert.equal(defaults.roles.planner.thinking, "high");
  assert.equal(defaults.roles.luna.thinking, "medium");
  assert.equal(defaults.roles.validator.fast.thinking, "low");
  assert.equal(defaults.roles.validator.deep.thinking, "medium");
  assert.equal(defaults.roles.sol.thinking, "high");
});

test("freezing is deep, idempotent for one task, rejects drift, and permits a new task", () => {
  const frozen = freezeReasoningProfile({ taskId: "task-1", complexity: "medium" }, 7);
  assert.equal(frozen.frozenAtRevision, 7);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.roles.validator.fast), true);

  const same = freezeReasoningProfile(frozen, {
    taskId: "task-1",
    complexity: "medium",
    roles: frozen.roles,
  });
  assert.deepEqual(same, frozen);
  assert.notEqual(same, frozen);

  assert.throws(
    () => freezeReasoningProfile(frozen, { taskId: "task-1", complexity: "high" }),
    /drift/i,
  );
  assert.throws(
    () => freezeReasoningProfile(frozen, {
      taskId: "task-1",
      complexity: "medium",
      roles: { luna: { thinking: "high" } },
    }),
    /drift/i,
  );

  const ignored = freezeReasoningProfile(
    { taskId: "task-1", complexity: "high" },
    { previous: frozen, onDrift: "ignore" },
  );
  assert.deepEqual(ignored, frozen);

  const nextTask = freezeReasoningProfile(
    { taskId: "task-2", complexity: "high" },
    { previous: frozen, revision: 8 },
  );
  assert.equal(nextTask.taskId, "task-2");
  assert.equal(nextTask.complexity, "high");
  assert.equal(nextTask.frozenAtRevision, 8);
});

test("planning and first failure snapshot route initial and retry work to Luna", () => {
  const initial = evaluateExecutionPolicy({ state: state() });
  assert.equal(initial.allowed, true);
  assert.equal(initial.nextAction, "run_luna");
  assert.equal(initial.role, "luna");
  assert.equal(initial.reasonCode, "LUNA_INITIAL");
  assert.equal(initial.projection.thinking, "medium");
  assert.equal(initial.budgetRole, "luna");

  const retry = evaluateExecutionPolicy({
    state: state({ stage: "failure_snapshot", lunaValidationFailures: 1, latestFailureSnapshotId: "fs-1" }),
    memory: { failure: { currentError: { message: "test failed" } } },
  });
  assert.equal(retry.nextAction, "run_luna");
  assert.equal(retry.reasonCode, "LUNA_RETRY");
});

test("Validator defaults to Fast and switches to Deep after Fast failure", () => {
  const fast = evaluateExecutionPolicy({ state: state({ stage: "validating" }) });
  assert.equal(fast.nextAction, "run_validator");
  assert.equal(fast.role, "validator");
  assert.equal(fast.validatorMode, "fast");
  assert.equal(fast.projection.thinking, "low");

  const deep = evaluateExecutionPolicy({
    state: state({ stage: "validating" }),
    memory: {
      failure: {
        currentError: {
          type: "fast_validation_failure",
          validatorMode: "fast",
          message: "smoke tests failed",
        },
      },
    },
  });
  assert.equal(deep.validatorMode, "deep");
  assert.equal(deep.reasonCode, "VALIDATOR_DEEP_AFTER_FAST_FAILURE");
  assert.equal(deep.projection.thinking, "medium");
});

test("high-risk, security, architecture, and API compatibility tasks require Deep Validator", () => {
  for (const task of [
    { risk: "high" },
    { risk: "high-risk" },
    { constraints: ["security review required"] },
    { constraints: ["preserve architecture boundaries"] },
    { constraints: ["maintain API compatibility"] },
  ]) {
    const result = evaluateExecutionPolicy({ state: state({ stage: "validating" }), task });
    assert.equal(result.validatorMode, "deep", JSON.stringify(task));
    assert.equal(result.reasonCode, "VALIDATOR_DEEP_REQUIRED");
  }
});

test("two Luna failures with a snapshot route to fixed-high Sol, then back to validation", () => {
  const recovery = evaluateExecutionPolicy({
    state: state({
      phase: "open",
      stage: "failure_snapshot",
      lunaValidationFailures: 2,
      latestFailureSnapshotId: "fs-2",
    }),
    reasoningProfile: {
      taskId: "task-1",
      roles: { luna: { thinking: "high" }, sol: { thinking: "low" } },
    },
  });
  assert.equal(recovery.nextAction, "run_sol");
  assert.equal(recovery.role, "sol");
  assert.equal(recovery.projection.thinking, "high");
  assert.equal(recovery.budgetRole, "sol");

  const validating = evaluateExecutionPolicy({
    state: state({
      phase: "sol-recovery",
      stage: "validating",
      lunaValidationFailures: 2,
      solAttempted: true,
      latestFailureSnapshotId: "fs-2",
    }),
  });
  assert.equal(validating.nextAction, "run_validator");
  assert.equal(validating.validatorMode, "fast");

  const missingSnapshot = evaluateExecutionPolicy({
    state: state({ phase: "open", stage: "failure_snapshot", lunaValidationFailures: 2 }),
  });
  assert.equal(missingSnapshot.nextAction, "wait");
  assert.equal(missingSnapshot.reasonCode, "FAILURE_SNAPSHOT_REQUIRED");
});

test("terminal states return complete or escalate", () => {
  const complete = evaluateExecutionPolicy({ state: state({ phase: "passed", stage: "passed" }) });
  assert.equal(complete.nextAction, "complete");
  assert.equal(complete.role, null);

  const escalate = evaluateExecutionPolicy({ state: state({ phase: "escalated", stage: "escalated", solAttempted: true }) });
  assert.equal(escalate.nextAction, "escalate");
  assert.equal(escalate.role, null);
});

test("explicit action, role, and Validator mode are authorized only when policy matches", () => {
  const allowed = evaluateExecutionPolicy({
    state: state({ stage: "validating" }),
    action: "run_validator",
    role: "validator",
    validatorMode: "fast",
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reasonCode, "ACTION_AUTHORIZED");

  const denied = evaluateExecutionPolicy({
    state: state({ stage: "validating" }),
    action: "run_sol",
    role: "sol",
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.nextAction, "run_validator");
  assert.equal(denied.reasonCode, "ACTION_NOT_AUTHORIZED");
});

test("frozen profile rejects complexity and thinking drift during policy evaluation", () => {
  const profile = freezeReasoningProfile({ taskId: "task-1", complexity: "medium" }, 3);

  const complexityDrift = evaluateExecutionPolicy({
    state: state(),
    reasoningProfile: profile,
    complexity: "high",
  });
  assert.equal(complexityDrift.allowed, false);
  assert.equal(complexityDrift.reasonCode, "REASONING_PROFILE_DRIFT");

  const thinkingDrift = evaluateExecutionPolicy({
    state: state(),
    reasoningProfile: profile,
    action: "run_luna",
    role: "luna",
    thinking: "high",
  });
  assert.equal(thinkingDrift.allowed, false);
  assert.equal(thinkingDrift.reasonCode, "REASONING_PROFILE_DRIFT");

  const copyCheck = evaluateExecutionPolicy({ state: state(), reasoningProfile: profile });
  copyCheck.projection.thinking = "low";
  assert.equal(profile.roles.luna.thinking, "medium");
});
