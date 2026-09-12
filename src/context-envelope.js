import { getFailureSnapshot, normalizeTaskMemory } from "./task-memory.js";
import { canonicalStringify } from "./canonical-json.js";

export const CONTEXT_ENVELOPE_VERSION = "2.0";

const DEFAULT_LIMITS = Object.freeze({
  events: 40,
  completed: 50,
  pending: 50,
  blocked: 30,
  constraints: 30,
  acceptance: 30,
  changedFiles: 100,
  tests: 30,
  reports: 20,
  attempts: 30,
  snapshots: 3,
  logCharacters: 8_000,
  summaryCharacters: 6_000,
});


function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function limitsFrom(options = {}) {
  const source = isObject(options.limits) ? options.limits : isObject(options) ? options : {};
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
    key,
    Number.isInteger(source[key]) && source[key] >= 0 ? source[key] : fallback,
  ]));
}

function bounded(value, limit) {
  const source = Array.isArray(value) ? clone(value) : [];
  return source.slice(Math.max(0, source.length - limit));
}

function truncate(value, limit) {
  if (typeof value !== "string") return value == null ? "" : String(value);
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 14))}\n…[truncated]`;
}

function limitLogs(value, limits, key = "") {
  if (Array.isArray(value)) return value.map((entry) => limitLogs(entry, limits));
  if (!isObject(value)) {
    return typeof value === "string" && /(?:log|output|stderr|stdout|summary)$/i.test(key)
      ? truncate(value, /summary/i.test(key) ? limits.summaryCharacters : limits.logCharacters)
      : clone(value);
  }
  const result = {};
  for (const childKey of Object.keys(value)) {
    if (value[childKey] !== undefined) result[childKey] = limitLogs(value[childKey], limits, childKey);
  }
  return result;
}

function normalizeRuntime(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    task_id: typeof (source.task_id ?? source.taskId) === "string" ? (source.task_id ?? source.taskId) : null,
    context_id: typeof (source.context_id ?? source.contextId) === "string" ? (source.context_id ?? source.contextId) : null,
    snapshot_id: typeof (source.snapshot_id ?? source.snapshotId) === "string" ? (source.snapshot_id ?? source.snapshotId) : null,
    request_id: typeof (source.request_id ?? source.requestId) === "string" ? (source.request_id ?? source.requestId) : null,
    role: typeof source.role === "string" ? source.role : null,
    version: CONTEXT_ENVELOPE_VERSION,
    stage: typeof source.stage === "string" ? source.stage : null,
    validator_mode: typeof (source.validator_mode ?? source.validatorMode) === "string" ? (source.validator_mode ?? source.validatorMode) : null,
    reasoning_profile: source.reasoning_profile ?? source.reasoningProfile ? clone(source.reasoning_profile ?? source.reasoningProfile) : null,
    status: typeof source.status === "string" ? source.status : "idle",
    attempt: Number.isInteger(source.attempt) && source.attempt >= 0 ? source.attempt : 0,
    events: bounded(source.events, limits.events).map((entry) => limitLogs(entry, limits)),
  };
}

function normalizeGoal(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    objective: typeof source.objective === "string" ? source.objective : "",
    acceptance: bounded(source.acceptance, limits.acceptance),
    constraints: bounded(source.constraints, limits.constraints),
  };
}

function normalizeTaskState(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    completed: bounded(source.completed, limits.completed),
    pending: bounded(source.pending, limits.pending),
    blocked: bounded(source.blocked, limits.blocked),
  };
}

function normalizeArtifact(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    changed_files: bounded(source.changed_files ?? source.changedFiles ?? source.modifiedFiles, limits.changedFiles),
    diff_summary: truncate(source.diff_summary ?? source.diffSummary, limits.summaryCharacters),
    tests: bounded(source.tests, limits.tests).map((entry) => limitLogs(entry, limits)),
    worker_reports: bounded(source.worker_reports ?? source.workerReports, limits.reports).map((entry) => limitLogs(entry, limits)),
    validation_reports: bounded(source.validation_reports ?? source.validationReports, limits.reports).map((entry) => limitLogs(entry, limits)),
  };
}

function normalizeSnapshot(value, limits) {
  if (!isObject(value)) return null;
  return {
    snapshot_id: typeof (value.snapshot_id ?? value.snapshotId) === "string" ? (value.snapshot_id ?? value.snapshotId) : null,
    task_id: typeof (value.task_id ?? value.taskId) === "string" ? (value.task_id ?? value.taskId) : null,
    context_id: typeof (value.context_id ?? value.contextId) === "string" ? (value.context_id ?? value.contextId) : null,
    source_role: typeof (value.source_role ?? value.sourceRole) === "string" ? (value.source_role ?? value.sourceRole) : null,
    attempt: Number.isInteger(value.attempt) ? value.attempt : 0,
    current_progress: bounded(value.current_progress ?? value.currentProgress, limits.attempts),
    modified_files: bounded(value.modified_files ?? value.modifiedFiles, limits.changedFiles),
    diff_summary: truncate(value.diff_summary ?? value.diffSummary, limits.summaryCharacters),
    attempt_history: bounded(value.attempt_history ?? value.attemptHistory, limits.attempts).map((entry) => limitLogs(entry, limits)),
    current_error: value.current_error ?? value.currentError ? limitLogs(value.current_error ?? value.currentError, limits) : null,
    validation: value.validation == null ? null : limitLogs(value.validation, limits),
    decision_summary: value.decision_summary ?? value.decisionSummary ? limitLogs(value.decision_summary ?? value.decisionSummary, limits) : null,
    memory_revision: Number.isInteger(value.memory_revision ?? value.memoryRevision)
      ? (value.memory_revision ?? value.memoryRevision)
      : 0,
  };
}

function normalizeFailure(value, limits) {
  const source = isObject(value) ? value : {};
  const snapshots = bounded(source.snapshots, limits.snapshots)
    .map((entry) => normalizeSnapshot(entry, limits))
    .filter(Boolean);
  const snapshot = normalizeSnapshot(source.snapshot, limits)
    ?? snapshots.findLast((entry) => entry.snapshot_id === (source.current_snapshot_id ?? source.currentSnapshotId))
    ?? snapshots.at(-1)
    ?? null;
  return {
    current_snapshot_id: typeof (source.current_snapshot_id ?? source.currentSnapshotId) === "string"
      ? (source.current_snapshot_id ?? source.currentSnapshotId)
      : snapshot?.snapshot_id ?? null,
    snapshot,
    snapshots,
    attempt_history: bounded(source.attempt_history ?? source.attemptHistory, limits.attempts).map((entry) => limitLogs(entry, limits)),
    current_error: source.current_error ?? source.currentError ? limitLogs(source.current_error ?? source.currentError, limits) : null,
  };
}

export function normalizeContextEnvelope(value, options = {}) {
  const limits = limitsFrom(options);
  const source = isObject(value) ? value : {};
  const legacyTask = isObject(source.task) ? source.task : {};
  return {
    version: CONTEXT_ENVELOPE_VERSION,
    projection: typeof source.projection === "string" ? source.projection : null,
    runtime: source.runtime == null ? null : normalizeRuntime(source.runtime, limits),
    goal: source.goal == null && source.task == null && source.acceptance == null
      ? null
      : normalizeGoal(source.goal ?? {
        objective: legacyTask.objective,
        acceptance: source.acceptance ?? legacyTask.acceptance,
        constraints: legacyTask.constraints,
      }, limits),
    state: source.state == null && source.task == null
      ? null
      : normalizeTaskState(source.state ?? legacyTask, limits),
    artifact: source.artifact == null ? null : normalizeArtifact(source.artifact, limits),
    failure: source.failure == null ? null : normalizeFailure(source.failure, limits),
    semantic: source.semantic == null ? null : limitLogs(source.semantic, limits),
    decision: source.decision == null ? null : limitLogs(source.decision, limits),
  };
}

export function resolveContextProjection(role, options = {}) {
  const name = typeof role === "string" ? role.trim().toLowerCase() : "";
  const validatorMode = typeof options.validatorMode === "string" ? options.validatorMode.trim().toLowerCase() : "fast";
  if (["planner", "root"].includes(name)) return "root-summary";
  if (["luna", "executor"].includes(name)) return "worker-artifact";
  if (name === "validator") return validatorMode === "deep" ? "validator-deep" : "validator-fast";
  if (["sol", "recovery"].includes(name)) return "recovery-decision";
  throw new Error(`Unsupported context projection role: ${String(role)}.`);
}

export function projectMemoryForRole(memory, role, options = {}) {
  const normalized = normalizeTaskMemory(memory, options);
  const name = typeof role === "string" ? role.trim().toLowerCase() : "";
  const runtime = {
    task_id: normalized.runtime.taskId,
    context_id: normalized.runtime.contextId,
    role: name === "root" ? "planner" : name === "executor" ? "luna" : name === "recovery" ? "sol" : name,
    status: normalized.runtime.status,
    attempt: normalized.runtime.attempt,
    validator_mode: normalized.runtime.validatorMode,
    reasoning_profile: clone(normalized.runtime.reasoningProfile),
    events: [],
  };
  const goal = {
    objective: normalized.task.objective,
    acceptance: clone(normalized.task.acceptance),
    constraints: clone(normalized.task.constraints),
  };
  const state = {
    completed: clone(normalized.task.completed),
    pending: clone(normalized.task.pending),
    blocked: clone(normalized.task.blocked),
  };
  const artifact = {
    changed_files: clone(normalized.artifact.modifiedFiles),
    diff_summary: normalized.artifact.diffSummary,
    tests: clone(normalized.artifact.tests),
    worker_reports: clone(normalized.artifact.workerReports),
    validation_reports: clone(normalized.artifact.validationReports),
  };
  const latestSnapshot = getFailureSnapshot(normalized);
  const failure = {
    current_snapshot_id: normalized.failure.currentSnapshotId,
    snapshot: latestSnapshot,
    snapshots: clone(normalized.failure.snapshots),
    attempt_history: clone(normalized.failure.attemptHistory),
    current_error: clone(normalized.failure.currentError),
  };

  switch (name) {
    case "planner":
    case "root":
      return {
        runtime: { ...runtime, events: clone(normalized.runtime.events) },
        goal,
        state,
        decision: {
          status: normalized.runtime.status,
          blockers: clone(normalized.task.blocked),
          decision_needed: normalized.failure.currentError?.message ?? "",
        },
      };
    case "luna":
    case "executor":
      return { runtime, goal, state, artifact };
    case "validator":
      return {
        runtime,
        goal: { objective: "", acceptance: goal.acceptance, constraints: goal.constraints },
        state: options.validatorMode === "deep" ? state : null,
        artifact,
        failure: options.validatorMode === "deep" ? failure : null,
      };
    case "sol":
    case "recovery":
      return {
        runtime,
        goal,
        state,
        artifact,
        failure,
        decision: { summary: clone(latestSnapshot?.decisionSummary ?? null) },
      };
    default:
      throw new Error(`Unsupported memory projection role: ${String(role)}.`);
  }
}

export function buildContextEnvelope(memory, options = {}) {
  if (!isObject(options)) throw new TypeError("buildContextEnvelope options must be an object.");
  const role = options.role;
  if (typeof role !== "string" || !role.trim()) throw new Error("buildContextEnvelope requires a non-empty role option.");
  const projectionName = resolveContextProjection(role, options);
  const projection = projectMemoryForRole(memory, role, options);
  return normalizeContextEnvelope({
    version: CONTEXT_ENVELOPE_VERSION,
    projection: projectionName,
    runtime: projection.runtime ?? null,
    goal: projection.goal ?? null,
    state: projection.state ?? null,
    artifact: projection.artifact ?? null,
    failure: projection.failure ?? null,
    semantic: options.semanticMatches ?? null,
    decision: projection.decision ?? null,
  }, options);
}

// Preserve the public export while sharing serialization with task memory.
export { canonicalStringify };

export function serializeContextEnvelope(envelope, options = {}) {
  const normalized = normalizeContextEnvelope(envelope, options);
  const space = options.pretty === true ? 2 : Number.isInteger(options.space) ? options.space : 0;
  return canonicalStringify(normalized, space);
}
