import test from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_STATE_VERSION,
  createRouterService,
} from "../src/router-service.js";

function deterministicRouter(overrides = {}) {
  let request = 0;
  let failure = 0;
  return createRouterService({
    taskIdFactory: () => "generated-task",
    contextIdFactory: ({ taskId }) => `context-${taskId}`,
    requestIdFactory: () => `request-${++request}`,
    snapshotIdFactory: () => `failure-${++failure}`,
    ...overrides,
  });
}

function dispatch(router, prepared) {
  const result = router.markWorkerDispatched({
    role: prepared.request.role,
    requestId: prepared.request.requestId,
  });
  assert.equal(result.allowed, true);
}

function openCircuit(router) {
  router.gate("start_task", { taskId: "task-open", taskLabel: "open circuit" });
  router.gate("luna_failed", { reason: "first validation failed" });
  router.gate("luna_failed", { reason: "second validation failed" });
}

test("router snapshot keeps the compatible outer shape and persists v2 memory", () => {
  const router = deterministicRouter();
  const state = router.getState();
  state.phase = "escalated";
  assert.equal(router.getState().phase, "idle");
  const snapshot = router.snapshot();
  assert.equal(snapshot.version, ROUTER_STATE_VERSION);
  assert.equal(snapshot.state.phase, "idle");
  assert.equal(snapshot.state.memory.version, "2.0");
  assert.equal(snapshot.state.pendingRequest, null);
  assert.equal(Number.isInteger(snapshot.state.revision), true);

  snapshot.state.memory.runtime.status = "mutated";
  assert.equal(router.getMemory().runtime.status, "idle");
});

test("router restores raw v1 state and versioned v2 snapshots", () => {
  const router = deterministicRouter({
    snapshot: { version: 1, state: { phase: "luna", lunaValidationFailures: 1, taskId: "restored" } },
  });
  assert.equal(router.getState().taskId, "restored");
  assert.equal(router.getState().phase, "luna");
  assert.equal(router.getMemory().runtime.taskId, "restored");

  router.gate("start_task", { taskId: "v2", objective: "persist memory", acceptance: ["tests pass"] });
  const stored = router.snapshot();
  const restored = deterministicRouter({ snapshot: stored });
  assert.equal(restored.getState().contextId, "context-v2");
  assert.equal(restored.getMemory().task.objective, "persist memory");
  assert.deepEqual(restored.getMemory().task.acceptance, ["tests pass"]);
});

test("start_task creates task and context memory using injected factories", () => {
  const router = deterministicRouter();
  const update = router.gate("start_task", {
    taskLabel: "generated",
    acceptance: ["npm test passes"],
    constraints: ["keep API"],
  });
  assert.equal(update.state.taskId, "generated-task");
  assert.equal(update.state.contextId, "context-generated-task");
  assert.equal(update.state.stage, "planning");
  assert.deepEqual(router.getMemory().task.acceptance, ["npm test passes"]);
});

test("prepareWorkerRequest builds a cache-friendly request and records completion", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "task-request", taskLabel: "implement feature" });
  const prepared = router.prepareWorkerRequest({
    role: "luna",
    instruction: "Implement the approved feature",
    complexity: "medium",
  });
  assert.equal(prepared.allowed, true);
  assert.equal(prepared.request.requestId, "request-1");
  assert.equal(prepared.request.taskId, "task-request");
  assert.equal(prepared.request.contextId, "context-task-request");
  assert.equal(prepared.request.snapshotId, null);
  assert.equal(prepared.request.contextEnvelope.runtime.request_id, "request-1");
  assert.equal(prepared.request.contextEnvelope.runtime.stage, "executing");
  assert.equal(prepared.request.budget.thinking, "medium");
  assert.equal(prepared.request.budget.maxOutputTokens, 8000);
  assert.match(prepared.request.renderedPrompt, /<CONTEXT_ENVELOPE>/);
  assert.equal(router.getState().stage, "executing");
  const dispatched = router.markWorkerDispatched({ role: "luna", requestId: "request-1" });
  assert.equal(dispatched.allowed, true);
  assert.equal(router.getPendingRequest().dispatched, true);
  assert.equal(router.markWorkerDispatched({ role: "luna", requestId: "request-1" }).allowed, false);

  const completed = router.recordWorkerReport({
    role: "luna",
    requestId: "request-1",
    report: {
      status: "success",
      modifiedFiles: ["src/a.js"],
      diffSummary: "Implemented feature",
      tests: [{ command: "npm test", passed: true }],
    },
  });
  assert.equal(completed.state.stage, "validating");
  assert.deepEqual(router.getMemory().artifact.modifiedFiles, ["src/a.js"]);
  assert.equal(router.getPendingRequest(), null);
});

