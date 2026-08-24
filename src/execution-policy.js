export const REASONING_PROFILE_VERSION = "2.1";
export const VALIDATOR_MODES = Object.freeze(["fast", "deep"]);

const COMPLEXITIES = Object.freeze(["low", "medium", "high"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ACTION_ROLES = Object.freeze({
  run_luna: "luna",
  run_validator: "validator",
  run_sol: "sol",
  complete: null,
  escalate: null,
  wait: null,
});

const DEFAULT_PROFILE = Object.freeze({
  planner: "high",
  luna: "medium",
  validatorFast: "low",
  validatorDeep: "medium",
  sol: "high",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function complexity(value, fallback = "medium") {
  const normalized = text(value)?.toLowerCase();
  return COMPLEXITIES.includes(normalized) ? normalized : fallback;
}

function thinking(value, fallback) {
  const candidate = typeof value === "string" ? value : value?.thinking;
  const normalized = text(candidate)?.toLowerCase();
  return THINKING_LEVELS.has(normalized) ? normalized : fallback;
}

function revision(value, fallback = null) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Return the canonical, JSON-serializable v2.1 Reasoning Profile shape.
 * Unknown fields are intentionally discarded and all retained data is copied.
 */
export function normalizeReasoningProfile(value = {}) {
  const source = isObject(value) ? value : {};
  const roles = isObject(source.roles) ? source.roles : {};
  const validator = isObject(roles.validator) ? roles.validator : {};

  return {
    version: REASONING_PROFILE_VERSION,
    taskId: text(source.taskId ?? source.task_id),
    complexity: complexity(source.complexity),
    roles: {
      planner: { thinking: thinking(roles.planner, DEFAULT_PROFILE.planner) },
      luna: { thinking: thinking(roles.luna, DEFAULT_PROFILE.luna) },
      validator: {
        fast: { thinking: thinking(validator.fast, DEFAULT_PROFILE.validatorFast) },
        deep: { thinking: thinking(validator.deep, DEFAULT_PROFILE.validatorDeep) },
      },
      // Recovery is invariant: it is never upgraded through Luna and never downgraded.
      sol: { thinking: DEFAULT_PROFILE.sol },
    },
    frozenAtRevision: revision(source.frozenAtRevision ?? source.frozen_at_revision),
  };
}

function profileSignature(profile) {
  return JSON.stringify({
    complexity: profile.complexity,
    roles: profile.roles,
  });
}

function looksLikeProfileUpdate(value) {
  return isObject(value) && ["taskId", "task_id", "complexity", "roles", "version"].some((key) => key in value);
}

/**
 * Freeze a Reasoning Profile both logically (frozenAtRevision) and structurally.
 *
 * Supported forms:
 *   freezeReasoningProfile(profile, revision)
 *   freezeReasoningProfile(profile, { revision, previous, onDrift })
 *   freezeReasoningProfile(previousFrozenProfile, proposedProfile)
 *
 * onDrift may be "reject" (default) or "ignore".
 */
export function freezeReasoningProfile(value = {}, revisionOrOptions = {}) {
  let candidate = value;
  let previous = null;
  let options = {};

  if (typeof revisionOrOptions === "number") {
    options = { revision: revisionOrOptions };
  } else if (looksLikeProfileUpdate(revisionOrOptions)
    && !("previous" in revisionOrOptions || "existing" in revisionOrOptions || "frozenProfile" in revisionOrOptions)) {
    const first = normalizeReasoningProfile(value);
    const second = normalizeReasoningProfile(revisionOrOptions);
    if (first.frozenAtRevision !== null) {
      previous = first;
      candidate = second;
    } else if (second.frozenAtRevision !== null) {
      previous = second;
      candidate = first;
    } else {
      options = revisionOrOptions;
    }
  } else {
    options = isObject(revisionOrOptions) ? revisionOrOptions : {};
    previous = options.previous ?? options.existing ?? options.frozenProfile ?? null;
  }

  const normalizedCandidate = normalizeReasoningProfile(candidate);
  const normalizedPrevious = previous == null ? null : normalizeReasoningProfile(previous);

  if (!normalizedPrevious && normalizedCandidate.frozenAtRevision !== null) {
    return deepFreeze(clone(normalizedCandidate));
  }

  if (normalizedPrevious
    && normalizedPrevious.frozenAtRevision !== null
    && normalizedPrevious.taskId
    && normalizedPrevious.taskId === normalizedCandidate.taskId
    && profileSignature(normalizedPrevious) !== profileSignature(normalizedCandidate)) {
    if (options.onDrift === "ignore") return deepFreeze(clone(normalizedPrevious));
    throw new Error(`Reasoning Profile drift is not allowed for frozen task ${normalizedPrevious.taskId}.`);
  }

  if (normalizedPrevious
    && normalizedPrevious.frozenAtRevision !== null
    && normalizedPrevious.taskId === normalizedCandidate.taskId
    && profileSignature(normalizedPrevious) === profileSignature(normalizedCandidate)) {
    return deepFreeze(clone(normalizedPrevious));
  }

  const frozenAtRevision = revision(
    options.revision ?? options.frozenAtRevision ?? normalizedCandidate.frozenAtRevision,
    0,
  );
  return deepFreeze({ ...normalizedCandidate, frozenAtRevision });
}

function flattenText(value, result = []) {
  if (typeof value === "string") result.push(value.toLowerCase());
  else if (Array.isArray(value)) {
    for (const item of value) flattenText(item, result);
  } else if (isObject(value)) {
    for (const key of Object.keys(value).sort()) {
      result.push(key.toLowerCase());
      flattenText(value[key], result);
    }
  }
  return result;
}

function highRiskTask(input, memory) {
  const task = isObject(input.task) ? input.task : {};
  const goal = isObject(input.goal) ? input.goal : {};
  const memoryTask = isObject(memory?.task) ? memory.task : {};
  const explicitRisk = [task.risk, goal.risk, input.risk, memoryTask.risk]
    .some((value) => ["high", "critical", "severe"].includes(text(value)?.toLowerCase()));
  if (explicitRisk) return true;
  const material = [
    task.risk,
    task.risks,
    task.constraints,
    task.objective,
    goal.risk,
    goal.risks,
    goal.constraints,
    goal.objective,
    input.risk,
    input.risks,
    input.constraints,
    memoryTask.risk,
    memoryTask.risks,
    memoryTask.constraints,
    memoryTask.objective,
  ];
  const words = flattenText(material).join(" ");
  return /\b(?:high|critical|severe)[-_ ]?risk\b|\bsecurity\b|\bauth(?:entication|orization)?\b|\barchitecture\b|\bapi[-_ ]?(?:compatibility|compatible|contract|break(?:ing)?)\b|\bbackward[-_ ]compatib|\bpublic[-_ ]api\b|\bbreaking[-_ ]change\b|高风险|安全|架构|接口兼容/u.test(words);
}

function failedValidation(value) {
  if (!isObject(value)) return false;
  if (value.passed === false || value.success === false) return true;
  const status = text(value.status)?.toLowerCase();
  return ["failed", "failure", "error", "rejected"].includes(status);
}

function fastValidatorFailed(input, memory, state) {
  if (input.fastValidatorFailed === false || input.fastValidationFailed === false) return false;
  if (input.fastValidatorFailed === true || input.fastValidationFailed === true) return true;
  const previousMode = text(
    input.previousValidatorMode
      ?? input.previous_validator_mode
      ?? state.validatorMode,
  )?.toLowerCase();
  const candidates = [
    input.validation,
    input.validatorResult,
    memory?.failure?.currentError,
    Array.isArray(memory?.artifact?.validationReports) ? memory.artifact.validationReports.at(-1) : null,
  ];
  return candidates.some((candidate) => {
    if (!isObject(candidate)) return false;
    const mode = text(candidate.validatorMode ?? candidate.validator_mode ?? candidate.mode)?.toLowerCase();
    const type = text(candidate.type)?.toLowerCase() ?? "";
    const message = text(candidate.message ?? candidate.reason)?.toLowerCase() ?? "";
    const sourceRole = text(candidate.sourceRole ?? candidate.source_role ?? candidate.role)?.toLowerCase();
    const currentError = candidate === memory?.failure?.currentError;
    const explicitFast = mode === "fast"
      || (currentError && previousMode === "fast")
      || /(?:^|[-_ ])fast(?:$|[-_ ])/.test(`${type} ${message}`)
      || (currentError && mode !== "deep" && (sourceRole === "validator" || /validation/.test(type)));
    return explicitFast && (currentError || failedValidation(candidate));
  });
}

function normalizedState(value) {
  const source = isObject(value) ? value : {};
  return {
    phase: text(source.phase)?.toLowerCase() ?? "idle",
    stage: text(source.stage)?.toLowerCase() ?? "idle",
    taskId: text(source.taskId ?? source.task_id),
    lunaValidationFailures: Number.isInteger(source.lunaValidationFailures)
      ? Math.max(0, Math.min(2, source.lunaValidationFailures))
      : 0,
    solAttempted: source.solAttempted === true,
    latestFailureSnapshotId: text(source.latestFailureSnapshotId ?? source.latest_failure_snapshot_id),
    validatorMode: text(source.validatorMode ?? source.validator_mode)?.toLowerCase() ?? null,
  };
}

function selectProfile(input, state, memory) {
  const supplied = normalizeReasoningProfile(input.reasoningProfile ?? input.profile ?? {});
  const task = isObject(input.task) ? input.task : {};
  const taskId = text(input.taskId ?? task.taskId ?? state.taskId ?? memory?.runtime?.taskId) ?? supplied.taskId;
  const requestedComplexity = complexity(input.complexity ?? task.complexity ?? supplied.complexity);

  if (supplied.frozenAtRevision !== null && supplied.taskId && supplied.taskId === taskId) {
    return { profile: supplied, requestedComplexity, sameFrozenTask: true };
  }

  const newTaskFromFrozenProfile = supplied.frozenAtRevision !== null
    && supplied.taskId
    && supplied.taskId !== taskId;
  return {
    profile: normalizeReasoningProfile({
      ...(newTaskFromFrozenProfile ? {} : supplied),
      taskId,
      complexity: requestedComplexity,
      frozenAtRevision: null,
    }),
    requestedComplexity,
    sameFrozenTask: false,
  };
}

function requestedThinking(input, role, validatorMode) {
  if (typeof input.thinking === "string") return text(input.thinking)?.toLowerCase();
  if (!isObject(input.thinking)) return null;
  const value = role === "validator"
    ? input.thinking[validatorMode] ?? input.thinking.validator?.[validatorMode]
    : input.thinking[role];
  return text(typeof value === "string" ? value : value?.thinking)?.toLowerCase();
}

function projectionFor(profile, role, validatorMode) {
  if (!role) return null;
  const selected = role === "validator" ? profile.roles.validator[validatorMode] : profile.roles[role];
  return {
    version: profile.version,
    taskId: profile.taskId,
    complexity: profile.complexity,
    role,
    validatorMode: role === "validator" ? validatorMode : null,
    thinking: selected.thinking,
    frozenAtRevision: profile.frozenAtRevision,
  };
}

function decision(profile, nextAction, role, reasonCode, reason, validatorMode = null) {
  return {
    allowed: true,
    nextAction,
    role,
    reasonCode,
    reason,
    validatorMode,
    projection: projectionFor(profile, role, validatorMode),
    budgetRole: role,
  };
}

function recommendedDecision(input, state, memory, profile) {
  const terminalPassed = ["passed", "complete", "completed", "success"].includes(state.phase)
    || ["passed", "complete", "completed"].includes(state.stage);
  if (terminalPassed) {
    return decision(profile, "complete", null, "TASK_COMPLETE", "The task is already in a successful terminal state.");
  }
  if (state.phase === "escalated" || state.stage === "escalated") {
    return decision(profile, "escalate", null, "TASK_ESCALATED", "The task is in the escalated terminal state.");
  }

  if (state.stage === "validating") {
    if (state.validatorMode === "deep" || input.validatorMode === "deep" || input.validator_mode === "deep") {
      return decision(profile, "run_validator", "validator", "VALIDATOR_DEEP_CONTINUE", "Continue the deep Validator stage.", "deep");
    }
    if (fastValidatorFailed(input, memory, state)) {
      return decision(profile, "run_validator", "validator", "VALIDATOR_DEEP_AFTER_FAST_FAILURE", "Fast validation failed; run the deep Validator.", "deep");
    }
    if (highRiskTask(input, memory)) {
      return decision(profile, "run_validator", "validator", "VALIDATOR_DEEP_REQUIRED", "Task risk or compatibility constraints require deep validation.", "deep");
    }
    return decision(profile, "run_validator", "validator", "VALIDATOR_FAST_DEFAULT", "Run the default fast Validator.", "fast");
  }

  const hasSnapshot = Boolean(state.latestFailureSnapshotId ?? memory?.failure?.currentSnapshotId);
  if (state.lunaValidationFailures >= 2) {
    if (!hasSnapshot) {
      return decision(profile, "wait", null, "FAILURE_SNAPSHOT_REQUIRED", "Sol Recovery requires the latest Failure Snapshot.");
    }
    if (state.solAttempted && state.phase !== "sol-recovery") {
      return decision(profile, "escalate", null, "SOL_ALREADY_ATTEMPTED", "The one allowed Sol Recovery has already been attempted.");
    }
    return decision(profile, "run_sol", "sol", "SOL_RECOVERY_REQUIRED", "Two Luna validation failures require one Sol Recovery using the latest snapshot.");
  }

  if (state.stage === "planning" || state.stage === "failure_snapshot") {
    const retry = state.lunaValidationFailures > 0;
    return decision(
      profile,
      "run_luna",
      "luna",
      retry ? "LUNA_RETRY" : "LUNA_INITIAL",
      retry ? "Retry Luna with the latest failure context." : "Run the initial Luna implementation attempt.",
    );
  }

  if (state.phase === "sol-recovery" && state.stage === "recovery") {
    return decision(profile, "run_sol", "sol", "SOL_RECOVERY_IN_PROGRESS", "Run the fixed-high Sol Recovery attempt.");
  }
  if (state.stage === "executing") {
    return decision(profile, "wait", null, "EXECUTION_IN_PROGRESS", "Worker execution is already in progress.");
  }
  if (state.phase === "open" && hasSnapshot) {
    return decision(profile, "run_sol", "sol", "SOL_RECOVERY_REQUIRED", "The Luna circuit is open; run Sol Recovery.");
  }
  return decision(profile, "wait", null, "NO_EXECUTABLE_ACTION", "No executable action is available from the current state.");
}

function normalizeAction(value) {
  const action = text(value)?.toLowerCase();
  const aliases = { luna: "run_luna", validator: "run_validator", sol: "run_sol", passed: "complete", escalated: "escalate" };
  const normalized = aliases[action] ?? action;
  return Object.hasOwn(ACTION_ROLES, normalized) ? normalized : null;
}

function normalizeRole(value) {
  const role = text(value)?.toLowerCase();
  const aliases = { "luna-worker": "luna", "validator-worker": "validator", "sol-worker": "sol", recovery: "sol" };
  const normalized = aliases[role] ?? role;
  return ["planner", "luna", "validator", "sol"].includes(normalized) ? normalized : null;
}

/**
 * Pure deterministic policy evaluation. The function never mutates its input.
 */
export function evaluateExecutionPolicy(value = {}, options = {}) {
  const source = isObject(value) ? value : {};
  const directState = "phase" in source || "stage" in source;
  const input = directState
    ? { ...(isObject(options) ? options : {}), state: source }
    : source;
  const memory = isObject(input.memory ?? input.taskMemory) ? (input.memory ?? input.taskMemory) : {};
  const state = normalizedState(input.state ?? input.routerState);
  const selected = selectProfile(input, state, memory);
  const profile = selected.profile;

  if (selected.sameFrozenTask && selected.requestedComplexity !== profile.complexity) {
    const denied = decision(profile, "wait", null, "REASONING_PROFILE_DRIFT", "Complexity cannot drift after the task Reasoning Profile is frozen.");
    denied.allowed = false;
    return denied;
  }

  const recommended = recommendedDecision(input, state, memory, profile);
  const explicitActionSupplied = input.action !== undefined && input.action !== null && input.action !== "";
  const explicitRoleSupplied = input.role !== undefined && input.role !== null && input.role !== "";
  const explicitModeSupplied = input.validatorMode !== undefined || input.validator_mode !== undefined;
  const requestedAction = explicitActionSupplied ? normalizeAction(input.action) : null;
  const requestedRole = explicitRoleSupplied ? normalizeRole(input.role) : null;
  const requestedMode = explicitModeSupplied
    ? text(input.validatorMode ?? input.validator_mode)?.toLowerCase()
    : null;

  const thinkingRole = requestedRole ?? recommended.role;
  const thinkingMode = requestedMode ?? recommended.validatorMode;
  const expectedThinking = thinkingRole
    ? projectionFor(profile, thinkingRole, thinkingRole === "validator" ? (thinkingMode ?? "fast") : null)?.thinking
    : null;
  const askedThinking = requestedThinking(input, thinkingRole, thinkingMode);
  if (selected.sameFrozenTask && askedThinking && askedThinking !== expectedThinking) {
    return {
      ...recommended,
      allowed: false,
      reasonCode: "REASONING_PROFILE_DRIFT",
      reason: "Thinking cannot drift after the task Reasoning Profile is frozen.",
    };
  }

  const invalidExplicit = (explicitActionSupplied && requestedAction === null)
    || (explicitRoleSupplied && requestedRole === null)
    || (explicitModeSupplied && !VALIDATOR_MODES.includes(requestedMode));
  const roleExpectedByAction = requestedAction ? ACTION_ROLES[requestedAction] : requestedRole;
  const authorized = !invalidExplicit
    && (!explicitActionSupplied || requestedAction === recommended.nextAction)
    && (!explicitRoleSupplied || requestedRole === recommended.role)
    && (!explicitActionSupplied || !explicitRoleSupplied || roleExpectedByAction === requestedRole)
    && (!explicitModeSupplied || (recommended.role === "validator" && requestedMode === recommended.validatorMode));

  if (explicitActionSupplied || explicitRoleSupplied || explicitModeSupplied) {
    if (!authorized) {
      return {
        ...recommended,
        allowed: false,
        reasonCode: invalidExplicit ? "INVALID_EXPLICIT_REQUEST" : "ACTION_NOT_AUTHORIZED",
        reason: invalidExplicit
          ? "The explicit action, role, or Validator mode is invalid."
          : `The explicit request is not authorized; the policy requires ${recommended.nextAction}${recommended.validatorMode ? ` (${recommended.validatorMode})` : ""}.`,
      };
    }
    return {
      ...recommended,
      reasonCode: "ACTION_AUTHORIZED",
      reason: `The explicit request matches the required ${recommended.nextAction}${recommended.validatorMode ? ` (${recommended.validatorMode})` : ""} policy action.`,
    };
  }

  return clone(recommended);
}
