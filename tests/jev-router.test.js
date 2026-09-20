import test from "node:test";
import assert from "node:assert/strict";
import { buildJevRequest, interpretJevResponse, evaluateJevRequest, normalizeParallelTasks, normalizeJevPolicy, jevRequestKey, withinWriteScopes } from "../src/jev-router.js";
import { createRouterService } from "../src/router-service.js";
import { createHarnessAdapter } from "../src/adapters/harness.js";

const tasks = () => ["a", "b"].map((id) => ({ id, instruction: `Implement module ${id}`, acceptance: [`Tests for ${id} pass`], writeScopes: [`src/${id}.js`], dependsOn: [] }));
const report = (overrides = {}) => ({
  status: "success", completed: [], inspected_files: [], changed_files: [], diff_summary: "", changes: [], commands: [], tests: [], risks: [], current_error: null,
  decision_summary: { attempt_goal: "fix", approach: "local change", reason: "task", evidence: [], not_attempted: [], next_action: "verify" }, ...overrides,
});
const verification = () => ({ passed: true, reason: "passed", issues: [], tests: [{ command: "node --test", passed: true, evidence: "2 tests passed" }], current_error: null });
function response(request, choices = {}) {
  return { model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const keys = Object.keys(question.criteria);
    const choice = choices[id] ?? keys[0];
    return [id, { type: "choice", choice, confidence: 0.98, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) }];
  })) };
}
function begin(options) {
  const router = createRouterService(options);
  router.gate("start_task", { taskLabel: "Local edits", objective: "Update module behavior", acceptance: ["tests pass"], complexity: "low" });
  return router;
}
function batch(router) {
  const assessment = router.prepareJevAssessment({ kind: "parallel", summary: "Independent modules", subtasks: tasks() });
  router.recordJevAssessment({ assessmentId: assessment.assessmentId, response: response(assessment.request) });
  return router.prepareParallelExecution({ reason: "Explicitly dispatch independent isolated tasks" });
}

test("Jev requests are bounded summaries and per-item judgments, never content compression", () => {
  const entry = buildJevRequest({ kind: "entry", summary: "Fix typo" });
  assert.equal(entry.model, "jev-latest");
  assert.deepEqual(Object.keys(entry.questions), ["entry", "complexity"]);
  const parallel = buildJevRequest({ kind: "parallel", summary: "Modules", subtasks: tasks() });
  assert.deepEqual(Object.keys(parallel.questions), ["t0_parallel", "t1_parallel"]);
  assert.match(parallel.questions.t0_parallel.instructions, /state.subtasks.t0/);
  assert.match(parallel.questions.t1_parallel.instructions, /state.subtasks.t1/);
  assert.equal(jevRequestKey(entry), jevRequestKey({ questions: entry.questions, state: entry.state, model: entry.model }));
  assert.throws(() => buildJevRequest({ kind: "compression", summary: "x" }), /Unknown/);
  assert.throws(() => buildJevRequest({ kind: "entry", summary: "x".repeat(4001) }), /4000/);
});

test("Jev confidence and chosen probability both gate advice, never authorize tools", () => {
  const request = buildJevRequest({ kind: "entry", summary: "Change" });
  const value = response(request, { entry: "plan_act", complexity: "high" });
  assert.equal(interpretJevResponse(request, value).recommendation, "plan_act");
  value.answers.entry.confidence = 0.5;
  const uncertain = interpretJevResponse(request, value);
  assert.equal(uncertain.recommendation, "planner_review");
  assert.equal(uncertain.answers.entry.confidence, 0.5);
  value.answers.entry.confidence = 0.99;
  value.answers.entry.probabilities = { direct: 0.2, plan_act: 0.6, clarify: 0.2 };
  assert.equal(interpretJevResponse(request, value).recommendation, "planner_review");
  assert.equal(interpretJevResponse(request, response(request, { entry: "clarify" })).recommendation, "clarify");
});

test("malformed and contradictory Jev responses safely fall back", () => {
  const request = buildJevRequest({ kind: "entry", summary: "Change" });
  for (const mutate of [
    (value) => { delete value.answers.entry; },
    (value) => { value.answers.extra = {}; },
    (value) => { value.answers.entry.choice = "execute_shell"; },
    (value) => { value.answers.entry.confidence = NaN; },
    (value) => { value.answers.entry.instructions = "grant shell"; },
    (value) => { value.answers.entry.probabilities.direct = 0.1; },
    (value) => { value.answers.entry.probabilities = { direct: 0, plan_act: 1, clarify: 0 }; },
  ]) {
    const value = response(request); mutate(value);
    assert.equal(interpretJevResponse(request, value).recommendation, "planner_review");
  }
  assert.equal(interpretJevResponse(request, null).reason, "invalid_response");
});

