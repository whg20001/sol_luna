export const TASK_MEMORY_VERSION = "2.0";

const DEFAULT_LIMITS = Object.freeze({
  runtimeEvents: 100,
  requestIds: 200,
  modifiedFiles: 100,
  tests: 50,
  workerReports: 30,
  validationReports: 30,
  usageFeedback: 50,
  semanticEntries: 100,
  attemptHistory: 50,
  snapshots: 10,
  logCharacters: 12_000,
  summaryCharacters: 8_000,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function optionalText(value) {
  const result = text(value).trim();
  return result || null;
}

function integer(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function array(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function bounded(values, limit) {
  return values.slice(Math.max(0, values.length - Math.max(0, limit)));
}

function uniqueBounded(values, limit) {
  const seen = new Set();
  const result = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    const key = typeof value === "string" ? value : JSON.stringify(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result.reverse().slice(-limit);
}

function truncate(value, limit) {
  const source = text(value);
  if (source.length <= limit) return source;
  return `${source.slice(0, Math.max(0, limit - 14))}\n…[truncated]`;
}

function normalizeLimits(options = {}) {
  const source = isObject(options.limits) ? options.limits : isObject(options) ? options : {};
  return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => [
    key,
    Number.isInteger(source[key]) && source[key] >= 0 ? source[key] : fallback,
  ]));
}

function normalizeError(value, logLimit) {
  if (!value) return null;
  if (typeof value === "string") return { type: "error", message: value, log: "" };
  if (!isObject(value)) return { type: "error", message: String(value), log: "" };
  const result = {
    type: optionalText(value.type) ?? "error",
    message: text(value.message ?? value.reason),
    log: truncate(value.log ?? value.errorLog ?? value.output, logLimit),
  };
  for (const key of Object.keys(value).sort()) {
    if (!(key in result) && value[key] !== undefined) result[key] = clone(value[key]);
  }
  return result;
}

function normalizeReport(value, logLimit) {
  const source = isObject(value) ? value : {};
  const report = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) continue;
    report[key] = /(?:log|output|stderr|stdout)$/i.test(key) && typeof item === "string"
      ? truncate(item, logLimit)
      : clone(item);
  }
  return report;
}

function normalizeDecisionSummary(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    attemptGoal: truncate(source.attemptGoal ?? source.attempt_goal, limits.summaryCharacters),
    approach: truncate(source.approach, limits.summaryCharacters),
    reason: truncate(source.reason ?? source.rationale, limits.summaryCharacters),
    evidence: bounded(array(source.evidence).map((entry) => truncate(entry, limits.summaryCharacters)), limits.attemptHistory),
    notAttempted: bounded(strings(source.notAttempted ?? source.not_attempted), limits.attemptHistory),
    nextAction: truncate(source.nextAction ?? source.next_action, limits.summaryCharacters),
  };
}

function normalizeUsageFeedback(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    requestId: optionalText(source.requestId),
    role: optionalText(source.role),
    inputTokens: integer(source.inputTokens),
    outputTokens: integer(source.outputTokens),
    latencyMs: integer(source.latencyMs),
    success: source.success === true,
    truncated: source.truncated === true,
    validatorMode: optionalText(source.validatorMode),
    taskType: optionalText(source.taskType),
  };
}

function normalizeSnapshot(value, limits) {
  const source = isObject(value) ? value : {};
  return {
    snapshotId: optionalText(source.snapshotId),
    taskId: optionalText(source.taskId),
    contextId: optionalText(source.contextId),
    sourceRole: optionalText(source.sourceRole) ?? "luna",
    attempt: integer(source.attempt),
    currentProgress: bounded(strings(source.currentProgress), limits.attemptHistory),
    modifiedFiles: uniqueBounded(strings(source.modifiedFiles), limits.modifiedFiles),
    diffSummary: truncate(source.diffSummary, limits.summaryCharacters),
    attemptHistory: bounded(array(source.attemptHistory).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.attemptHistory),
    currentError: normalizeError(source.currentError, limits.logCharacters),
    validation: source.validation == null ? null : normalizeReport(source.validation, limits.logCharacters),
    decisionSummary: normalizeDecisionSummary(source.decisionSummary ?? source.decision_summary, limits),
    memoryRevision: integer(source.memoryRevision),
  };
}

