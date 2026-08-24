import test from "node:test";
import assert from "node:assert/strict";
import {
  createFailureSnapshot,
  getFailureSnapshot,
  recordUsageFeedback,
  startTaskMemory,
} from "../src/task-memory.js";
import {
  adaptTokenBudget,
  resolveTokenBudget,
} from "../src/token-budget.js";
import {
  buildContextEnvelope,
  resolveContextProjection,
} from "../src/context-envelope.js";

test("v2.1 context projection exposes compact Root and deep Validator views", () => {
  let memory = startTaskMemory({
    taskId: "v21",
    contextId: "ctx-v21",
    objective: "upgrade router",
    acceptance: ["tests pass"],
    constraints: ["security review required"],
    reasoningProfile: { version: 1, taskId: "v21", roles: { luna: "medium" } },
  });
  memory = createFailureSnapshot(memory, {
    snapshotId: "failure-v21",
    decisionSummary: {
      attemptGoal: "upgrade router",
      approach: "incremental modules",
      reason: "avoid broad refactor",
      evidence: ["v2.0 is stable"],
      notAttempted: ["rewrite"],
      nextAction: "deep validation",
    },
  });

  assert.equal(resolveContextProjection("planner"), "root-summary");
  assert.equal(resolveContextProjection("validator", { validatorMode: "deep" }), "validator-deep");
  const root = buildContextEnvelope(memory, { role: "planner" });
  assert.equal(root.projection, "root-summary");
  assert.equal(root.artifact, null);
  assert.equal(root.decision.status, "active");

  const deep = buildContextEnvelope(memory, { role: "validator", validatorMode: "deep" });
  assert.equal(deep.projection, "validator-deep");
  assert.equal(deep.failure.snapshot.decision_summary.approach, "incremental modules");
});

test("Failure Snapshot stores bounded Decision Summary instead of chain of thought", () => {
  let memory = startTaskMemory({ taskId: "decision", objective: "repair" });
  memory = createFailureSnapshot(memory, {
    snapshotId: "decision-1",
    decision_summary: {
      attempt_goal: "fix expiration",
      approach: "modify token parser",
      reason: "expiry validation failed",
      evidence: ["auth test failed"],
      not_attempted: ["database migration"],
      next_action: "inspect affected auth files",
    },
  });
  const snapshot = getFailureSnapshot(memory);
  assert.deepEqual(snapshot.decisionSummary.notAttempted, ["database migration"]);
  assert.equal(snapshot.decisionSummary.reason, "expiry validation failed");
});

test("usage feedback adjusts token budgets within a bounded feedback loop", () => {
  const base = resolveTokenBudget("luna", "medium");
  const reduced = adaptTokenBudget(base, [
    { role: "luna", success: true, truncated: false },
    { role: "luna", success: true, truncated: false },
  ]);
  assert.ok(reduced.outputTokens < base.outputTokens);
  const increased = adaptTokenBudget(base, [
    { role: "luna", success: false, truncated: true },
    { role: "luna", success: false, truncated: true },
  ]);
  assert.ok(increased.outputTokens > base.outputTokens);
  assert.ok(increased.feedbackMultiplier <= 1.25);
  const isolated = adaptTokenBudget(base, [
    { role: "luna", taskType: "backend", success: false, truncated: true },
    { role: "luna", taskType: "frontend", success: true, truncated: false },
  ], { taskType: "frontend" });
  assert.ok(isolated.outputTokens < base.outputTokens);

  let memory = startTaskMemory({ taskId: "usage" });
  memory = recordUsageFeedback(memory, {
    requestId: "request-1",
    role: "luna",
    inputTokens: 5000,
    outputTokens: 3000,
    latencyMs: 1200,
    success: true,
  });
  const duplicate = recordUsageFeedback(memory, {
    requestId: "request-1",
    role: "luna",
    inputTokens: 1,
    outputTokens: 1,
    success: false,
  });
  assert.deepEqual(duplicate, memory);
  assert.equal(memory.runtime.usageFeedback.length, 1);
});
