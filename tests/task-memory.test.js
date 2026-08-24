import test from "node:test";
import assert from "node:assert/strict";
import {
  appendRuntimeEvent,
  createFailureSnapshot,
  getFailureSnapshot,
  initialTaskMemory,
  recordUsageFeedback,
  recordValidationReport,
  recordWorkerReport,
  startTaskMemory,
} from "../src/task-memory.js";

test("task memory updates are immutable and requestId operations are idempotent", () => {
  const empty = initialTaskMemory();
  const started = startTaskMemory(empty, {
    taskId: "task-1",
    contextId: "ctx-1",
    objective: "Implement the module",
    acceptance: ["tests pass"],
    requestId: "start-1",
  });
  assert.equal(empty.runtime.taskId, null);
  assert.equal(started.runtime.taskId, "task-1");

  const event = { type: "worker-started", detail: { nested: true }, requestId: "event-1" };
  const once = appendRuntimeEvent(started, event);
  event.detail.nested = false;
  const twice = appendRuntimeEvent(once, { type: "duplicate", requestId: "event-1" });
  assert.equal(once.runtime.events[0].detail.nested, true);
  assert.deepEqual(twice, once);
});

test("worker and validation reports update artifact and failure layers without mutation", () => {
  const started = startTaskMemory({
    taskId: "task-2",
    objective: "Fix tests",
    acceptance: ["suite passes"],
  });
  const worked = recordWorkerReport(started, {
    requestId: "worker-1",
    status: "failed",
    modifiedFiles: ["src/a.js"],
    diffSummary: "updated a",
    tests: [{ name: "unit", passed: false }],
    currentError: { type: "test_failure", log: "boom" },
  });
  const validated = recordValidationReport(worked, {
    requestId: "validation-1",
    passed: false,
    reason: "unit failed",
    log: "assertion",
  });
  assert.deepEqual(started.artifact.modifiedFiles, []);
  assert.deepEqual(worked.artifact.modifiedFiles, ["src/a.js"]);
  assert.equal(validated.failure.currentError.type, "validation_failure");
  assert.equal(validated.runtime.status, "failed");
});

test("failure snapshots contain the complete recovery handoff and are independently cloned", () => {
  let memory = startTaskMemory({
    taskId: "task-3",
    contextId: "ctx-3",
    role: "luna",
    objective: "Recover",
  });
  memory = recordWorkerReport(memory, {
    modifiedFiles: ["src/recover.js"],
    diffSummary: "partial repair",
    completed: ["inspected failure"],
    currentError: { type: "test_failure", message: "still red", log: "stack" },
    decision_summary: {
      attempt_goal: "repair recovery",
      approach: "change recover.js",
      reason: "focused failing path",
      evidence: ["test failure"],
      not_attempted: ["unrelated migration"],
      next_action: "run focused validation",
    },
  });
  memory = createFailureSnapshot(memory, { snapshotId: "snapshot-3", validation: { passed: false } });
  const snapshot = getFailureSnapshot(memory, "snapshot-3");
  assert.deepEqual(Object.keys(snapshot), [
    "snapshotId", "taskId", "contextId", "sourceRole", "attempt", "currentProgress",
    "modifiedFiles", "diffSummary", "attemptHistory", "currentError", "validation", "decisionSummary", "memoryRevision",
  ]);
  assert.equal(snapshot.taskId, "task-3");
  assert.deepEqual(snapshot.modifiedFiles, ["src/recover.js"]);
  assert.equal(snapshot.decisionSummary.approach, "change recover.js");
  snapshot.modifiedFiles.push("mutated.js");
  assert.deepEqual(getFailureSnapshot(memory).modifiedFiles, ["src/recover.js"]);
});

test("starting a new task clears task-local runtime/artifact data while retaining aggregate usage feedback", () => {
  let memory = startTaskMemory({ taskId: "old", objective: "old", acceptance: ["old acceptance"] });
  memory = appendRuntimeEvent(memory, { type: "old-event", requestId: "reused-id" });
  memory = recordWorkerReport(memory, { changed_files: ["old.js"], requestId: "old-worker" });
  memory = recordUsageFeedback(memory, { requestId: "usage-old", role: "luna", success: true });
  const next = startTaskMemory(memory, {
    taskId: "new",
    contextId: "new-context",
    objective: "new objective",
    requestId: "reused-id",
  });
  assert.equal(next.runtime.taskId, "new");
  assert.deepEqual(next.runtime.events, []);
  assert.deepEqual(next.runtime.requestIds, ["reused-id"]);
  assert.deepEqual(next.task.acceptance, []);
  assert.deepEqual(next.artifact.modifiedFiles, []);
  assert.equal(next.runtime.usageFeedback.length, 1);
});

test("runtime events are bounded and retain the newest entries", () => {
  let memory = startTaskMemory({ taskId: "bounded" });
  for (let index = 0; index < 8; index += 1) {
    memory = appendRuntimeEvent(memory, { index }, { limits: { runtimeEvents: 3 } });
  }
  assert.deepEqual(memory.runtime.events.map(({ index }) => index), [5, 6, 7]);
});