test("validator failure creates a snapshot, permits one retry, then opens Sol recovery", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "task-flow", taskLabel: "flow" });

  const firstLuna = router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  dispatch(router, firstLuna);
  router.recordWorkerReport({ role: "luna", requestId: firstLuna.request.requestId, report: { modifiedFiles: ["a.js"] } });
  const validator = router.prepareWorkerRequest({ role: "validator", instruction: "Validate diff" });
  dispatch(router, validator);
  const fastFailure = router.recordValidation({
    role: "luna",
    requestId: validator.request.requestId,
    report: { passed: false, reason: "unit test failed", log: "assertion" },
  });
  assert.equal(fastFailure.state.phase, "luna");
  assert.equal(fastFailure.state.validatorMode, "deep");
  assert.equal(fastFailure.state.latestFailureSnapshotId, null);
  const deepValidator = router.prepareWorkerRequest({ role: "validator", validatorMode: "deep", instruction: "Deep validate diff" });
  dispatch(router, deepValidator);
  const firstFailure = router.recordValidation({
    role: "luna",
    requestId: deepValidator.request.requestId,
    report: { passed: false, reason: "deep validation failed", log: "assertion" },
  });
  assert.equal(firstFailure.state.latestFailureSnapshotId, "failure-1");
  assert.equal(router.getFailureSnapshot().modifiedFiles[0], "a.js");

  const retry = router.prepareWorkerRequest({ role: "luna", instruction: "Fix the failed test" });
  dispatch(router, retry);
  router.recordWorkerReport({ role: "luna", requestId: retry.request.requestId, report: { status: "success" } });
  const secondValidator = router.prepareWorkerRequest({ role: "validator", instruction: "Validate retry" });
  dispatch(router, secondValidator);
  const secondFast = router.recordValidation({
    role: "luna",
    requestId: secondValidator.request.requestId,
    report: { passed: false, reason: "still failing" },
  });
  assert.equal(secondFast.state.validatorMode, "deep");
  const secondDeepValidator = router.prepareWorkerRequest({ role: "validator", validatorMode: "deep", instruction: "Deep validate retry" });
  dispatch(router, secondDeepValidator);
  const open = router.recordValidation({
    role: "luna",
    requestId: secondDeepValidator.request.requestId,
    report: { passed: false, reason: "still failing after deep validation" },
  });
  assert.equal(open.state.phase, "open");
  assert.equal(open.state.latestFailureSnapshotId, "failure-2");

  const sol = router.prepareWorkerRequest({ role: "sol", instruction: "Recover from latest failure" });
  assert.equal(sol.allowed, true);
  assert.equal(sol.request.snapshotId, "failure-2");
  assert.equal(sol.request.contextEnvelope.failure.current_snapshot_id, "failure-2");
  assert.equal(sol.state.phase, "sol-recovery");
  assert.equal(sol.state.solAttempted, true);
});

