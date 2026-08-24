import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TOKEN_BUDGETS,
  compactEnvelopeToBudget,
  estimateTokens,
  normalizeBudgetPolicy,
  resolveTokenBudget,
} from "../src/token-budget.js";

test("default role budgets use the requested thinking levels and output limits", () => {
  assert.deepEqual(DEFAULT_TOKEN_BUDGETS, {
    planner: { thinking: "high", outputTokens: 4000 },
    luna: { thinking: "medium", outputTokens: 8000 },
    validator: { thinking: "low", outputTokens: 2000 },
    sol: { thinking: "high", outputTokens: 6000 },
  });
  assert.deepEqual(resolveTokenBudget("luna", "medium"), {
    role: "luna", complexity: "medium", thinking: "medium", outputTokens: 8000,
  });
  assert.equal(resolveTokenBudget("planner", "low").outputTokens, 3000);
  assert.equal(resolveTokenBudget("sol", "high").outputTokens, 7500);
});

test("budget policy and custom token estimators are normalized and validated", () => {
  const estimator = (text) => text.length / 2;
  const policy = normalizeBudgetPolicy({
    roles: { validator: { thinking: "medium", maxTokens: 3000 } },
    estimator,
  });
  assert.deepEqual(policy.roles.validator, { thinking: "medium", outputTokens: 3000 });
  assert.equal(policy.estimator, estimator);
  assert.equal(estimateTokens("12345", estimator), 3);
  assert.throws(() => estimateTokens("x", () => -1), /finite non-negative/);
});

test("envelope compaction removes old events, long logs, and old tests first", () => {
  const envelope = {
    version: "2.0",
    runtime: {
      task_id: "t", context_id: "c", status: "failed", role: "sol", attempt: 2,
      events: Array.from({ length: 8 }, (_, index) => ({ index, log: "event".repeat(100) })),
    },
    goal: {
      objective: "Must remain exactly",
      acceptance: ["Acceptance must remain"],
      constraints: ["one", "two"],
    },
    state: { completed: ["a", "b"], pending: ["c"], blocked: [] },
    artifact: {
      changed_files: ["src/a.js"], diff_summary: "diff".repeat(1000),
      tests: Array.from({ length: 6 }, (_, index) => ({ index, log: "test".repeat(200) })),
      worker_reports: [], validation_reports: [],
    },
    failure: {
      attempt_history: [{ status: "failed" }],
      current_error: { type: "test_failure", message: "Must remain", log: "error".repeat(1000) },
      snapshots: [], current_snapshot_id: null,
    },
  };
  const original = structuredClone(envelope);
  const estimator = (text) => text.length;
  const compacted = compactEnvelopeToBudget(envelope, { inputTokens: 2000, estimator });

  assert.deepEqual(envelope, original);
  assert.equal(compacted.goal.objective, "Must remain exactly");
  assert.deepEqual(compacted.goal.acceptance, ["Acceptance must remain"]);
  assert.equal(compacted.failure.current_error.message, "Must remain");
  assert.ok(compacted.runtime.events.length < 8);
  assert.ok(compacted.artifact.tests.length < 6);
  assert.ok(estimateTokens(compacted, estimator) <= 2000);
  assert.throws(
    () => compactEnvelopeToBudget(envelope, { inputTokens: 10, estimator }),
    /Unable to compact Context Envelope/i,
  );
});
