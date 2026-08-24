import test from "node:test";
import assert from "node:assert/strict";
import {
  formatProjectTokenShares,
  initialProjectTokenState,
  normalizeProjectTokenState,
  projectTokenPercentages,
  recordProjectTokenUsage,
  resetProjectTokenTotals,
  setProjectTokenVisibility,
  tokenTotalFromUsage,
  tokenTotalFromWorkerEvent,
} from "../src/token-share.js";

test("project token state defaults to hidden zero totals", () => {
  assert.deepEqual(initialProjectTokenState(), {
    version: 1,
    visible: false,
    tokens: { planner: 0, luna: 0, validator: 0, sol: 0 },
    seen: { plannerMessages: [], workerRuns: [] },
  });
  assert.equal(formatProjectTokenShares(initialProjectTokenState()), "P(0%),L(0%),V(0%),S(0%)");
});

test("project token state normalization is strict", () => {
  assert.throws(() => normalizeProjectTokenState({ version: 2 }), /version must be 1/);
  assert.throws(() => normalizeProjectTokenState({
    ...initialProjectTokenState(),
    extra: true,
  }), /unknown field/);
  assert.throws(() => normalizeProjectTokenState({
    ...initialProjectTokenState(),
    tokens: { planner: -1, luna: 0, validator: 0, sol: 0 },
  }), /non-negative safe integer/);
});

test("token totals include input output and cacheWrite but exclude cacheRead", () => {
  assert.equal(tokenTotalFromUsage({ input: 100, output: 20, cacheWrite: 5, cacheRead: 99_999 }), 125);
  assert.equal(tokenTotalFromWorkerEvent({
    usage: { input: 10, output: 5, cacheWrite: 2, cacheRead: 500 },
    tokens: { total: 999 },
  }), 17);
  assert.equal(tokenTotalFromWorkerEvent({ tokens: { total: 42 } }), 42);
  assert.equal(tokenTotalFromWorkerEvent({}), null);
});

test("recording usage deduplicates planner messages and worker runs", () => {
  let state = initialProjectTokenState();
  let update = recordProjectTokenUsage(state, {
    role: "planner", tokens: 10, kind: "plannerMessages", key: "p-1",
  });
  assert.equal(update.changed, true);
  state = update.state;
  update = recordProjectTokenUsage(state, {
    role: "planner", tokens: 10, kind: "plannerMessages", key: "p-1",
  });
  assert.equal(update.duplicate, true);
  assert.equal(update.state.tokens.planner, 10);

  state = recordProjectTokenUsage(update.state, {
    role: "luna", tokens: 30, kind: "workerRuns", key: "worker-1",
  }).state;
  assert.deepEqual(state.tokens, { planner: 10, luna: 30, validator: 0, sol: 0 });
});

test("largest-remainder percentages are stable and sum to 100", () => {
  const cases = [
    [{ planner: 1, luna: 1, validator: 1, sol: 1 }, { planner: 25, luna: 25, validator: 25, sol: 25 }],
    [{ planner: 1, luna: 1, validator: 1, sol: 0 }, { planner: 34, luna: 33, validator: 33, sol: 0 }],
    [{ planner: 1000, luna: 1, validator: 0, sol: 0 }, { planner: 100, luna: 0, validator: 0, sol: 0 }],
  ];
  for (const [tokens, expected] of cases) {
    const state = { ...initialProjectTokenState(), tokens };
    const percentages = projectTokenPercentages(state);
    assert.deepEqual(percentages, expected);
    assert.equal(Object.values(percentages).reduce((sum, value) => sum + value, 0), 100);
  }
});

test("reset preserves visibility and deduplication history", () => {
  let state = setProjectTokenVisibility(initialProjectTokenState(), true).state;
  state = recordProjectTokenUsage(state, {
    role: "sol", tokens: 55, kind: "workerRuns", key: "sol-1",
  }).state;
  const reset = resetProjectTokenTotals(state).state;
  assert.equal(reset.visible, true);
  assert.deepEqual(reset.tokens, { planner: 0, luna: 0, validator: 0, sol: 0 });
  assert.deepEqual(reset.seen.workerRuns, ["sol-1"]);
});
