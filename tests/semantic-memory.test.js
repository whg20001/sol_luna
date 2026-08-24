import test from "node:test";
import assert from "node:assert/strict";
import {
  addSemanticEntry,
  normalizeSemanticMemory,
  retrieveSemanticMemory,
} from "../src/semantic-memory.js";

const entry = (id, summary, overrides = {}) => ({
  id,
  taskType: "coding",
  summary,
  problem: "",
  resolution: "",
  tags: [],
  success: true,
  createdAtRevision: 1,
  ...overrides,
});

test("semantic memory retrieval is deterministic, lexical, thresholded, and stably sorted", () => {
  const memory = normalizeSemanticMemory({ entries: [
    entry("first", "cache repair", { tags: ["node"] }),
    entry("second", "repair cache", { tags: ["node"] }),
    entry("third", "database migration"),
  ] });

  const first = retrieveSemanticMemory(memory, "node cache", { topK: 2, minScore: 0.5 });
  const second = retrieveSemanticMemory(memory, "node cache", { topK: 2, minScore: 0.5 });
  assert.deepEqual(first.map(({ id }) => id), ["first", "second"]);
  assert.deepEqual(second, first);
  assert.deepEqual(retrieveSemanticMemory(memory, "unrelated", { minScore: 0.1 }), []);
});

test("semantic memory is immutable and bounded to newest unique entries", () => {
  const original = { entries: [entry("one", "one"), entry("two", "two")] };
  const added = addSemanticEntry(original, entry("three", "three", { tags: ["A", "a", "B"] }), { maxEntries: 2 });
  assert.deepEqual(original.entries.map(({ id }) => id), ["one", "two"]);
  assert.deepEqual(added.entries.map(({ id }) => id), ["two", "three"]);
  assert.deepEqual(added.entries[1].tags, ["A", "B"]);

  const replaced = addSemanticEntry(added, entry("two", "new two"), { maxEntries: 2 });
  assert.deepEqual(replaced.entries.map(({ id }) => id), ["three", "two"]);
  assert.equal(added.entries[0].summary, "two");
});

test("semantic scorer plugins can rank entries and failures fall back per entry", () => {
  const memory = { entries: [entry("a", "alpha"), entry("b", "beta")] };
  const custom = retrieveSemanticMemory(memory, "alpha", {
    minScore: -1,
    scorer: ({ entry: item }) => item.id === "b" ? 10 : 0,
  });
  assert.deepEqual(custom.map(({ id }) => id), ["b", "a"]);

  const fallback = retrieveSemanticMemory(memory, "alpha", {
    minScore: 0.1,
    scorer: (query, item) => {
      if (item.id === "a") throw new Error("plugin failed");
      return Number.NaN;
    },
  });
  assert.deepEqual(fallback.map(({ id }) => id), ["a"]);
});
