import test from "node:test";
import assert from "node:assert/strict";
import { createFailureSnapshot, startTaskMemory } from "../src/task-memory.js";
import { buildContextEnvelope, canonicalStringify } from "../src/context-envelope.js";
import { compactEnvelopeToBudget, resolveTokenBudget } from "../src/token-budget.js";
import { renderWorkerPrompt } from "../src/prompt-protocol.js";
import { createRouterService } from "../src/router-service.js";
import { normalizeModelRoutes, DEFAULT_RUNTIME_MODEL_ROUTES } from "../src/model-routing.js";

const snapshotId = (memory, details) => createFailureSnapshot(memory, details).failure.currentSnapshotId;

test("snapshot IDs include nested evidence and ignore object key insertion order", () => {
  const memory = startTaskMemory({ taskId: "hash", contextId: "ctx" });
  const first = { currentError: { type: "test", message: "first", log: "a" }, validation: { passed: false, reason: "first" } };
  const second = { currentError: { type: "test", message: "second", log: "a" }, validation: first.validation };
  assert.notEqual(snapshotId(memory, first), snapshotId(memory, second));
  assert.notEqual(snapshotId(memory, first), snapshotId(memory, { ...first, validation: { passed: false, reason: "other" } }));
  assert.equal(snapshotId(memory, first), snapshotId(memory, {
    validation: { reason: "first", passed: false },
    currentError: { log: "a", message: "first", type: "test" },
  }));
  assert.equal(snapshotId(memory, { ...first, snapshotId: "legacy-id" }), "legacy-id");
  assert.notEqual(snapshotId(memory, { ...first, attemptHistory: [{ error: { message: "one" } }] }), snapshotId(memory, { ...first, attemptHistory: [{ error: { message: "two" } }] }));
  assert.notEqual(snapshotId(memory, { ...first, decisionSummary: { approach: "one" } }), snapshotId(memory, { ...first, decisionSummary: { approach: "two" } }));
  assert.equal(canonicalStringify(JSON.parse('{"__proto__":{"data":1}}')), '{"__proto__":{"data":1}}');
  assert.throws(() => canonicalStringify({ x: 1n }), /BigInt/);
  const circular = {}; circular.self = circular;
  assert.throws(() => canonicalStringify(circular), /circular/);
});

test("worker JSON is compact by default with an explicit pretty debug option", () => {
  const options = { role: "luna", currentTask: "Keep whitespace inside strings: a  b\nc", contextEnvelope: buildContextEnvelope(startTaskMemory({ taskId: "compact", objective: "a  b\nc" }), { role: "luna" }) };
  const compact = renderWorkerPrompt(options);
  const pretty = renderWorkerPrompt({ ...options, serialization: { pretty: true } });
  assert.ok(compact.length < pretty.length);
  const envelope = (prompt) => JSON.parse(prompt.split("<CONTEXT_ENVELOPE>\n")[1].split("\n</CONTEXT_ENVELOPE>")[0]);
  assert.deepEqual(envelope(compact), envelope(pretty));
  assert.equal(envelope(compact).goal.objective, "a  b\nc");
  assert.equal(compact.split("<CONTEXT_ENVELOPE>\n")[1].split("\n</CONTEXT_ENVELOPE>")[0].includes("\n"), false);
});

test("route budget profiles affect output budgets without changing frozen thinking", () => {
  for (const [profile, expected] of [[{ maxOutputTokens: 1200 }, 1500], ["validator", 2500], ["executor", 10000]]) {
    const router = createRouterService();
    router.gate("start_task", { taskId: "budget", objective: "test", complexity: "high" });
    const { request } = router.prepareWorkerRequest({ role: "luna", instruction: "work", routing: { provider: "test", model: "model", budgetProfile: profile } });
    assert.equal(request.budget.maxOutputTokens, expected);
    assert.equal(request.budget.thinking, "medium");
  }
});

test("invalid route budget profiles fail explicitly instead of silently doing nothing", () => {
  for (const profile of ["typo", {}, { outputTokens: 0 }, { outputTokens: 100, unknown: true }, { outputTokens: 100, maxTokens: 200 }]) {
    assert.throws(() => normalizeModelRoutes({ ...DEFAULT_RUNTIME_MODEL_ROUTES, luna: { ...DEFAULT_RUNTIME_MODEL_ROUTES.luna, budgetProfile: profile } }), /budget|profile/i);
  }
  const router = createRouterService();
  router.gate("start_task", { taskId: "invalid", objective: "test" });
  const before = router.snapshot();
  assert.throws(() => router.prepareWorkerRequest({ role: "luna", instruction: "test", routing: { budgetProfile: "typo" } }), /budget|profile/i);
  assert.deepEqual(router.snapshot(), before);
});

test("input compaction measures the actual prompt with a non-additive estimator", () => {
  const estimator = (text) => text.length + (text.includes("<ROLE>") ? 700 : 0);
  const router = createRouterService({ budgetPolicy: { estimator } });
  router.gate("start_task", { taskId: "input", objective: "retain objective", acceptance: ["retain acceptance"] });
  router.gate("luna_failed", { reason: "retry", errorLog: "x".repeat(8000) });
  const { request } = router.prepareWorkerRequest({ role: "luna", instruction: "retry", maxInputTokens: 5000 });
  assert.ok(estimator(request.renderedPrompt) <= 5000);
  assert.equal(request.budget.inputTokenEstimate, estimator(request.renderedPrompt));
  assert.deepEqual(request.contextEnvelope.goal.acceptance, ["retain acceptance"]);
  assert.equal(request.contextEnvelope.goal.objective, "retain objective");
  assert.ok(router.getMemory().runtime.events.some((event) => event.type === "context_compressed"));
});

test("configured model routes and feedback both participate in profile allocation", () => {
  const modelRoutes = { ...DEFAULT_RUNTIME_MODEL_ROUTES, luna: { ...DEFAULT_RUNTIME_MODEL_ROUTES.luna, budgetProfile: { outputTokens: 1000 } } };
  const router = createRouterService({ modelRoutes, isModelAvailable: () => true });
  router.gate("start_task", { taskId: "routes", objective: "test", taskType: "unit" });
  router.recordUsageFeedback({ requestId: "previous", role: "luna", taskType: "unit", success: true });
  const { request } = router.prepareWorkerRequest({ role: "luna", instruction: "test" });
  assert.equal(request.budget.outputTokens, 900);
  assert.equal(request.budget.maxOutputTokens, 900);
  assert.deepEqual(request.routing.budgetProfile, { outputTokens: 1000 });
  assert.equal(resolveTokenBudget({ role: "luna", budgetProfile: "validator", policy: { roles: { validator: { outputTokens: 777 } } } }).outputTokens, 777);
});

test("compaction caches identical candidate measurements and validates measurements", () => {
  const envelope = buildContextEnvelope(startTaskMemory({ taskId: "measure", objective: "test" }), { role: "luna" });
  const seen = new Set();
  assert.throws(() => compactEnvelopeToBudget(envelope, {
    inputTokens: 1,
    measureTokens(candidate) {
      const serialized = canonicalStringify(candidate);
      assert.equal(seen.has(serialized), false);
      seen.add(serialized);
      return serialized.length;
    },
  }), /Unable to compact/);
  assert.equal(seen.size, 1);
  assert.throws(() => compactEnvelopeToBudget(envelope, { inputTokens: 100, measureTokens: () => NaN }), /finite non-negative/);
});
