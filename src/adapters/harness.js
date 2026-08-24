import { formatState } from "../core.js";
import {
  CACHE_FRIENDLY_PROTOCOL_PREFIX,
  renderRuntimeSuffix,
  validateWorkerOutput,
} from "../prompt-protocol.js";
import { ROUTER_ROLES, createRouterService } from "../router-service.js";

const VALID_ROLES = new Set(Object.values(ROUTER_ROLES));
const REQUIRED_BINDING_ROLES = [ROUTER_ROLES.LUNA, ROUTER_ROLES.SOL];

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!VALID_ROLES.has(normalized)) throw new Error(`Unknown router worker role: ${String(role)}`);
  return normalized;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

function instructionFromInput(input, role) {
  if (typeof input === "string" && input.trim()) return input.trim();
  if (input && typeof input === "object") {
    for (const key of ["instruction", "prompt", "task"]) {
      if (typeof input[key] === "string" && input[key].trim()) return input[key].trim();
    }
  }
  return role === ROUTER_ROLES.VALIDATOR
    ? "Validate the current artifact against the acceptance criteria."
    : role === ROUTER_ROLES.SOL
      ? "Repair the current task using the latest Failure Snapshot."
      : "Implement the current approved task.";
}

function reportFromResult(result, role, requestId) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return { ...result, requestId, sourceRole: role };
  }
  return { requestId, sourceRole: role, summary: result == null ? "" : String(result) };
}

export function createHarnessPromptPrefix({ harnessName = "agent harness" } = {}) {
  return `${CACHE_FRIENDLY_PROTOCOL_PREFIX}\n\n## Host Orchestration Protocol\n- Active host: ${harnessName}.\n- The parent plans, schedules, and makes the final decision; implementation is delegated.\n- Luna implements, Validator performs read-only checks, and Sol repairs only from the latest Failure Snapshot.\n- A worker success claim never bypasses Validator or explicit host validation.\n- The parent must enforce write restrictions using host permissions or a sandbox.`;
}

export function createHarnessRuntimeContext({ harnessName = "agent harness", state, memory } = {}) {
  return [
    `Host: ${harnessName}`,
    `Router state: ${formatState(state)}`,
    `Memory revision: ${memory?.revision ?? 0}`,
  ].join("\n");
}

export function createHarnessInstructions(options = {}) {
  return `${createHarnessPromptPrefix(options)}\n\n${createHarnessRuntimeContext(options)}`;
}

/**
 * Callback-based adapter for unknown agent harnesses. It keeps all v2 protocol
 * metadata available while retaining the legacy opaque input and binding fields.
 */
