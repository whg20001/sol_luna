import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeModelPerformanceStore,
  rankModelCandidates,
  recordModelPerformance,
} from "../src/model-ranking.js";

const candidate = (model, available = true) => ({ provider: "test", model, available });

function record(model, overrides = {}) {
  return {
    provider: "test",
    model,
    taskType: "coding",
    success: true,
    quality: 1,
    cost: 1,
    latencyMs: 100,
    samples: 1,
    ...overrides,
  };
}

test("model performance recording aggregates immutably and remains bounded", () => {
  const original = { records: [record("a", { success: 1, samples: 2, quality: 0.5 })] };
  const updated = recordModelPerformance(original, record("a", { success: true, quality: 1 }), { maxRecords: 2 });
  assert.equal(original.records[0].samples, 2);
  assert.deepEqual(updated.records[0], {
    provider: "test",
    model: "a",
    taskType: "coding",
    success: 2,
    quality: 2 / 3,
    cost: 1,
    latencyMs: 100,
    samples: 3,
  });

  const bounded = recordModelPerformance(updated, record("b"), { maxRecords: 1 });
  assert.deepEqual(bounded.records.map(({ model }) => model), ["b"]);
  assert.deepEqual(normalizeModelPerformanceStore(null), { records: [] });
});

test("default ranking follows weighted score and stable tie-breaks", () => {
  const store = { records: [
    record("slow", { success: true, quality: 1, cost: 10, latencyMs: 1000 }),
    record("fast", { success: true, quality: 1, cost: 1, latencyMs: 100 }),
    record("tie-a", { success: false, quality: 0 }),
    record("tie-b", { success: false, quality: 0 }),
  ] };
  const ranked = rankModelCandidates(store, [
    candidate("slow"), candidate("fast"), candidate("tie-a"), candidate("tie-b"),
  ], { taskType: "coding" });
  assert.deepEqual(ranked.map(({ model }) => model), ["fast", "slow", "tie-a", "tie-b"]);
});

test("only available candidates move and zero-history candidates retain relative order", () => {
  const candidates = [candidate("unknown-a"), candidate("unavailable", false), candidate("known"), candidate("unknown-b")];
  const store = { records: [record("known")] };
  const ranked = rankModelCandidates(store, candidates, { taskType: "coding" });
  assert.deepEqual(ranked.map(({ model }) => model), ["known", "unavailable", "unknown-a", "unknown-b"]);
  assert.deepEqual(candidates.map(({ model }) => model), ["unknown-a", "unavailable", "known", "unknown-b"]);

  const noHistory = rankModelCandidates({}, candidates, { taskType: "coding" });
  assert.deepEqual(noHistory, candidates);
  assert.notEqual(noHistory, candidates);
});

test("custom scorer exceptions and invalid results fall back to deterministic defaults", () => {
  const candidates = [candidate("bad-plugin"), candidate("good-default")];
  const store = { records: [
    record("bad-plugin", { success: false, quality: 0 }),
    record("good-default", { success: true, quality: 1 }),
  ] };
  const ranked = rankModelCandidates(store, candidates, {
    taskType: "coding",
    scorer: (item, performance) => {
      if (item.model === "bad-plugin") throw new Error("boom");
      return Number.NaN;
    },
  });
  assert.deepEqual(ranked.map(({ model }) => model), ["good-default", "bad-plugin"]);
});