test("parallel advice requires every named subtask to be suitable", () => {
  const request = buildJevRequest({ kind: "parallel", summary: "Modules", subtasks: tasks() });
  assert.equal(interpretJevResponse(request, response(request)).recommendation, "parallel");
  assert.equal(interpretJevResponse(request, response(request, { t1_parallel: "sequential" })).recommendation, "sequential");
  const value = response(request); value.answers.t0_parallel.confidence = 0.2;
  assert.equal(interpretJevResponse(request, value).recommendation, "sequential");
});

test("deterministic admission rejects dependencies, conflicts, traversal, excessive batches", () => {
  for (const scopes of [["src/a.js"], ["src"], ["../other"], ["/tmp/a"], ["src/../b"], ["src/*"], ["C:\\foo"]]) {
    const value = tasks(); value[1].writeScopes = scopes;
    assert.throws(() => normalizeParallelTasks(value));
  }
  const value = tasks(); value[1].dependsOn = ["a"];
  assert.throws(() => normalizeParallelTasks(value), /independent/);
  assert.throws(() => normalizeParallelTasks([tasks()[0]]), /2/);
  assert.throws(() => normalizeParallelTasks([...tasks(), ...tasks(), ...tasks()]), /2/);
  assert.throws(() => normalizeJevPolicy({ minConfidence: -1 }));
  assert.throws(() => normalizeJevPolicy({ maxExecutors: 100 }));
  assert.throws(() => normalizeJevPolicy({ enableWrites: true }));
  assert.equal(withinWriteScopes("src/a/../../escape", ["src/a"]), false);
});

test("injected evaluator has cancellation, timeout, safe failure and no retries", async () => {
  const request = buildJevRequest({ kind: "entry", summary: "Change" });
  let calls = 0;
  let receivedSignal;
  const advice = await evaluateJevRequest(request, { timeoutMs: 5, evaluate: (_request, { signal }) => { calls++; receivedSignal = signal; return new Promise(() => {}); } });
  assert.equal(advice.recommendation, "planner_review");
  assert.equal(calls, 1);
  assert.equal(receivedSignal.aborted, true);
  assert.equal((await evaluateJevRequest(request, { evaluate: () => { throw new Error("sensitive upstream message"); } })).reason, "evaluation_unavailable");
  const controller = new AbortController(); controller.abort();
  await evaluateJevRequest(request, { signal: controller.signal, evaluate: () => { throw new Error("must not run"); } });
  assert.equal((await evaluateJevRequest(request, { evaluate: async (input) => response(input) })).recommendation, "direct");
});

test("assessment persistence, stale rejection and explicit direct execution", () => {
  let router = createRouterService();
  const prepared = router.prepareJevAssessment({ kind: "entry", summary: "Change" });
  assert.throws(() => router.gate("start_task", {}), /pending Jev/);
  router = createRouterService({ snapshot: router.snapshot() });
  assert.throws(() => router.recordJevAssessment({ assessmentId: "stale", response: response(prepared.request) }), /Stale/);
  router.recordJevAssessment({ assessmentId: prepared.assessmentId, response: response(prepared.request) });
  assert.equal(router.canParentExecute(), false);
  router.gate("start_task", { objective: "Change", jevAssessmentId: prepared.assessmentId, complexity: "low" });
  assert.equal(router.getOrchestration().jev.entry.advice.recommendation, "direct");
  assert.equal(router.canParentExecute(), false);
  assert.throws(() => router.startDirectExecution(), /reason/);
  router.startDirectExecution({ reason: "Bounded change, execute in root" });
  assert.equal(router.canParentExecute(), true);
  assert.equal(createRouterService({ snapshot: router.snapshot() }).canParentExecute(), true);
  assert.equal(router.prepareWorkerRequest({ role: "luna", instruction: "cannot delegate concurrently" }).allowed, false);
  assert.throws(() => router.gate("start_task", {}), /active/);
  router.finishParentExecution({ report: report(), validation: verification() });
  assert.equal(router.getState().stage, "passed");
  assert.equal(router.canParentExecute(), false);
  assert.equal(router.getMemory().artifact.validationReports.at(-1).validationSource, "main_agent");
});