export function createHarnessAdapter({
  harnessName = "agent-harness",
  snapshot,
  taskIdFactory,
  contextIdFactory,
  snapshotIdFactory,
  requestIdFactory,
  budgetPolicy,
  modelRoutes,
  isModelAvailable,
  workerBindings,
  invokeWorker,
  saveSnapshot = async () => {},
  autoRecordValidator = true,
  strictWorkerOutput = true,
} = {}) {
  requireFunction(invokeWorker, "invokeWorker");
  requireFunction(saveSnapshot, "saveSnapshot");
  if (!workerBindings || typeof workerBindings !== "object" || Array.isArray(workerBindings)) {
    throw new TypeError("workerBindings must be an object with luna and sol entries; validator is optional.");
  }
  for (const role of REQUIRED_BINDING_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(workerBindings, role)) {
      throw new TypeError(`workerBindings.${role} is required.`);
    }
  }

  const router = createRouterService({
    snapshot,
    taskIdFactory,
    contextIdFactory,
    snapshotIdFactory,
    requestIdFactory,
    budgetPolicy,
    modelRoutes,
    isModelAvailable,
  });
  let transactionTail = Promise.resolve();

  function transact(operation) {
    const result = transactionTail.then(operation, operation);
    transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(update, reason, metadata = {}) {
    if (!update.changed) return;
    try {
      await saveSnapshot(router.snapshot(), { ...metadata, harnessName, reason });
    } catch (error) {
      router.restore(update.previousSnapshot ?? update.previousState);
      throw error;
    }
  }

  async function gate(action, payload = {}) {
    return transact(async () => {
      const update = router.gate(action, payload);
      await persist(update, "gate", { action });
      return { ...update, snapshot: router.snapshot() };
    });
  }

  async function recordWorkerReport(role, report, options = {}) {
    const normalizedRole = normalizeRole(role);
    return transact(async () => {
      const update = router.recordWorkerReport({
        role: normalizedRole,
        report,
        requestId: options.requestId,
      });
      await persist(update, "worker_result", { role: normalizedRole, requestId: options.requestId });
      return { ...update, snapshot: router.snapshot() };
    });
  }

  async function recordValidation(role, report, options = {}) {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === ROUTER_ROLES.VALIDATOR) {
      throw new Error("recordValidation role must be luna or sol, not validator.");
    }
    return transact(async () => {
      const update = router.recordValidation({
        role: normalizedRole,
        report,
        requestId: options.requestId,
        trustedHost: true,
      });
      await persist(update, "validation_result", { role: normalizedRole, requestId: options.requestId });
      return { ...update, snapshot: router.snapshot() };
    });
  }

  async function invoke(role, input, {
    resume = false,
    signal,
    metadata,
    complexity,
    maxInputTokens,
    validatorMode,
  } = {}) {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === ROUTER_ROLES.VALIDATOR
      && !Object.prototype.hasOwnProperty.call(workerBindings, ROUTER_ROLES.VALIDATOR)) {
      throw new Error("workerBindings.validator is required to invoke the Validator agent.");
    }

    const launch = await transact(async () => {
      if (router.getState().phase === "idle" && normalizedRole === ROUTER_ROLES.LUNA) {
        const autoStart = router.gate("start_task", {
          taskLabel: instructionFromInput(input, normalizedRole).slice(0, 120),
          objective: instructionFromInput(input, normalizedRole),
        });
        await persist(autoStart, "auto_start_task", { role: normalizedRole });
      }

      const prepared = router.prepareWorkerRequest({
        role: normalizedRole,
        instruction: instructionFromInput(input, normalizedRole),
        resume,
        complexity,
        maxInputTokens,
        validatorMode,
      });
      if (!prepared.allowed) {
        return {
          blocked: true,
          reason: prepared.reason,
          state: prepared.state,
          snapshot: router.snapshot(),
        };
      }

      const dispatched = router.markWorkerDispatched({
        role: normalizedRole,
        requestId: prepared.request.requestId,
      });
      if (!dispatched.allowed) {
        router.restore(prepared.previousSnapshot);
        return {
          blocked: true,
          reason: dispatched.reason,
          state: router.getState(),
          snapshot: router.snapshot(),
        };
      }
      await persist({
        ...dispatched,
        previousState: prepared.previousState,
        previousSnapshot: prepared.previousSnapshot,
      }, "worker_started", {
        role: normalizedRole,
        requestId: prepared.request.requestId,
      });
      const routerState = router.getState();
      const launchSnapshot = router.snapshot();
      const request = prepared.request;
      let resultPromise;
      try {
        resultPromise = Promise.resolve(invokeWorker({
          harnessName,
          role: normalizedRole,
          binding: workerBindings[normalizedRole],
          input,
          resume: Boolean(resume),
          signal,
          metadata,
          routerState,
          snapshot: launchSnapshot,
          request,
          requestId: request.requestId,
          taskId: request.taskId,
          contextId: request.contextId,
          snapshotId: request.snapshotId,
          contextEnvelope: request.contextEnvelope,
          envelope: request.envelope,
          budget: request.budget,
          routing: request.routing,
          reasoningProfile: request.reasoningProfile,
          policyDecision: request.policyDecision,
          validatorMode: request.validatorMode,
          semanticMatches: request.semanticMatches,
          promptPrefix: CACHE_FRIENDLY_PROTOCOL_PREFIX,
          runtimeSuffix: renderRuntimeSuffix({
            role: normalizedRole,
            contextEnvelope: request.contextEnvelope,
            currentTask: request.instruction,
          }),
          renderedPrompt: request.renderedPrompt,
        }));
      } catch (error) {
        resultPromise = Promise.reject(error);
      }
      return { blocked: false, request, resultPromise };
    });

    if (launch.blocked) {
      return {
        ok: false,
        blocked: true,
        reason: launch.reason,
        state: launch.state,
        snapshot: launch.snapshot,
      };
    }

    let result;
    try {
      result = await launch.resultPromise;
    } catch (error) {
      await transact(async () => {
        const reason = error instanceof Error ? error.message : String(error);
        const state = router.getState();
        const update = normalizedRole === ROUTER_ROLES.VALIDATOR && launch.request.validatorMode === "fast"
          ? router.recordValidation({
              role: state.phase === "sol-recovery" ? ROUTER_ROLES.SOL : ROUTER_ROLES.LUNA,
              requestId: launch.request.requestId,
              report: {
                passed: false,
                reason: `Fast Validator execution failed: ${reason}`,
                current_error: { type: "validator_execution_failure", message: reason, log: error instanceof Error ? error.stack ?? reason : reason },
              },
            })
          : router.gate(normalizedRole === ROUTER_ROLES.SOL || state.phase === "sol-recovery" ? "sol_failed" : "luna_failed", {
              reason: `Worker execution failed: ${reason}`,
              errorLog: error instanceof Error ? error.stack : reason,
            });
        await persist(update, "worker_error", { role: normalizedRole, requestId: launch.request.requestId });
      });
      throw error;
    }

    let structuredResult = result;
    if (strictWorkerOutput) {
      try {
        structuredResult = validateWorkerOutput(normalizedRole, result);
      } catch (error) {
        await transact(async () => {
          const reason = error instanceof Error ? error.message : String(error);
          const state = router.getState();
          const update = normalizedRole === ROUTER_ROLES.VALIDATOR && launch.request.validatorMode === "fast"
            ? router.recordValidation({
                role: state.phase === "sol-recovery" ? ROUTER_ROLES.SOL : ROUTER_ROLES.LUNA,
                requestId: launch.request.requestId,
                report: {
                  passed: false,
                  reason: `Invalid Fast Validator structured output: ${reason}`,
                  current_error: { type: "invalid_validator_output", message: reason, log: reason },
                },
              })
            : router.gate(state.phase === "sol-recovery" ? "sol_failed" : "luna_failed", {
                reason: `Invalid ${normalizedRole} structured output: ${reason}`,
                errorLog: reason,
              });
          await persist(update, "invalid_worker_output", { role: normalizedRole, requestId: launch.request.requestId });
        });
        throw error;
      }
    }

    await transact(async () => {
      if (normalizedRole === ROUTER_ROLES.VALIDATOR) {
        if (autoRecordValidator && structuredResult && typeof structuredResult === "object" && typeof structuredResult.passed === "boolean") {
          const implementationRole = router.getState().phase === "sol-recovery" ? ROUTER_ROLES.SOL : ROUTER_ROLES.LUNA;
          const update = router.recordValidation({
            role: implementationRole,
            requestId: launch.request.requestId,
            report: reportFromResult(structuredResult, ROUTER_ROLES.VALIDATOR, launch.request.requestId),
          });
          await persist(update, "validation_result", { role: implementationRole, requestId: launch.request.requestId });
        }
      } else {
        const update = router.recordWorkerReport({
          role: normalizedRole,
          requestId: launch.request.requestId,
          report: reportFromResult(structuredResult, normalizedRole, launch.request.requestId),
        });
        await persist(update, "worker_result", { role: normalizedRole, requestId: launch.request.requestId });
      }
    });

    return {
      ok: true,
      blocked: false,
      result,
      request: launch.request,
      state: router.getState(),
      snapshot: router.snapshot(),
    };
  }

  async function reset(metadata = {}) {
    return transact(async () => {
      const update = router.reset();
      await persist(update, "reset", metadata);
      return { ...update, snapshot: router.snapshot() };
    });
  }

  return Object.freeze({
    harnessName,
    getState: router.getState,
    getMemory: router.getMemory,
    getSnapshot: router.snapshot,
    getFailureSnapshot: router.getFailureSnapshot,
    getPromptPrefix: () => createHarnessPromptPrefix({ harnessName }),
    getRuntimeContext: () => createHarnessRuntimeContext({
      harnessName,
      state: router.getState(),
      memory: router.getMemory(),
    }),
    getInstructions: () => createHarnessInstructions({
      harnessName,
      state: router.getState(),
      memory: router.getMemory(),
    }),
    gate,
    invoke,
    recordWorkerReport,
    recordValidation,
    recordUsageFeedback: async (feedback) => transact(async () => {
      const update = router.recordUsageFeedback(feedback);
      await persist(update, "usage_feedback", { role: feedback?.role, requestId: feedback?.requestId });
      return { ...update, snapshot: router.snapshot() };
    }),
    addSemanticMemory: async (entry, options) => transact(async () => {
      const update = router.addSemanticMemory(entry, options);
      await persist(update, "semantic_memory", { taskType: entry?.taskType });
      return { ...update, snapshot: router.snapshot() };
    }),
    retrieveRelevantMemory: router.retrieveRelevantMemory,
    getReasoningProfile: router.getReasoningProfile,
    getPolicyDecision: router.getPolicyDecision,
    getModelPerformanceStore: router.getModelPerformanceStore,
    recordModelFeedback: async (feedback) => transact(async () => {
      const update = router.recordModelFeedback(feedback);
      await persist(update, "model_feedback", { provider: feedback?.provider, model: feedback?.model });
      return { ...update, snapshot: router.snapshot() };
    }),
    reset,
  });
}

export default createHarnessAdapter;