test("validation pass and failed Sol validation reach terminal states", () => {
  const success = deterministicRouter();
  success.gate("start_task", { taskId: "pass", taskLabel: "pass" });
  const luna = success.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  dispatch(success, luna);
  success.recordWorkerReport({ role: "luna", requestId: luna.request.requestId, report: {} });
  const validator = success.prepareWorkerRequest({ role: "validator", instruction: "Validate" });
  dispatch(success, validator);
  const passed = success.recordValidation({ role: "luna", requestId: validator.request.requestId, report: { passed: true } });
  assert.equal(passed.state.phase, "passed");

  const recovery = deterministicRouter();
  openCircuit(recovery);
  const sol = recovery.prepareWorkerRequest({ role: "sol", instruction: "Recover" });
  dispatch(recovery, sol);
  recovery.recordWorkerReport({ role: "sol", requestId: sol.request.requestId, report: {} });
  const recoveryValidator = recovery.prepareWorkerRequest({ role: "validator", instruction: "Validate recovery" });
  dispatch(recovery, recoveryValidator);
  const fastRecoveryFailure = recovery.recordValidation({ role: "sol", requestId: recoveryValidator.request.requestId, report: { passed: false, reason: "recovery failed" } });
  assert.equal(fastRecoveryFailure.state.validatorMode, "deep");
  const recoveryDeepValidator = recovery.prepareWorkerRequest({ role: "validator", validatorMode: "deep", instruction: "Deep validate recovery" });
  dispatch(recovery, recoveryDeepValidator);
  const escalated = recovery.recordValidation({ role: "sol", requestId: recoveryDeepValidator.request.requestId, report: { passed: false, reason: "deep recovery validation failed" } });
  assert.equal(escalated.state.phase, "escalated");
  assert.equal(escalated.state.solAttempted, true);
});

test("stale results, overlapping prepares, and invalid validation are rejected atomically", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "stale", taskLabel: "stale" });
  router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  const before = router.snapshot();
  assert.throws(
    () => router.recordWorkerReport({ role: "luna", requestId: "wrong", report: { changed_files: ["bad.js"] } }),
    /stale or mismatched/i,
  );
  assert.deepEqual(router.snapshot(), before);

  const overlapping = router.prepareWorkerRequest({ role: "luna", instruction: "Overwrite pending" });
  assert.equal(overlapping.allowed, false);
  assert.match(overlapping.reason, /still pending/i);
  assert.deepEqual(router.snapshot(), before);

  const planning = deterministicRouter();
  planning.gate("start_task", { taskId: "planning", taskLabel: "planning" });
  const planningBefore = planning.snapshot();
  assert.throws(() => planning.recordValidation({ role: "luna", report: { passed: true } }), /only during validating/i);
  assert.deepEqual(planning.snapshot(), planningBefore);
  assert.throws(() => planning.gate("sol_failed", { reason: "invalid recovery failure" }), /only after/i);
  assert.deepEqual(planning.snapshot(), planningBefore);
});

test("a transition failure rolls back report memory mutations", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "atomic", taskLabel: "atomic" });
  const prepared = router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  dispatch(router, prepared);
  const corrupted = router.snapshot();
  corrupted.state.stage = "planning";
  corrupted.state.activeRole = "planner";
  router.restore(corrupted);
  const before = router.snapshot();
  assert.throws(() => router.recordWorkerReport({
    role: "luna",
    requestId: prepared.request.requestId,
    report: { changed_files: ["should-not-persist.js"] },
  }), /Cannot complete luna/i);
  assert.deepEqual(router.snapshot(), before);
  assert.deepEqual(router.getMemory().artifact.modifiedFiles, []);
});

test("legacy worker preparation still atomically starts Sol", () => {
  const router = deterministicRouter();
  openCircuit(router);
  const luna = router.prepareWorkerCall({ role: "luna" });
  assert.equal(luna.allowed, false);
  const sol = router.prepareWorkerCall({ role: "sol" });
  assert.equal(sol.allowed, true);
  assert.equal(sol.state.phase, "sol-recovery");
  assert.equal(router.prepareWorkerCall({ role: "sol" }).allowed, false);
});

test("status is read-only and reset clears memory and pending requests", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "task-status", taskLabel: "status" });
  router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  const status = router.gate("status");
  assert.equal(status.changed, false);
  const reset = router.reset();
  assert.equal(reset.changed, true);
  assert.equal(router.getState().phase, "idle");
  assert.equal(router.getMemory().runtime.taskId, null);
  assert.equal(router.getPendingRequest(), null);
});

test("the input budget applies to the complete rendered prompt and custom estimator", () => {
  let estimatorCalls = 0;
  const router = deterministicRouter({
    budgetPolicy: {
      estimator(text) {
        estimatorCalls += 1;
        return text.length;
      },
    },
  });
  router.gate("start_task", { taskId: "budget", taskLabel: "budget" });
  const before = router.snapshot();
  assert.throws(() => router.prepareWorkerRequest({
    role: "luna",
    instruction: "very long task ".repeat(5000),
    maxInputTokens: 500,
  }), /input budget|exceeding|Unable to compact Context Envelope/i);
  assert.ok(estimatorCalls > 0);
  assert.deepEqual(router.snapshot(), before);
});