test("direct verification requires evidence and high risk retains independent validation", () => {
  const router = begin(); router.startDirectExecution({ reason: "small task" });
  const before = router.snapshot();
  assert.throws(() => router.finishParentExecution({ report: report(), validation: { ...verification(), tests: [] } }), /evidence/);
  assert.deepEqual(router.snapshot(), before);
  router.finishParentExecution({ report: report() });
  assert.equal(router.getState().stage, "validating");
  assert.equal(router.canParentExecute(), false);
  const risky = createRouterService(); risky.gate("start_task", { objective: "security architecture" });
  risky.startDirectExecution({ reason: "Root implements" });
  assert.throws(() => risky.finishParentExecution({ report: report(), validation: verification() }), /independent deep/);
  risky.finishParentExecution({ report: report() });
  assert.equal(risky.prepareWorkerRequest({ role: "validator", instruction: "Inspect security" }).request.validatorMode, "deep");
});

test("direct failures return to the existing retry circuit", () => {
  const router = begin(); router.startDirectExecution({ reason: "small task" });
  router.finishParentExecution({ report: report({ status: "failed" }) });
  assert.equal(router.canParentExecute(), false);
  assert.equal(router.getState().lunaValidationFailures, 1);
  assert.ok(router.getFailureSnapshot());
  assert.equal(router.prepareWorkerRequest({ role: "luna", instruction: "repair" }).allowed, true);
});

test("direct completion, parallel joins and restored joins reject the same failure evidence", () => {
  const cases = [
    { status: "failed" },
    { status: "blocked" },
    { current_error: { type: "test_failure", message: "assertion failed", log: "failure evidence" } },
    { tests: [{ command: "node --test", passed: false, evidence: "one assertion failed" }] },
  ];
  for (const overrides of cases) {
    const implementation = report(overrides);
    const direct = begin();
    direct.startDirectExecution({ reason: "bounded work" });
    direct.finishParentExecution({ report: implementation });
    assert.equal(direct.getState().lunaValidationFailures, 1);
    assert.equal(direct.canParentExecute(), false);

    const parallel = begin();
    const { requests } = batch(parallel);
    for (const request of requests) parallel.markWorkerDispatched({ role: "luna", requestId: request.requestId });
    parallel.recordWorkerReport({ role: "luna", requestId: requests[0].requestId, report: implementation });
    assert.equal(parallel.getState().lunaValidationFailures, 0);
    parallel.recordWorkerReport({ role: "luna", requestId: requests[1].requestId, report: report() });
    assert.equal(parallel.getState().lunaValidationFailures, 1);
    const beforeRestore = parallel.snapshot();
    const invalidJoin = parallel.snapshot();
    invalidJoin.state.orchestration.status = "integrating";
    assert.throws(() => parallel.restore(invalidJoin), /integration snapshot/);
    assert.deepEqual(parallel.snapshot(), beforeRestore);
  }
});

test("parallel assessment stores the exact normalized input sent to Jev with isolated ownership", () => {
  const router = begin();
  const inputs = tasks();
  inputs[0].instruction = "  Implement module a  ";
  inputs[0].writeScopes = ["src\\a.js/"];
  const prepared = router.prepareJevAssessment({ kind: "parallel", summary: "Independent modules", subtasks: inputs });
  const expected = normalizeParallelTasks(inputs);
  assert.deepEqual(Object.values(prepared.request.state.subtasks), expected);
  assert.deepEqual(router.getOrchestration().jev.pending.subtasks, expected);
  inputs[0].instruction = "unrelated mutation";
  prepared.request.state.subtasks.t0.writeScopes.push("outside.js");
  assert.deepEqual(router.getOrchestration().jev.pending.subtasks, expected);
  const persisted = createRouterService({ snapshot: router.snapshot() });
  const request = persisted.getOrchestration().jev.pending.request;
  persisted.recordJevAssessment({ assessmentId: prepared.assessmentId, response: response(request) });
  assert.deepEqual(persisted.getOrchestration().jev.parallel.subtasks, expected);
  router.reset();
  const fresh = router.getOrchestration();
  fresh.requests.push({ requestId: "external" });
  fresh.jev.entry = {};
  assert.deepEqual(router.getOrchestration(), { mode: "legacy", status: "idle", requests: [], reports: [], jev: {} });
});