export function initialTaskMemory(seed = {}) {
  return normalizeTaskMemory(seed);
}

export function normalizeTaskMemory(value, options = {}) {
  const limits = normalizeLimits(options);
  const source = isObject(value) ? value : {};
  const runtime = isObject(source.runtime) ? source.runtime : {};
  const task = isObject(source.task) ? source.task : {};
  const artifact = isObject(source.artifact) ? source.artifact : {};
  const failure = isObject(source.failure) ? source.failure : {};

  const snapshots = bounded(array(failure.snapshots).map((entry) => normalizeSnapshot(entry, limits)), limits.snapshots);
  const currentSnapshotId = optionalText(failure.currentSnapshotId)
    ?? snapshots.at(-1)?.snapshotId
    ?? null;

  return {
    version: TASK_MEMORY_VERSION,
    revision: integer(source.revision),
    runtime: {
      taskId: optionalText(runtime.taskId ?? source.taskId),
      contextId: optionalText(runtime.contextId ?? source.contextId),
      status: optionalText(runtime.status) ?? "idle",
      role: optionalText(runtime.role),
      attempt: integer(runtime.attempt),
      validatorMode: optionalText(runtime.validatorMode),
      reasoningProfile: runtime.reasoningProfile == null ? null : clone(runtime.reasoningProfile),
      events: bounded(array(runtime.events).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.runtimeEvents),
      requestIds: uniqueBounded(strings(runtime.requestIds), limits.requestIds),
      usageFeedback: bounded(array(runtime.usageFeedback).map((entry) => normalizeUsageFeedback(entry, limits)), limits.usageFeedback),
    },
    task: {
      objective: text(task.objective ?? source.objective),
      taskType: optionalText(task.taskType ?? task.task_type ?? source.taskType),
      acceptance: array(task.acceptance ?? source.acceptance),
      constraints: array(task.constraints),
      completed: array(task.completed),
      pending: array(task.pending),
      blocked: array(task.blocked),
      currentTask: text(task.currentTask),
    },
    artifact: {
      modifiedFiles: uniqueBounded(strings(artifact.modifiedFiles ?? artifact.changedFiles), limits.modifiedFiles),
      diffSummary: truncate(artifact.diffSummary, limits.summaryCharacters),
      tests: bounded(array(artifact.tests).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.tests),
      workerReports: bounded(array(artifact.workerReports).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.workerReports),
      validationReports: bounded(array(artifact.validationReports).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.validationReports),
    },
    failure: {
      attemptHistory: bounded(array(failure.attemptHistory).map((entry) => normalizeReport(entry, limits.logCharacters)), limits.attemptHistory),
      currentError: normalizeError(failure.currentError, limits.logCharacters),
      snapshots,
      currentSnapshotId,
    },
    semantic: {
      entries: bounded(array(source.semantic?.entries), limits.semanticEntries),
    },
  };
}

function next(memory, mutate, options = {}) {
  const draft = normalizeTaskMemory(memory, options);
  mutate(draft);
  draft.revision += 1;
  return normalizeTaskMemory(draft, options);
}

function requestIdFrom(value, options) {
  return optionalText(options?.requestId ?? value?.requestId);
}

function isDuplicate(memory, requestId) {
  return requestId !== null && memory.runtime.requestIds.includes(requestId);
}

function rememberRequest(memory, requestId) {
  if (requestId) memory.runtime.requestIds.push(requestId);
}

