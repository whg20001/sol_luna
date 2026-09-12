import { randomUUID } from "node:crypto";
import {
  canInvokeAgent,
  initialState,
  normalizeState,
  transitionState,
} from "./core.js";
import {
  buildContextEnvelope,
} from "./context-envelope.js";
import {
  appendRuntimeEvent,
  createFailureSnapshot,
  getFailureSnapshot as selectFailureSnapshot,
  initialTaskMemory,
  normalizeTaskMemory,
  recordUsageFeedback as updateUsageMemory,
  recordValidationReport,
  recordWorkerReport as updateWorkerMemory,
  startTaskMemory,
} from "./task-memory.js";
import { renderWorkerPrompt } from "./prompt-protocol.js";
import { evaluateExecutionPolicy, freezeReasoningProfile } from "./execution-policy.js";
import { addSemanticEntry, retrieveSemanticMemory } from "./semantic-memory.js";
import { createRuntimeEvent, emitRuntimeEvent } from "./runtime-events.js";
import { normalizeModelPerformanceStore, recordModelPerformance } from "./model-ranking.js";
import { resolveRoleRoute } from "./model-routing.js";
import {
  compactEnvelopeToBudget,
  estimateTokens,
  normalizeBudgetPolicy,
  resolveTokenBudget,
} from "./token-budget.js";

export const ROUTER_STATE_VERSION = 1;
export const ROUTER_PROTOCOL_VERSION = "2.1";

export const ROUTER_ROLES = Object.freeze({
  LUNA: "luna",
  VALIDATOR: "validator",
  SOL: "sol",
});

const ROLE_TO_AGENT = Object.freeze({
  [ROUTER_ROLES.LUNA]: "luna-worker",
  [ROUTER_ROLES.VALIDATOR]: "validator-worker",
  [ROUTER_ROLES.SOL]: "sol-worker",
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function copyState(state) {
  return clone(normalizeState(state));
}

function statesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(ROLE_TO_AGENT, normalized)) {
    throw new Error(`Unknown router worker role: ${String(role)}`);
  }
  return normalized;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePendingRequest(value, state) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const role = nonEmptyString(value.role)?.toLowerCase();
  const requestId = nonEmptyString(value.requestId);
  if (!role || !requestId || !Object.hasOwn(ROLE_TO_AGENT, role)) return null;
  if (value.taskId && state.taskId && value.taskId !== state.taskId) return null;
  if (value.contextId && state.contextId && value.contextId !== state.contextId) return null;
  return clone(value);
}

function runtimeMemory(memory, state, role, status) {
  return normalizeTaskMemory({
    ...memory,
    revision: memory.revision + 1,
    runtime: {
      ...memory.runtime,
      taskId: state.taskId,
      contextId: state.contextId,
      role,
      status,
      attempt: state.attempts[role] ?? memory.runtime.attempt,
    },
  });
}

/**
 * Create the host-independent stateful facade around routing, memory, failure
 * snapshots, prompt rendering, and budget metadata. Persistence and worker
 * execution remain adapter responsibilities.
 */