test("reasoning profile is frozen, persisted, and reused by all task workers", () => {
  const router = deterministicRouter();
  router.gate("start_task", { taskId: "profile", taskLabel: "profile", complexity: "high" });
  assert.equal(router.getReasoningProfile().complexity, "high");
  const blocked = router.prepareWorkerRequest({ role: "luna", instruction: "Drift", complexity: "low" });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /frozen/i);
  const luna = router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  assert.equal(luna.request.budget.thinking, "medium");
  assert.equal(luna.request.reasoningProfile.roles.sol.thinking, "high");

  const restored = deterministicRouter({ snapshot: router.snapshot() });
  assert.deepEqual(restored.getReasoningProfile(), router.getReasoningProfile());
});

test("semantic retrieval and usage feedback are opt-in and influence later budgets", () => {
  const router = deterministicRouter();
  router.addSemanticMemory({
    id: "webpack-pin",
    taskType: "frontend",
    summary: "webpack upgrade dependency conflict",
    problem: "dependency conflict",
    resolution: "pin compatible version",
    tags: ["webpack"],
    success: true,
  });
  router.gate("start_task", { taskId: "semantic", taskLabel: "webpack upgrade" });
  const request = router.prepareWorkerRequest({ role: "luna", instruction: "Resolve webpack dependency conflict" });
  assert.deepEqual(request.request.semanticMatches.map(({ id }) => id), ["webpack-pin"]);
  assert.equal(request.request.contextEnvelope.semantic[0].id, "webpack-pin");

  const feedbackRouter = deterministicRouter();
  feedbackRouter.gate("start_task", { taskId: "feedback", taskLabel: "feedback", taskType: "general" });
  feedbackRouter.recordUsageFeedback({
    requestId: "historical-luna-1",
    role: "luna",
    inputTokens: 1000,
    outputTokens: 500,
    success: true,
    truncated: false,
    taskType: "general",
  });
  feedbackRouter.recordUsageFeedback({
    requestId: "historical-luna-2",
    role: "luna",
    inputTokens: 1000,
    outputTokens: 500,
    success: true,
    truncated: false,
    taskType: "general",
  });
  const adapted = feedbackRouter.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  assert.equal(adapted.request.budget.feedbackSamples, 2);
  assert.ok(adapted.request.budget.maxOutputTokens < 8000);
});

test("custom policy, retriever, and async event sink failures fall back safely", async () => {
  const router = deterministicRouter({
    executionPolicy() { throw new Error("policy plugin failed"); },
    memoryRetriever() { throw new Error("retriever plugin failed"); },
    eventSink: async () => { throw new Error("async analytics failed"); },
  });
  router.gate("start_task", { taskId: "fallbacks", taskLabel: "fallbacks" });
  const request = router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  assert.equal(request.allowed, true);
  assert.deepEqual(request.request.semanticMatches, []);
  assert.ok(router.getMemory().runtime.events.every((event) => typeof event.type === "string" && event.type.length > 0));
  await Promise.resolve();
});

test("runtime lifecycle events are persisted and sink failures are isolated", () => {
  const seen = [];
  const router = deterministicRouter({
    eventSink(event) {
      seen.push(event.type);
      if (event.type === "agent_selected") throw new Error("analytics unavailable");
    },
  });
  router.gate("start_task", { taskId: "events", taskLabel: "events" });
  const luna = router.prepareWorkerRequest({ role: "luna", instruction: "Implement" });
  dispatch(router, luna);
  assert.ok(seen.includes("task_started"));
  assert.ok(seen.includes("reasoning_profile_frozen"));
  assert.ok(seen.includes("agent_selected"));
  assert.ok(seen.includes("worker_dispatched"));
  assert.ok(router.getMemory().runtime.events.some(({ type }) => type === "agent_selected"));
});

test("unknown worker roles are rejected", () => {
  const router = deterministicRouter();
  assert.throws(() => router.prepareWorkerCall({ role: "builder" }), /Unknown router worker role/);
});