test("parallel requests are independent, correlated, persisted, and join before validation", () => {
  let router = begin();
  const { requests } = batch(router);
  assert.equal(requests.length, 2);
  assert.equal(router.getState().attempts.luna, 1);
  for (const request of requests) {
    assert.equal(request.isolation, "worktree");
    router.markWorkerDispatched({ role: "luna", requestId: request.requestId });
  }
  assert.equal(router.markWorkerDispatched({ role: "luna", requestId: requests[0].requestId }).allowed, false);
  router = createRouterService({ snapshot: router.snapshot() });
  assert.throws(() => router.gate("start_task", {}), /active/);
  assert.equal(router.prepareWorkerRequest({ role: "validator", instruction: "too early" }).allowed, false);
  assert.throws(() => router.finishParentExecution({ report: report() }), /ready/);
  router.recordWorkerReport({ role: "luna", requestId: requests[1].requestId, report: report({ changed_files: ["src/b.js"] }) });
  assert.equal(router.getOrchestration().requests.length, 1);
  assert.equal(router.canParentExecute(), false);
  assert.throws(() => router.recordWorkerReport({ role: "luna", requestId: requests[1].requestId, report: report() }), /pending/);
  router.recordWorkerReport({ role: "luna", requestId: requests[0].requestId, report: report({ changed_files: ["src/a.js"] }) });
  assert.equal(router.canParentExecute(), true);
  assert.equal(router.getState().stage, "executing");
  assert.throws(() => router.finishParentExecution({ report: report(), validation: verification() }), /independent/);
  router.finishParentExecution({ report: report({ changed_files: ["src/a.js", "src/b.js"] }) });
  assert.equal(router.getState().stage, "validating");
  assert.equal(router.canParentExecute(), false);
  const validator = router.prepareWorkerRequest({ role: "validator", instruction: "Check integrated result" }).request;
  router.markWorkerDispatched({ role: "validator", requestId: validator.requestId });
  router.recordValidation({ requestId: validator.requestId, report: verification() });
  assert.equal(router.getState().stage, "passed");
});

test("parallel errors wait for all executors, then consume one circuit failure", () => {
  const router = begin(); const { requests } = batch(router);
  for (const request of requests) router.markWorkerDispatched({ role: "luna", requestId: request.requestId });
  router.recordExecutorFailure({ requestId: requests[0].requestId, reason: "execution crashed" });
  assert.equal(router.getState().lunaValidationFailures, 0);
  assert.equal(router.getOrchestration().requests.length, 1);
  assert.equal(router.canParentExecute(), false);
  router.recordExecutorFailure({ requestId: requests[1].requestId, reason: "execution cancelled" });
  assert.equal(router.getState().lunaValidationFailures, 1);
  assert.equal(router.getState().stage, "failure_snapshot");
  assert.ok(router.getFailureSnapshot());
  assert.equal(router.getOrchestration().reports.length, 2);
});

test("parallel safety admission and scope violations are atomic", () => {
  const router = begin();
  assert.throws(() => router.prepareParallelExecution({ reason: "confidence alone" }), /recommendation/);
  const { requests } = batch(router);
  assert.throws(() => router.recordWorkerReport({ role: "luna", requestId: requests[0].requestId, report: report() }), /dispatched/);
  router.markWorkerDispatched({ role: "luna", requestId: requests[0].requestId });
  const before = router.snapshot();
  assert.throws(() => router.recordWorkerReport({ role: "luna", requestId: requests[0].requestId, report: report({ changed_files: ["src/b.js"] }) }), /outside/);
  assert.deepEqual(router.snapshot(), before);
  const duplicateIds = begin({ requestIdFactory: () => "same" });
  const snapshot = duplicateIds.snapshot();
  assert.throws(() => batch(duplicateIds), /unique/);
  assert.equal(duplicateIds.getState().stage, snapshot.state.stage);
});