export function createRouterService({
  snapshot,
  taskIdFactory = () => `task-${randomUUID()}`,
  contextIdFactory = ({ taskId } = {}) => (taskId ? `ctx-${taskId}` : `ctx-${randomUUID()}`),
  snapshotIdFactory = () => `failure-${randomUUID()}`,
  requestIdFactory = () => `request-${randomUUID()}`,
  budgetPolicy,
  modelRoutes,
  isModelAvailable = () => false,
  executionPolicy = evaluateExecutionPolicy,
  memoryRetriever = retrieveSemanticMemory,
  modelRanker,
  modelScorer,
  modelPerformanceStore,
  eventSink,
} = {}) {
  for (const [name, value] of Object.entries({
    taskIdFactory,
    contextIdFactory,
    snapshotIdFactory,
    requestIdFactory,
    isModelAvailable,
    executionPolicy,
    memoryRetriever,
  })) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  }

  const normalizedBudgetPolicy = normalizeBudgetPolicy(budgetPolicy);
  const tokenEstimator = normalizedBudgetPolicy.estimator;
  let state = initialState();
  let memory = initialTaskMemory();
  let pendingRequest = null;
  let revision = 0;
  let latestPolicyDecision = null;
  let performanceStore = normalizeModelPerformanceStore(modelPerformanceStore);

  function getState() {
    return copyState(state);
  }

  function getMemory() {
    return clone(memory);
  }

  function getPendingRequest() {
    return clone(pendingRequest);
  }

  function getReasoningProfile() {
    return clone(state.reasoningProfile ?? memory.runtime.reasoningProfile);
  }

  function getPolicyDecision() {
    return clone(latestPolicyDecision);
  }

  function getModelPerformanceStore() {
    return clone(performanceStore);
  }

  function safeEvaluatePolicy(input) {
    const safeInput = clone(input);
    try {
      return executionPolicy(safeInput);
    } catch {
      return evaluateExecutionPolicy(clone(input));
    }
  }

  function safeRetrieveSemantic(memoryValue, query, options) {
    try {
      const result = memoryRetriever(clone(memoryValue), clone(query), clone(options));
      return Array.isArray(result) ? result : [];
    } catch {
      return retrieveSemanticMemory(clone(memoryValue), clone(query), clone(options));
    }
  }

  function emitLifecycle(type, details = {}) {
    const lifecycleEvent = createRuntimeEvent({
      type,
      taskId: state.taskId,
      contextId: state.contextId,
      role: details.role ?? state.activeRole,
      attempt: details.attempt ?? (details.role ? state.attempts[details.role] : 0),
      revision,
      message: details.message,
      log: details.log,
      metadata: details.metadata,
    });
    memory = appendRuntimeEvent(memory, lifecycleEvent);
    const emitted = emitRuntimeEvent(lifecycleEvent, eventSink);
    if (emitted && typeof emitted.then === "function") emitted.catch(() => {});
    return emitted;
  }

  function currentSnapshot() {
    return {
      version: ROUTER_STATE_VERSION,
      state: {
        ...getState(),
        memory: getMemory(),
        pendingRequest: getPendingRequest(),
        policyDecision: getPolicyDecision(),
        modelPerformanceStore: clone(performanceStore),
        revision,
      },
    };
  }

  function restore(snapshotOrState) {
    const source = snapshotOrState && typeof snapshotOrState === "object"
      && Object.prototype.hasOwnProperty.call(snapshotOrState, "state")
      ? snapshotOrState.state
      : snapshotOrState;
    state = normalizeState(source);
    memory = normalizeTaskMemory(source?.memory ?? {
      runtime: {
        taskId: state.taskId,
        contextId: state.contextId,
        status: state.stage,
        role: state.activeRole,
      },
      task: {
        objective: state.taskLabel ?? "",
        currentTask: state.taskLabel ?? "",
      },
    });
    pendingRequest = normalizePendingRequest(source?.pendingRequest, state);
    latestPolicyDecision = source?.policyDecision && typeof source.policyDecision === "object" ? clone(source.policyDecision) : null;
    performanceStore = normalizeModelPerformanceStore(source?.modelPerformanceStore ?? performanceStore);
    revision = Number.isInteger(source?.revision) && source.revision >= 0 ? source.revision : 0;
    return getState();
  }

  if (snapshot !== undefined) restore(snapshot);

  function capturePrevious() {
    return {
      state: getState(),
      snapshot: currentSnapshot(),
    };
  }

  function atomically(operation) {
    const rollbackSnapshot = currentSnapshot();
    try {
      return operation();
    } catch (error) {
      restore(rollbackSnapshot);
      throw error;
    }
  }

  function updateResult(previous) {
    const nextSnapshot = currentSnapshot();
    return {
      changed: !statesEqual(previous.snapshot, nextSnapshot),
      previousState: previous.state,
      previousSnapshot: previous.snapshot,
      state: getState(),
      snapshot: nextSnapshot,
    };
  }

  function gate(action, payload = {}) {
    const previous = capturePrevious();
    if (action === "status") return updateResult(previous);

    if (action === "start_task") {
      const taskId = payload.taskId ?? taskIdFactory(payload);
      const contextId = payload.contextId ?? contextIdFactory({ ...payload, taskId });
      const reasoningProfile = freezeReasoningProfile({
        ...(payload.reasoningProfile ?? {}),
        taskId,
        complexity: payload.complexity ?? payload.reasoningProfile?.complexity ?? "medium",
      }, { previous: state.reasoningProfile, revision: revision + 1 });
      state = transitionState(state, action, { ...payload, taskId, contextId, reasoningProfile });
      memory = startTaskMemory(memory, {
        taskId: state.taskId,
        contextId: state.contextId,
        role: "planner",
        status: "planning",
        reasoningProfile,
        objective: payload.objective ?? payload.taskLabel ?? "",
        taskType: payload.taskType,
        acceptance: payload.acceptance ?? [],
        constraints: payload.constraints ?? [],
        pending: payload.pending ?? (payload.taskLabel ? [payload.taskLabel] : []),
        currentTask: payload.currentTask ?? payload.taskLabel ?? payload.objective ?? "",
      });
      pendingRequest = null;
      latestPolicyDecision = safeEvaluatePolicy({ state, memory, reasoningProfile });
      revision += 1;
      emitLifecycle("task_started", { role: "planner", metadata: { complexity: reasoningProfile.complexity } });
      emitLifecycle("reasoning_profile_frozen", { role: "planner", metadata: { reasoningProfile } });
      return updateResult(previous);
    }

    if (["luna_failed", "validation_failed"].includes(action)) {
      const report = payload.report && typeof payload.report === "object"
        ? payload.report
        : {
            passed: false,
            sourceRole: state.phase === "sol-recovery" ? "sol" : "luna",
            reason: payload.reason,
            log: payload.errorLog,
            currentError: payload.currentError,
          };
      memory = recordValidationReport(memory, report, { requestId: payload.requestId });
      const snapshotId = payload.snapshotId ?? snapshotIdFactory({ state: getState(), memory: getMemory(), report });
      memory = createFailureSnapshot(memory, {
        snapshotId,
        taskId: state.taskId,
        contextId: state.contextId,
        sourceRole: state.phase === "sol-recovery" ? "sol" : "luna",
        attempt: state.phase === "sol-recovery" ? state.attempts.sol : Math.max(1, state.lunaValidationFailures + 1),
        currentError: report.currentError ?? report.error ?? {
          type: "validation_failure",
          message: payload.reason,
          log: payload.errorLog,
        },
        validation: report,
      });
      state = transitionState(state, action, {
        ...payload,
        sourceRole: state.phase === "sol-recovery" ? "sol" : payload.sourceRole,
        snapshotId,
      });
      pendingRequest = null;
      revision += 1;
      emitLifecycle("worker_failed", { role: state.phase === "sol-recovery" ? "sol" : "luna", metadata: { action, reason: payload.reason } });
      emitLifecycle("snapshot_created", { role: state.phase === "sol-recovery" ? "sol" : "luna", metadata: { snapshotId } });
      return updateResult(previous);
    }

    if (action === "passed" && state.contextId) {
      const latestValidation = memory.artifact.validationReports.at(-1);
      const validated = latestValidation?.passed === true
        || latestValidation?.status === "passed"
        || latestValidation?.status === "success";
      if (!validated) {
        throw new Error("A v2 task can be marked passed only from a recorded successful Validator result.");
      }
    }

    if (["passed", "validation_passed"].includes(action)) {
      memory = recordValidationReport(memory, payload.report ?? {
        passed: true,
        sourceRole: state.phase === "sol-recovery" ? "sol" : "luna",
      }, { requestId: payload.requestId });
    }

    if (action === "sol_failed") {
      memory = recordValidationReport(memory, payload.report ?? {
        passed: false,
        sourceRole: "sol",
        reason: payload.reason,
        log: payload.errorLog,
      }, { requestId: payload.requestId });
      const snapshotId = payload.snapshotId ?? snapshotIdFactory({ state: getState(), memory: getMemory() });
      memory = createFailureSnapshot(memory, {
        snapshotId,
        sourceRole: "sol",
        attempt: state.attempts.sol,
        currentError: { type: "recovery_failure", message: payload.reason, log: payload.errorLog },
      });
      payload = { ...payload, snapshotId };
    }

    state = transitionState(state, action, payload);
    if (payload.snapshotId) state = normalizeState({ ...state, latestFailureSnapshotId: payload.snapshotId });
    pendingRequest = null;
    memory = appendRuntimeEvent(memory, { action, stage: state.stage, role: state.activeRole });
    revision += 1;
    if (["passed", "validation_passed"].includes(action)) emitLifecycle("task_completed", { metadata: { action } });
    if (action === "sol_failed") emitLifecycle("task_escalated", { role: "sol", metadata: { reason: payload.reason } });
    return updateResult(previous);
  }

  function prepareAgentCall({ agentType, resume = false } = {}) {
    const normalizedAgentType = typeof agentType === "string" ? agentType.trim().toLowerCase() : "";
    const previous = capturePrevious();
    const verdict = canInvokeAgent(state, normalizedAgentType, { resume: Boolean(resume) });
    if (!verdict.allowed) {
      return {
        allowed: false,
        reason: verdict.reason,
        ...updateResult(previous),
      };
    }
    if (normalizedAgentType === ROLE_TO_AGENT[ROUTER_ROLES.SOL]) {
      state = transitionState(state, "sol_started");
      revision += 1;
    }
    return { allowed: true, ...updateResult(previous) };
  }

  function getContextEnvelope({ role, limits, validatorMode, semanticMatches } = {}) {
    return buildContextEnvelope(memory, { role, limits, validatorMode, semanticMatches });
  }

  function routeFor(role, complexity) {
    if (!modelRoutes) return null;
    const resolved = resolveRoleRoute(modelRoutes, role, isModelAvailable, {
      complexity,
      taskType: memory.task.taskType ?? complexity,
      performanceStore,
      modelRanker,
      modelScorer,
    });
    if (role === "planner" && resolved.mode === "inherit") {
      return { mode: "inherit", thinking: resolved.thinking };
    }
    return resolved.selection ? clone(resolved.selection) : null;
  }

  function prepareWorkerRequest({
    role,
    instruction,
    task,
    resume = false,
    complexity,
    maxInputTokens,
    limits,
    routing: explicitRouting,
    validatorMode,
    semanticQuery,
    semanticTopK = 3,
  } = {}) {
    const normalizedRole = normalizeRole(role);
    const currentTask = nonEmptyString(instruction ?? task ?? memory.task.currentTask ?? state.taskLabel);
    if (!currentTask) throw new Error("A non-empty worker instruction is required.");

    const previous = capturePrevious();
    let reasoningProfile = state.reasoningProfile ?? memory.runtime.reasoningProfile;
    if (!reasoningProfile) {
      reasoningProfile = freezeReasoningProfile({ taskId: state.taskId, complexity: complexity ?? "medium" }, { revision: revision + 1 });
      state = normalizeState({ ...state, reasoningProfile });
      memory = normalizeTaskMemory({
        ...memory,
        revision: memory.revision + 1,
        runtime: { ...memory.runtime, reasoningProfile },
      });
      emitLifecycle("reasoning_profile_frozen", { role: "planner", metadata: { reasoningProfile, lazy: true } });
    }
    if (complexity && complexity !== reasoningProfile.complexity) {
      return {
        allowed: false,
        reason: `Reasoning Profile is frozen at complexity ${reasoningProfile.complexity}; requested ${complexity}.`,
        request: null,
        ...updateResult(previous),
      };
    }
    if (pendingRequest) {
      return {
        allowed: false,
        reason: `Worker request ${pendingRequest.requestId} for ${pendingRequest.role} is still pending. Record or resolve it before preparing another worker.`,
        request: null,
        ...updateResult(previous),
      };
    }
    latestPolicyDecision = safeEvaluatePolicy({
      state,
      memory,
      reasoningProfile,
      action: normalizedRole === "validator" ? "run_validator" : normalizedRole === "sol" ? "run_sol" : "run_luna",
      role: normalizedRole,
      validatorMode,
      fastValidatorFailed: state.validatorMode == null ? false : undefined,
    });
    if (!latestPolicyDecision.allowed) {
      return {
        allowed: false,
        reason: latestPolicyDecision.reason,
        policyDecision: clone(latestPolicyDecision),
        request: null,
        ...updateResult(previous),
      };
    }
    const selectedValidatorMode = normalizedRole === "validator"
      ? latestPolicyDecision.validatorMode ?? validatorMode ?? "fast"
      : null;
    const frozenComplexity = reasoningProfile.complexity;
    const semanticMatches = safeRetrieveSemantic(memory.semantic, semanticQuery ?? currentTask, { topK: semanticTopK });
    const verdict = canInvokeAgent(state, ROLE_TO_AGENT[normalizedRole], { resume: Boolean(resume) });
    if (!verdict.allowed) {
      return {
        allowed: false,
        reason: verdict.reason,
        request: null,
        ...updateResult(previous),
      };
    }

    state = transitionState(state, "worker_started", { role: normalizedRole, validatorMode: selectedValidatorMode });
    memory = runtimeMemory(memory, state, normalizedRole, state.stage);
    memory = normalizeTaskMemory({
      ...memory,
      revision: memory.revision + 1,
      runtime: { ...memory.runtime, validatorMode: selectedValidatorMode, reasoningProfile },
    });
    const requestId = requestIdFactory({ role: normalizedRole, state: getState(), memory: getMemory() });
    const snapshotId = normalizedRole === ROUTER_ROLES.SOL ? state.latestFailureSnapshotId : null;
    let contextWasCompressed = false;
    let envelope = getContextEnvelope({
      role: normalizedRole,
      limits,
      validatorMode: selectedValidatorMode,
      semanticMatches,
    });
    envelope = {
      ...envelope,
      runtime: {
        ...envelope.runtime,
        task_id: state.taskId,
        context_id: state.contextId,
        snapshot_id: snapshotId,
        request_id: requestId,
        role: normalizedRole,
        stage: state.stage,
        status: state.stage,
        attempt: state.attempts[normalizedRole],
        validator_mode: selectedValidatorMode,
        reasoning_profile: reasoningProfile,
      },
    };
    const routing = explicitRouting ? clone(explicitRouting) : routeFor(normalizedRole, frozenComplexity);
    const budget = resolveTokenBudget({
      role: normalizedRole,
      complexity: frozenComplexity,
      policy: normalizedBudgetPolicy,
      budgetProfile: routing?.budgetProfile,
      feedback: memory.runtime.usageFeedback,
      taskType: memory.task.taskType ?? frozenComplexity,
    });
    const frozenThinking = normalizedRole === "validator"
      ? reasoningProfile.roles.validator[selectedValidatorMode].thinking
      : reasoningProfile.roles[normalizedRole].thinking;
    const render = (candidate) => renderWorkerPrompt({
      role: normalizedRole, contextEnvelope: candidate, currentTask,
    });
    let renderedPrompt = render(envelope);
    let inputTokenEstimate = estimateTokens(renderedPrompt, tokenEstimator);
    if (Number.isInteger(maxInputTokens) && maxInputTokens > 0 && inputTokenEstimate > maxInputTokens) {
      // One compaction pass measured against the complete wire prompt. Subtracting
      // independent estimates is not valid for arbitrary/custom tokenizers.
      envelope = compactEnvelopeToBudget(envelope, {
        inputTokens: maxInputTokens,
        measureTokens: (candidate) => {
          renderedPrompt = render(candidate);
          inputTokenEstimate = estimateTokens(renderedPrompt, tokenEstimator);
          return inputTokenEstimate;
        },
      });
      contextWasCompressed = true;
    }
    const request = {
      protocolVersion: ROUTER_PROTOCOL_VERSION,
      dispatched: false,
      requestId,
      role: normalizedRole,
      taskId: state.taskId,
      contextId: state.contextId,
      snapshotId,
      attempt: state.attempts[normalizedRole],
      validatorMode: selectedValidatorMode,
      reasoningProfile: clone(reasoningProfile),
      policyDecision: clone(latestPolicyDecision),
      semanticMatches: clone(semanticMatches),
      instruction: currentTask,
      contextEnvelope: envelope,
      envelope,
      budget: {
        ...budget,
        thinking: frozenThinking,
        maxOutputTokens: budget.outputTokens,
        inputTokenEstimate,
        ...(Number.isInteger(maxInputTokens) && maxInputTokens > 0 ? { maxInputTokens } : {}),
      },
      routing,
      renderedPrompt,
    };
    pendingRequest = clone(request);
    revision += 1;
    emitLifecycle("agent_selected", {
      role: normalizedRole,
      metadata: { validatorMode: selectedValidatorMode, policyDecision: latestPolicyDecision },
    });
    emitLifecycle("context_projected", {
      role: normalizedRole,
      metadata: { projection: envelope.projection, semanticMatches: semanticMatches.length },
    });
    if (contextWasCompressed) emitLifecycle("context_compressed", { role: normalizedRole, metadata: { maxInputTokens } });
    if (normalizedRole === "validator") emitLifecycle("validation_started", { role: "validator", metadata: { validatorMode: selectedValidatorMode } });
    if (normalizedRole === "sol") emitLifecycle("recovery_started", { role: "sol", metadata: { snapshotId } });
    return {
      allowed: true,
      request: clone(request),
      ...updateResult(previous),
    };
  }

  function prepareWorkerCall({ role, resume = false } = {}) {
    const normalizedRole = normalizeRole(role);
    return prepareAgentCall({ agentType: ROLE_TO_AGENT[normalizedRole], resume });
  }

  function markWorkerDispatched({ role, requestId } = {}) {
    const normalizedRole = normalizeRole(role);
    const previous = capturePrevious();
    const effectiveRequestId = requestId ?? pendingRequest?.requestId;
    requirePending(normalizedRole, effectiveRequestId);
    if (pendingRequest.dispatched === true) {
      return {
        allowed: false,
        reason: `Worker request ${effectiveRequestId} has already been dispatched.`,
        ...updateResult(previous),
      };
    }
    pendingRequest = { ...pendingRequest, dispatched: true };
    revision += 1;
    emitLifecycle("worker_dispatched", {
      role: normalizedRole,
      metadata: { requestId: effectiveRequestId, validatorMode: pendingRequest.validatorMode },
    });
    return { allowed: true, ...updateResult(previous) };
  }

  function requirePending(role, requestId) {
    if (!requestId) return;
    if (!pendingRequest) throw new Error(`No pending ${role} request exists for requestId ${requestId}.`);
    if (pendingRequest.role !== role || pendingRequest.requestId !== requestId) {
      throw new Error(`Stale or mismatched worker result for requestId ${requestId}.`);
    }
  }

  function recordWorkerReport({ role, report = {}, requestId } = {}) {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === ROUTER_ROLES.VALIDATOR) {
      throw new Error("Use recordValidation() for validator reports.");
    }
    const previous = capturePrevious();
    if (!pendingRequest) throw new Error(`No pending ${normalizedRole} worker request exists.`);
    const effectiveRequestId = requestId ?? report?.requestId ?? pendingRequest.requestId;
    requirePending(normalizedRole, effectiveRequestId);
    if (pendingRequest.dispatched !== true) {
      throw new Error(`Worker request ${effectiveRequestId} has not been dispatched.`);
    }
    memory = updateWorkerMemory(memory, {
      ...(report && typeof report === "object" ? report : { summary: String(report) }),
      requestId: effectiveRequestId,
      sourceRole: normalizedRole,
      attempt: state.attempts[normalizedRole],
    });
    state = transitionState(state, "worker_completed", { role: normalizedRole });
    memory = runtimeMemory(memory, state, "validator", "validating");
    pendingRequest = null;
    revision += 1;
    return updateResult(previous);
  }

  function recordValidation({ role, report = {}, requestId, trustedHost = false } = {}) {
    if (state.stage !== "validating" || !["luna", "sol-recovery"].includes(state.phase)) {
      throw new Error(`Validation results are allowed only during validating, not phase ${state.phase} stage ${state.stage}.`);
    }
    if (pendingRequest && pendingRequest.role !== ROUTER_ROLES.VALIDATOR) {
      throw new Error(`Cannot record validation while ${pendingRequest.role} request ${pendingRequest.requestId} is pending.`);
    }
    if (!pendingRequest && trustedHost !== true) {
      throw new Error("A prepared Validator request is required before recording validation.");
    }
    if (pendingRequest && pendingRequest.dispatched !== true) {
      throw new Error(`Validator request ${pendingRequest.requestId} has not been dispatched.`);
    }
    const implementationRole = role
      ? normalizeRole(role)
      : state.phase === "sol-recovery" ? ROUTER_ROLES.SOL : ROUTER_ROLES.LUNA;
    if (implementationRole === ROUTER_ROLES.VALIDATOR) {
      throw new Error("Validation must identify the implementation role as luna or sol.");
    }
    const previous = capturePrevious();
    const effectiveRequestId = requestId ?? report?.requestId ?? pendingRequest?.requestId;
    if (pendingRequest) requirePending(ROUTER_ROLES.VALIDATOR, effectiveRequestId);
    const validationMode = pendingRequest?.validatorMode ?? state.validatorMode ?? (trustedHost ? "deep" : "fast");
    const normalizedReport = report && typeof report === "object" ? report : { reason: String(report) };
    const passed = normalizedReport.passed === true
      || normalizedReport.status === "passed"
      || normalizedReport.status === "success";
    memory = recordValidationReport(memory, {
      ...normalizedReport,
      requestId: effectiveRequestId,
      sourceRole: implementationRole,
      validatorMode: validationMode,
      passed,
    });
    pendingRequest = null;
    emitLifecycle("validation_completed", {
      role: "validator",
      metadata: { validatorMode: validationMode, passed, implementationRole },
    });

    if (validationMode === "fast") {
      latestPolicyDecision = safeEvaluatePolicy({
        state: { ...state, validatorMode: "fast" },
        memory,
        reasoningProfile: getReasoningProfile(),
        fastValidatorFailed: !passed,
      });
      if (latestPolicyDecision.nextAction === "run_validator" && latestPolicyDecision.validatorMode === "deep") {
        state = normalizeState({ ...state, activeRole: "validator", validatorMode: "deep" });
        memory = normalizeTaskMemory({
          ...memory,
          revision: memory.revision + 1,
          runtime: { ...memory.runtime, status: "validating", role: "validator", validatorMode: "deep" },
        });
        revision += 1;
        return updateResult(previous);
      }
    }

    if (passed) {
      state = transitionState(state, "validation_passed", { report: normalizedReport });
      emitLifecycle("task_completed", { role: implementationRole, metadata: { validatorMode: validationMode } });
    } else {
      const reason = nonEmptyString(normalizedReport.reason)
        ?? nonEmptyString(normalizedReport.currentError?.message)
        ?? nonEmptyString(normalizedReport.current_error?.message)
        ?? "Validator reported one or more failed checks.";
      const snapshotId = snapshotIdFactory({ state: getState(), memory: getMemory(), report: normalizedReport });
      memory = createFailureSnapshot(memory, {
        snapshotId,
        taskId: state.taskId,
        contextId: state.contextId,
        sourceRole: implementationRole,
        attempt: state.attempts[implementationRole],
        currentError: normalizedReport.currentError ?? normalizedReport.current_error ?? normalizedReport.error ?? {
          type: "validation_failure",
          message: reason,
          log: normalizedReport.log,
        },
        validation: normalizedReport,
        decisionSummary: normalizedReport.decision_summary ?? memory.artifact.workerReports.at(-1)?.decision_summary,
      });
      state = transitionState(state, "validation_failed", {
        reason,
        sourceRole: implementationRole,
        snapshotId,
      });
      emitLifecycle("worker_failed", { role: implementationRole, metadata: { reason, validatorMode: validationMode } });
      emitLifecycle("snapshot_created", { role: implementationRole, metadata: { snapshotId, validatorMode: validationMode } });
      if (state.phase === "escalated") emitLifecycle("task_escalated", { role: "sol", metadata: { reason } });
    }
    revision += 1;
    return updateResult(previous);
  }

  function recordModelFeedback(feedback = {}) {
    const previous = capturePrevious();
    performanceStore = recordModelPerformance(performanceStore, feedback);
    revision += 1;
    return updateResult(previous);
  }

  function recordUsageFeedback(feedback = {}) {
    const previous = capturePrevious();
    memory = updateUsageMemory(memory, feedback);
    revision += 1;
    emitLifecycle("usage_recorded", {
      role: feedback.role,
      metadata: {
        requestId: feedback.requestId,
        inputTokens: feedback.inputTokens,
        outputTokens: feedback.outputTokens,
        latencyMs: feedback.latencyMs,
        success: feedback.success === true,
      },
    });
    return updateResult(previous);
  }

  function addSemanticMemory(entry, options = {}) {
    const previous = capturePrevious();
    const semantic = addSemanticEntry(memory.semantic, entry, { revision: revision + 1, ...options });
    memory = normalizeTaskMemory({ ...memory, revision: memory.revision + 1, semantic });
    revision += 1;
    return updateResult(previous);
  }

  function retrieveRelevantMemory(query, options = {}) {
    return safeRetrieveSemantic(memory.semantic, query, options);
  }

  function getFailureSnapshot(snapshotId) {
    return selectFailureSnapshot(memory, snapshotId);
  }

  function reset() {
    const previous = capturePrevious();
    state = initialState();
    memory = initialTaskMemory();
    pendingRequest = null;
    revision += 1;
    return updateResult(previous);
  }

  return Object.freeze({
    getState,
    getMemory,
    getPendingRequest,
    getReasoningProfile,
    getPolicyDecision,
    getModelPerformanceStore,
    getContextEnvelope,
    getFailureSnapshot,
    retrieveRelevantMemory,
    snapshot: currentSnapshot,
    restore,
    gate: (...args) => atomically(() => gate(...args)),
    prepareAgentCall: (...args) => atomically(() => prepareAgentCall(...args)),
    prepareWorkerCall: (...args) => atomically(() => prepareWorkerCall(...args)),
    prepareWorkerRequest: (...args) => atomically(() => prepareWorkerRequest(...args)),
    markWorkerDispatched: (...args) => atomically(() => markWorkerDispatched(...args)),
    recordWorkerReport: (...args) => atomically(() => recordWorkerReport(...args)),
    recordValidation: (...args) => atomically(() => recordValidation(...args)),
    recordUsageFeedback: (...args) => atomically(() => recordUsageFeedback(...args)),
    recordModelFeedback: (...args) => atomically(() => recordModelFeedback(...args)),
    addSemanticMemory: (...args) => atomically(() => addSemanticMemory(...args)),
    reset: (...args) => atomically(() => reset(...args)),
  });
}
