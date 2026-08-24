import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContextEnvelope,
  canonicalStringify,
  projectMemoryForRole,
  serializeContextEnvelope,
} from "../src/context-envelope.js";
import { startTaskMemory, recordWorkerReport, recordValidationReport, createFailureSnapshot } from "../src/task-memory.js";
import {
  CACHE_FRIENDLY_PROTOCOL_PREFIX,
  renderRuntimeSuffix,
  renderWorkerPrompt,
  validateWorkerOutput,
  workerOutputSchemaForRole,
} from "../src/prompt-protocol.js";

function fixtureMemory() {
  let memory = startTaskMemory({
    taskId: "task-1",
    contextId: "context-1",
    objective: "Build v2",
    acceptance: ["stable", "tested"],
    constraints: ["pure"],
    pending: ["implement"],
  });
  memory = recordWorkerReport(memory, {
    modifiedFiles: ["src/new.js"],
    diffSummary: "new module",
    tests: [{ name: "unit", passed: true }],
  });
  memory = recordValidationReport(memory, {
    passed: false,
    reason: "unit failed",
    currentError: { type: "test_failure", message: "assertion", log: "x" },
  });
  return createFailureSnapshot(memory, { snapshotId: "failure-1", sourceRole: "luna", attempt: 1 });
}

test("canonical serialization is stable and uses the v2 envelope field order", () => {
  assert.equal(canonicalStringify({ z: 1, a: { y: 2, x: 3 } }), canonicalStringify({ a: { x: 3, y: 2 }, z: 1 }));
  const serialized = serializeContextEnvelope(buildContextEnvelope(fixtureMemory(), { role: "planner" }));
  assert.match(serialized, /^\{"version":"2\.0","projection":"root-summary","runtime":/);
  assert.ok(serialized.indexOf('"goal"') < serialized.indexOf('"state"'));
  assert.ok(serialized.indexOf('"state"') < serialized.indexOf('"artifact"'));
});

test("memory projection follows role loading rules while retaining minimal runtime metadata", () => {
  const memory = fixtureMemory();
  assert.deepEqual(Object.keys(projectMemoryForRole(memory, "planner")), ["runtime", "goal", "state", "decision"]);
  assert.deepEqual(Object.keys(projectMemoryForRole(memory, "luna")), ["runtime", "goal", "state", "artifact"]);
  assert.deepEqual(Object.keys(projectMemoryForRole(memory, "validator")), ["runtime", "goal", "state", "artifact", "failure"]);
  assert.deepEqual(Object.keys(projectMemoryForRole(memory, "sol")), ["runtime", "goal", "state", "artifact", "failure", "decision"]);

  for (const role of ["planner", "luna", "validator", "sol"]) {
    const envelope = buildContextEnvelope(memory, { role });
    assert.equal(envelope.runtime.task_id, "task-1");
    assert.equal(envelope.runtime.context_id, "context-1");
    assert.equal(envelope.runtime.role, role);
  }
  assert.equal(buildContextEnvelope(memory, { role: "luna" }).failure, null);
  assert.equal(buildContextEnvelope(memory, { role: "validator" }).state, null);
  assert.equal(buildContextEnvelope(memory, { role: "sol" }).failure.snapshot.snapshot_id, "failure-1");

  const projected = projectMemoryForRole(memory, "luna");
  projected.artifact.changed_files.push("mutated.js");
  assert.deepEqual(memory.artifact.modifiedFiles, ["src/new.js"]);
});

test("context envelope arrays and logs are bounded with deep copies", () => {
  const memory = fixtureMemory();
  memory.runtime.events = Array.from({ length: 6 }, (_, index) => ({ index, log: "x".repeat(100) }));
  const envelope = buildContextEnvelope(memory, { role: "planner", limits: { events: 2, logCharacters: 30 } });
  assert.deepEqual(envelope.runtime.events.map(({ index }) => index), [4, 5]);
  assert.ok(envelope.runtime.events[0].log.length <= 30);
  envelope.runtime.events[0].index = 99;
  assert.equal(memory.runtime.events[4].index, 4);
});

test("all prompts share an identical static prefix and ordered dynamic suffix", () => {
  const memory = fixtureMemory();
  const prompts = ["planner", "luna", "validator", "sol"].map((role) => renderWorkerPrompt({
    role,
    contextEnvelope: buildContextEnvelope(memory, { role }),
    currentTask: `task for ${role}`,
  }));
  for (const prompt of prompts) assert.equal(prompt.split("\n\n", 1)[0], CACHE_FRIENDLY_PROTOCOL_PREFIX);
  assert.doesNotMatch(CACHE_FRIENDLY_PROTOCOL_PREFIX, /task-1|context-1|planner|luna|validator|sol|timestamp/i);

  const suffix = renderRuntimeSuffix({
    role: "luna",
    contextEnvelope: buildContextEnvelope(memory, { role: "luna" }),
    currentTask: "implement",
  });
  assert.ok(suffix.indexOf("<ROLE>") < suffix.indexOf("<RUNTIME_PROTOCOL>"));
  assert.ok(suffix.indexOf("<RUNTIME_PROTOCOL>") < suffix.indexOf("<CONTEXT_ENVELOPE>"));
  assert.ok(suffix.indexOf("<CONTEXT_ENVELOPE>") < suffix.indexOf("<CURRENT_TASK>"));
  assert.match(suffix, /output=strict-json/);
  assert.match(suffix, /"goal"/);

  const lunaSchema = workerOutputSchemaForRole("luna");
  assert.ok(lunaSchema.required.includes("completed"));
  assert.ok(lunaSchema.required.includes("diff_summary"));
  assert.ok(lunaSchema.required.includes("current_error"));
  assert.ok(lunaSchema.required.includes("decision_summary"));
  const validatorSchema = workerOutputSchemaForRole("validator");
  assert.ok(validatorSchema.required.includes("reason"));
  assert.ok(validatorSchema.required.includes("current_error"));
  assert.throws(() => validateWorkerOutput("validator", { passed: true }), /strict JSON schema/i);
  assert.deepEqual(validateWorkerOutput("validator", {
    passed: true,
    reason: "all checks passed",
    issues: [],
    tests: [],
    current_error: null,
  }).issues, []);
  assert.throws(() => validateWorkerOutput("validator", {
    passed: true,
    reason: "all checks passed",
    issues: [],
    tests: [{ command: "npm test", passed: true, evidence: "ok", extra: "not allowed" }],
    current_error: null,
  }), /strict JSON schema/i);
});