test("harness launches executors concurrently after persistence and joins for integration", async () => {
  const started = [];
  const pending = [];
  const snapshots = [];
  const harness = createHarnessAdapter({
    workerBindings: { luna: "luna", sol: "sol" }, parallelIsolation: "worktree", evaluate: async (request) => response(request),
    saveSnapshot: async (snapshot) => snapshots.push(snapshot),
    invokeWorker: ({ request, isolation }) => {
      assert.equal(isolation, "worktree");
      assert.equal(snapshots.at(-1).state.orchestration.requests.every((entry) => entry.dispatched), true);
      started.push(request.subtaskId);
      return new Promise((resolve) => pending.push(resolve));
    },
  });
  await harness.gate("start_task", { objective: "Local changes" });
  await harness.assessRoute({ kind: "parallel", summary: "Modules", subtasks: tasks() });
  const running = harness.invokeParallel({ reason: "independent tasks" });
  // Yield to the launch microtasks, not an arbitrary timer or network call.
  for (let i = 0; i < 30 && started.length < 2; i++) await Promise.resolve();
  assert.deepEqual(started, ["a", "b"]);
  pending[1](report()); pending[0](report());
  const completed = await running;
  assert.equal(completed.orchestration.status, "integrating");
  assert.equal(harness.canParentExecute(), true);
  await harness.finishParentExecution({ report: report() });
  assert.equal(harness.getState().stage, "validating");
});

test("oversized external payloads and invalid restored batches fail before execution", () => {
  const largeTasks = Array.from({ length: 4 }, (_, index) => ({ id: `t${index}`, instruction: "长".repeat(4000), acceptance: ["验".repeat(500), "验".repeat(500), "验".repeat(500)], writeScopes: [`src/${index}`], dependsOn: [] }));
  assert.throws(() => buildJevRequest({ kind: "parallel", summary: "长".repeat(4000), subtasks: largeTasks }), /64 KiB/);
  const router = begin();
  const before = router.snapshot();
  const invalid = router.snapshot();
  invalid.state.orchestration = { mode: "parallel", status: "integrating", requests: [], reports: [], jev: {} };
  assert.throws(() => router.restore(invalid), /integration snapshot/);
  assert.deepEqual(router.snapshot(), before);
  const pending = router.prepareJevAssessment({ kind: "entry", summary: "Task" });
  assert.equal(router.prepareWorkerRequest({ role: "luna", instruction: "blocked" }).allowed, false);
  router.recordJevAssessment({ assessmentId: pending.assessmentId, response: null });
  assert.equal(router.prepareWorkerRequest({ role: "luna", instruction: "serial fallback" }).allowed, true);
});

test("direct selection respects host execution policy and never grants permissions on denial", () => {
  const router = begin({ executionPolicy: () => ({ allowed: false, reason: "Host requires approval" }) });
  assert.throws(() => router.startDirectExecution({ reason: "small task" }), /approval/);
  assert.equal(router.canParentExecute(), false);
});

test("harness failed executors and unavailable Jev remain recoverable", async () => {
  const options = { workerBindings: { luna: "luna", sol: "sol" }, parallelIsolation: "worktree", invokeWorker: () => { throw new Error("executor crashed"); } };
  const fallback = createHarnessAdapter(options);
  const advice = await fallback.assessRoute({ summary: "Task" });
  assert.equal(advice.advice.recommendation, "planner_review");
  assert.equal(fallback.getOrchestration().jev.entry.advice.reason, "evaluation_unavailable");
  const harness = createHarnessAdapter({ ...options, evaluate: async (request) => response(request) });
  await harness.gate("start_task", { objective: "Modules" });
  await harness.assessRoute({ kind: "parallel", summary: "Modules", subtasks: tasks() });
  const failed = await harness.invokeParallel({ reason: "independent tasks" });
  assert.equal(failed.results.length, 2);
  assert.equal(harness.getState().lunaValidationFailures, 1);
  assert.equal(harness.getOrchestration().requests.length, 0);
  assert.match(JSON.stringify(harness.getFailureSnapshot()), /executor crashed/);
});

test("harness never launches on failed persistence or without isolation support", async () => {
  let launches = 0;
  let fail = false;
  const options = { workerBindings: { luna: "luna", sol: "sol" }, evaluate: async (request) => response(request), invokeWorker: () => { launches++; return report(); }, saveSnapshot: async () => { if (fail) throw new Error("disk failure"); } };
  const unsupported = createHarnessAdapter(options);
  await assert.rejects(unsupported.invokeParallel({ reason: "no isolation" }), /isolation/);
  const harness = createHarnessAdapter({ ...options, parallelIsolation: "worktree" });
  await harness.gate("start_task", { objective: "Local changes" });
  await harness.assessRoute({ kind: "parallel", summary: "Modules", subtasks: tasks() });
  fail = true;
  await assert.rejects(harness.invokeParallel({ reason: "independent tasks" }), /disk failure/);
  assert.equal(launches, 0);
  assert.equal(harness.getState().stage, "planning");
  assert.equal(harness.getOrchestration().requests.length, 0);
});