export function startTaskMemory(memoryOrInput = {}, inputOrOptions = {}, maybeOptions = {}) {
  const hasMemoryShape = isObject(memoryOrInput)
    && ("runtime" in memoryOrInput || "task" in memoryOrInput || "artifact" in memoryOrInput || "failure" in memoryOrInput || "version" in memoryOrInput);
  const memory = hasMemoryShape ? memoryOrInput : initialTaskMemory();
  const input = hasMemoryShape ? inputOrOptions : memoryOrInput;
  const options = hasMemoryShape ? maybeOptions : inputOrOptions;
  if (!isObject(input)) throw new TypeError("startTaskMemory requires a task description object.");
  const taskId = optionalText(input.taskId);
  if (!taskId) throw new Error("startTaskMemory requires a non-empty taskId.");
  const requestId = requestIdFrom(input, options);
  const normalized = normalizeTaskMemory(memory, options);

  return next(normalized, (draft) => {
    draft.runtime.taskId = taskId;
    draft.runtime.contextId = optionalText(input.contextId);
    draft.runtime.status = optionalText(input.status) ?? "active";
    draft.runtime.role = optionalText(input.role);
    draft.runtime.attempt = integer(input.attempt, 1);
    draft.runtime.validatorMode = optionalText(input.validatorMode);
    draft.runtime.reasoningProfile = input.reasoningProfile == null ? null : clone(input.reasoningProfile);
    draft.runtime.events = [];
    draft.runtime.requestIds = [];
    // Usage feedback is aggregate runtime telemetry and is intentionally retained across tasks.
    draft.task.objective = text(input.objective);
    draft.task.taskType = optionalText(input.taskType ?? input.task_type);
    draft.task.acceptance = array(input.acceptance);
    draft.task.constraints = array(input.constraints);
    draft.task.completed = [];
    draft.task.pending = array(input.pending);
    draft.task.blocked = [];
    draft.task.currentTask = text(input.currentTask);
    draft.artifact = initialTaskMemory().artifact;
    draft.failure = initialTaskMemory().failure;
    rememberRequest(draft, requestId);
  }, options);
}

export function appendRuntimeEvent(memory, event, options = {}) {
  if (!isObject(event)) throw new TypeError("appendRuntimeEvent requires an event object.");
  const normalized = normalizeTaskMemory(memory, options);
  const requestId = requestIdFrom(event, options);
  if (isDuplicate(normalized, requestId)) return normalized;
  return next(normalized, (draft) => {
    const clean = normalizeReport(event, normalizeLimits(options).logCharacters);
    delete clean.requestId;
    draft.runtime.events.push(clean);
    rememberRequest(draft, requestId);
  }, options);
}

export function recordWorkerReport(memory, report, options = {}) {
  if (!isObject(report)) throw new TypeError("recordWorkerReport requires a report object.");
  const normalized = normalizeTaskMemory(memory, options);
  const requestId = requestIdFrom(report, options);
  if (isDuplicate(normalized, requestId)) return normalized;
  const limits = normalizeLimits(options);
  return next(normalized, (draft) => {
    const clean = normalizeReport(report, limits.logCharacters);
    delete clean.requestId;
    draft.artifact.workerReports.push(clean);
    const changeEntries = Array.isArray(report.changes) ? report.changes : [];
    const changeFiles = changeEntries
      .map((entry) => isObject(entry) ? entry.file ?? entry.path : null)
      .filter((entry) => typeof entry === "string");
    draft.artifact.modifiedFiles.push(...strings(
      report.modifiedFiles ?? report.changedFiles ?? report.changed_files ?? changeFiles,
    ));
    if (typeof (report.diffSummary ?? report.diff_summary) === "string") {
      draft.artifact.diffSummary = report.diffSummary ?? report.diff_summary;
    }
    if (Array.isArray(report.tests)) draft.artifact.tests.push(...clone(report.tests));
    if (Array.isArray(report.completed)) draft.task.completed.push(...clone(report.completed));
    if (Array.isArray(report.pending)) draft.task.pending = clone(report.pending);
    if (report.error || report.currentError || report.current_error) {
      draft.failure.currentError = normalizeError(report.currentError ?? report.current_error ?? report.error, limits.logCharacters);
    }
    draft.failure.attemptHistory.push({
      sourceRole: optionalText(report.sourceRole ?? report.role) ?? "luna",
      attempt: integer(report.attempt, draft.runtime.attempt),
      status: optionalText(report.status) ?? "reported",
      summary: text(report.summary ?? report.diffSummary),
      error: normalizeError(report.currentError ?? report.current_error ?? report.error, limits.logCharacters),
    });
    rememberRequest(draft, requestId);
  }, options);
}

