import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_EVENT_TYPES,
  appendRuntimeLifecycleEvent,
  createRuntimeEvent,
  emitRuntimeEvent,
} from "../src/runtime-events.js";

const NOW = "2026-01-02T03:04:05.000Z";

function event(type = "task_started", overrides = {}, options = {}) {
  return createRuntimeEvent(type, {
    taskId: "task-1",
    contextId: "context-1",
    role: "planner",
    message: "started",
    ...overrides,
  }, { now: NOW, ...options });
}

test("runtime event types and fixed event shape are deterministic", () => {
  assert.deepEqual(RUNTIME_EVENT_TYPES, [
    "task_started", "reasoning_profile_frozen", "agent_selected", "context_projected",
    "context_compressed", "worker_dispatched", "worker_failed", "validation_started",
    "validation_completed", "snapshot_created", "recovery_started", "usage_recorded",
    "task_completed", "task_escalated",
  ]);
  assert.throws(() => createRuntimeEvent("unknown"), /unknown runtime event type/i);

  const created = event("worker_dispatched", { attempt: 2, revision: 4, metadata: { model: "luna" } });
  assert.deepEqual(Object.keys(created), [
    "type", "taskId", "contextId", "role", "attempt", "revision", "timestamp", "message", "log", "metadata",
  ]);
  assert.equal(created.timestamp, NOW);
  assert.deepEqual(created.metadata, { model: "luna" });
});

test("logs and metadata are bounded without mutating input", () => {
  const input = {
    log: "abcdefghij",
    metadata: { z: "abcdefghij", a: { nested: "value" } },
  };
  const created = event("worker_failed", input, {
    maxLogCharacters: 5,
    maxMetadataCharacters: 12,
    maxMetadataEntries: 2,
  });
  assert.equal(created.log.length, 5);
  assert.ok(JSON.stringify(created.metadata).length < JSON.stringify(input.metadata).length);
  assert.equal(input.log, "abcdefghij");
  assert.equal(input.metadata.z, "abcdefghij");
});

test("lifecycle append is immutable, supports task memory, and keeps newest events", () => {
  const memory = { revision: 1, runtime: { events: [event("task_started")] } };
  const appended = appendRuntimeLifecycleEvent(memory, event("agent_selected"), { maxEvents: 1 });
  assert.equal(memory.runtime.events[0].type, "task_started");
  assert.deepEqual(appended.runtime.events.map(({ type }) => type), ["agent_selected"]);
  assert.equal(appended.revision, 1);

  const events = appendRuntimeLifecycleEvent([], event("task_completed"));
  assert.deepEqual(events.map(({ type }) => type), ["task_completed"]);
});

test("event sink failures are isolated and reported for sync and async sinks", async () => {
  const created = event("usage_recorded");
  const delivered = [];
  const success = emitRuntimeEvent(created, (value) => delivered.push(value));
  assert.equal(success.emitted, true);
  assert.equal(success.diagnostic, null);
  assert.equal(delivered[0].type, "usage_recorded");

  const failed = emitRuntimeEvent(created, () => { throw new Error("sink down"); });
  assert.equal(failed.emitted, false);
  assert.deepEqual(failed.diagnostic, { type: "event_sink_error", message: "sink down" });

  const asyncFailed = await emitRuntimeEvent(async () => { throw new Error("async down"); }, created);
  assert.equal(asyncFailed.emitted, false);
  assert.equal(asyncFailed.diagnostic.message, "async down");
});