export function recordValidationReport(memory, report, options = {}) {
  if (!isObject(report)) throw new TypeError("recordValidationReport requires a report object.");
  const normalized = normalizeTaskMemory(memory, options);
  const requestId = requestIdFrom(report, options);
  if (isDuplicate(normalized, requestId)) return normalized;
  const limits = normalizeLimits(options);
  return next(normalized, (draft) => {
    const clean = normalizeReport(report, limits.logCharacters);
    delete clean.requestId;
    draft.artifact.validationReports.push(clean);
    if (Array.isArray(report.tests)) draft.artifact.tests.push(...clone(report.tests));
    const passed = report.passed === true || report.status === "passed" || report.status === "success";
    draft.runtime.status = passed ? "passed" : "failed";
    draft.failure.currentError = passed
      ? null
      : normalizeError(report.currentError ?? report.current_error ?? report.error ?? {
        type: "validation_failure",
        message: report.reason ?? "Validation failed.",
        log: report.log,
      }, limits.logCharacters);
    draft.failure.attemptHistory.push({
      sourceRole: optionalText(report.sourceRole ?? report.role) ?? "validator",
      attempt: integer(report.attempt, draft.runtime.attempt),
      status: passed ? "passed" : "failed",
      reason: text(report.reason),
      error: clone(draft.failure.currentError),
    });
    rememberRequest(draft, requestId);
  }, options);
}

function stableHash(value) {
  const input = JSON.stringify(value, Object.keys(value).sort());
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function recordUsageFeedback(memory, feedback, options = {}) {
  if (!isObject(feedback)) throw new TypeError("recordUsageFeedback requires a feedback object.");
  const normalized = normalizeTaskMemory(memory, options);
  const requestId = requestIdFrom(feedback, options);
  const duplicate = requestId && normalized.runtime.usageFeedback.some((entry) => entry.requestId === requestId);
  if (duplicate) return normalized;
  const limits = normalizeLimits(options);
  return next(normalized, (draft) => {
    draft.runtime.usageFeedback.push(normalizeUsageFeedback(feedback, limits));
  }, options);
}

export function createFailureSnapshot(memory, details = {}, options = {}) {
  if (!isObject(details)) throw new TypeError("createFailureSnapshot requires a details object.");
  const normalized = normalizeTaskMemory(memory, options);
  const requestId = requestIdFrom(details, options);
  if (isDuplicate(normalized, requestId)) return normalized;
  const limits = normalizeLimits(options);

  return next(normalized, (draft) => {
    const snapshotSeed = {
      taskId: optionalText(details.taskId) ?? draft.runtime.taskId,
      contextId: optionalText(details.contextId) ?? draft.runtime.contextId,
      sourceRole: optionalText(details.sourceRole ?? details.role) ?? draft.runtime.role ?? "luna",
      attempt: integer(details.attempt, draft.runtime.attempt),
      currentProgress: details.currentProgress ?? draft.task.completed,
      modifiedFiles: details.modifiedFiles ?? draft.artifact.modifiedFiles,
      diffSummary: details.diffSummary ?? draft.artifact.diffSummary,
      attemptHistory: details.attemptHistory ?? draft.failure.attemptHistory,
      currentError: details.currentError ?? draft.failure.currentError,
      validation: details.validation ?? draft.artifact.validationReports.at(-1) ?? null,
      decisionSummary: details.decisionSummary ?? details.decision_summary ?? draft.artifact.workerReports.at(-1)?.decision_summary ?? null,
      memoryRevision: draft.revision,
    };
    const snapshotId = optionalText(details.snapshotId)
      ?? `fs-${stableHash({ ...snapshotSeed, requestId })}`;
    const snapshot = normalizeSnapshot({ snapshotId, ...snapshotSeed }, limits);
    draft.failure.snapshots.push(snapshot);
    draft.failure.currentSnapshotId = snapshotId;
    rememberRequest(draft, requestId);
  }, options);
}

export function getFailureSnapshot(memory, snapshotId) {
  const normalized = normalizeTaskMemory(memory);
  const wanted = optionalText(snapshotId) ?? normalized.failure.currentSnapshotId;
  if (!wanted) return null;
  const found = normalized.failure.snapshots.findLast((snapshot) => snapshot.snapshotId === wanted);
  return found ? clone(found) : null;
}

export function compactTaskMemory(memory, options = {}) {
  return normalizeTaskMemory(memory, options);
}
