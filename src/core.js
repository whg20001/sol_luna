export const PACKAGE_NAME = "pi-sol-luna-router";
export const PACKAGE_VERSION = "2.1.0";
export const MANAGED_MARKER = "pi-sol-luna-router:managed:v2";
export const LEGACY_MANAGED_MARKER = "pi-sol-luna-router:managed:v1";
export const STATE_ENTRY_TYPE = "pi-sol-luna-router/state";

export const AGENT_NAMES = Object.freeze(["luna-worker", "sol-worker", "validator-worker"]);
export const LEGACY_AGENT_NAMES = Object.freeze(["luna-worker", "sol-worker"]);
export const MANAGED_SUBAGENT_VALUES = Object.freeze({
  disableDefaultAgents: true,
  fallbackSubagent: "none",
  strictAgentFiles: true,
});

const PHASES = new Set(["idle", "luna", "open", "sol-recovery", "passed", "escalated"]);
const STAGES = new Set([
  "idle",
  "planning",
  "executing",
  "validating",
  "failure_snapshot",
  "recovery",
  "passed",
  "escalated",
]);

export function initialState() {
  return {
    protocol: "2.0",
    taskLabel: null,
    taskId: null,
    contextId: null,
    phase: "idle",
    stage: "idle",
    activeRole: null,
    lunaValidationFailures: 0,
    solAttempted: false,
    attempts: { luna: 0, validator: 0, sol: 0 },
    latestFailureSnapshotId: null,
    reasoningProfile: null,
    validatorMode: null,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAttempts(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    luna: Number.isInteger(source.luna) ? Math.max(0, source.luna) : 0,
    validator: Number.isInteger(source.validator) ? Math.max(0, source.validator) : 0,
    sol: Number.isInteger(source.sol) ? Math.max(0, Math.min(1, source.sol)) : 0,
  };
}

function inferredStage(phase, failures, solAttempted) {
  if (phase === "idle") return "idle";
  if (phase === "luna") return failures > 0 ? "failure_snapshot" : "planning";
  if (phase === "open") return "failure_snapshot";
  if (phase === "sol-recovery") return solAttempted ? "recovery" : "failure_snapshot";
  return phase;
}

function normalizeActiveRole(value, stage) {
  const role = nonEmptyString(value)?.toLowerCase();
  if (["planner", "luna", "validator", "sol"].includes(role)) return role;
  if (stage === "planning") return "planner";
  if (stage === "executing") return "luna";
  if (stage === "recovery") return "sol";
  if (stage === "validating") return "validator";
  return null;
}

export function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const failures = Number.isInteger(source.lunaValidationFailures)
    ? Math.max(0, Math.min(2, source.lunaValidationFailures))
    : 0;
  let phase = PHASES.has(source.phase) ? source.phase : "idle";
  let solAttempted = source.solAttempted === true;

  const phaseForFailures = () => (failures >= 2 ? "open" : failures > 0 ? "luna" : "idle");

  // Repair old or partially persisted circuit state to the nearest legal state.
  if (phase === "idle") {
    if (solAttempted && failures >= 2) phase = "sol-recovery";
    else {
      phase = phaseForFailures();
      if (failures < 2) solAttempted = false;
    }
  }
  if (phase === "luna") {
    if (failures >= 2) phase = solAttempted ? "sol-recovery" : "open";
    else if (solAttempted) solAttempted = false;
  }
  if (phase === "open") {
    if (failures < 2) {
      phase = phaseForFailures();
      solAttempted = false;
    } else if (solAttempted) phase = "sol-recovery";
  }
  if (phase === "sol-recovery") {
    if (failures < 2) {
      phase = phaseForFailures();
      solAttempted = false;
    } else if (!solAttempted) phase = "open";
  }
  if (phase === "passed") {
    if (failures >= 2 && !solAttempted) phase = "open";
    else if (failures < 2 && solAttempted) {
      phase = phaseForFailures();
      solAttempted = false;
    }
  }
  if (phase === "escalated" && (failures < 2 || !solAttempted)) {
    phase = phaseForFailures();
    solAttempted = false;
  }

  let stage = STAGES.has(source.stage)
    ? source.stage
    : inferredStage(phase, failures, solAttempted);
  if (phase === "idle") stage = "idle";
  if (phase === "open" && !["failure_snapshot"].includes(stage)) stage = "failure_snapshot";
  if (phase === "sol-recovery" && !["recovery", "validating"].includes(stage)) stage = "recovery";
  if (phase === "passed") stage = "passed";
  if (phase === "escalated") stage = "escalated";
  if (phase === "luna" && ["idle", "recovery", "passed", "escalated"].includes(stage)) {
    stage = failures > 0 ? "failure_snapshot" : "planning";
  }

  const attempts = normalizeAttempts(source.attempts);
  if (solAttempted) attempts.sol = 1;

  return {
    protocol: "2.0",
    taskLabel: nonEmptyString(source.taskLabel),
    taskId: nonEmptyString(source.taskId),
    contextId: nonEmptyString(source.contextId),
    phase,
    stage,
    activeRole: normalizeActiveRole(source.activeRole, stage),
    lunaValidationFailures: failures,
    solAttempted,
    attempts,
    latestFailureSnapshotId: nonEmptyString(source.latestFailureSnapshotId),
    reasoningProfile: isPlainObject(source.reasoningProfile) ? structuredClone(source.reasoningProfile) : null,
    validatorMode: ["fast", "deep"].includes(source.validatorMode) ? source.validatorMode : null,
  };
}

function requireReason(payload) {
  const reason = nonEmptyString(payload?.reason);
  if (!reason) throw new Error("A reason is required for this failure action.");
  return reason;
}

export function transitionState(previous, action, payload = {}) {
  const state = normalizeState(previous);
  switch (action) {
    case "start_task":
      return normalizeState({
        taskLabel: payload.taskLabel,
        taskId: payload.taskId,
        contextId: payload.contextId,
        phase: "luna",
        stage: "planning",
        activeRole: "planner",
        lunaValidationFailures: 0,
        solAttempted: false,
        attempts: { luna: 0, validator: 0, sol: 0 },
        latestFailureSnapshotId: null,
        reasoningProfile: payload.reasoningProfile,
        validatorMode: null,
      });
    case "plan_ready":
      if (state.phase !== "luna" || state.stage !== "planning") {
        throw new Error(`Cannot finish planning from phase ${state.phase} stage ${state.stage}.`);
      }
      return { ...state, activeRole: null };
    case "worker_started": {
      const role = nonEmptyString(payload.role)?.toLowerCase();
      if (role === "luna") {
        if (state.phase !== "luna" || state.lunaValidationFailures >= 2) {
          throw new Error(`Cannot start Luna from phase ${state.phase}.`);
        }
        return {
          ...state,
          stage: "executing",
          activeRole: "luna",
          attempts: { ...state.attempts, luna: state.attempts.luna + 1 },
        };
      }
      if (role === "validator") {
        if (state.stage !== "validating") throw new Error(`Cannot start Validator from stage ${state.stage}.`);
        return {
          ...state,
          activeRole: "validator",
          attempts: { ...state.attempts, validator: state.attempts.validator + 1 },
          validatorMode: ["fast", "deep"].includes(payload.validatorMode) ? payload.validatorMode : state.validatorMode ?? "fast",
        };
      }
      if (role === "sol") return transitionState(state, "sol_started", payload);
      throw new Error(`Unknown worker role: ${String(payload.role)}`);
    }
    case "worker_completed": {
      const role = nonEmptyString(payload.role)?.toLowerCase();
      if (role === "luna" && state.phase === "luna" && state.stage === "executing") {
        return { ...state, stage: "validating", activeRole: "validator", validatorMode: null };
      }
      if (role === "sol" && state.phase === "sol-recovery" && state.stage === "recovery") {
        return { ...state, stage: "validating", activeRole: "validator", validatorMode: null };
      }
      if (role === "validator" && state.stage === "validating") return { ...state };
      throw new Error(`Cannot complete ${role ?? "worker"} from phase ${state.phase} stage ${state.stage}.`);
    }
    case "validation_started":
      if (state.phase !== "luna" && state.phase !== "sol-recovery") {
        throw new Error(`Cannot start validation from phase ${state.phase}.`);
      }
      return { ...state, stage: "validating", activeRole: "validator", validatorMode: payload.validatorMode ?? state.validatorMode ?? "fast" };
    case "luna_failed":
    case "validation_failed": {
      requireReason(payload);
      const sourceRole = nonEmptyString(payload.sourceRole)?.toLowerCase();
      if (state.phase === "sol-recovery" || sourceRole === "sol") {
        if (state.phase !== "sol-recovery" || !state.solAttempted) {
          throw new Error("Sol Recovery can be marked failed only after its one allowed attempt has started.");
        }
        return { ...state, phase: "escalated", stage: "escalated", activeRole: null };
      }
      if (state.phase !== "luna") {
        throw new Error(`Cannot record a Luna failure from phase ${state.phase}.`);
      }
      const failures = Math.min(2, state.lunaValidationFailures + 1);
      return {
        ...state,
        lunaValidationFailures: failures,
        phase: failures >= 2 ? "open" : "luna",
        stage: "failure_snapshot",
        activeRole: null,
        latestFailureSnapshotId: nonEmptyString(payload.snapshotId) ?? state.latestFailureSnapshotId,
      };
    }
    case "passed":
    case "validation_passed":
      if (state.phase !== "luna" && state.phase !== "sol-recovery") {
        throw new Error(`Cannot mark a task passed from phase ${state.phase}.`);
      }
      return { ...state, phase: "passed", stage: "passed", activeRole: null, validatorMode: null };
    case "sol_failed":
      requireReason(payload);
      if (state.phase !== "sol-recovery" || state.lunaValidationFailures !== 2 || !state.solAttempted) {
        throw new Error("Sol Recovery can be marked failed only after its one allowed attempt has started.");
      }
      return { ...state, phase: "escalated", stage: "escalated", activeRole: null };
    case "sol_started":
      if (state.lunaValidationFailures < 2 || state.phase !== "open") {
        throw new Error("Sol Recovery is allowed only after two Luna validation failures.");
      }
      if (state.solAttempted) throw new Error("Sol Recovery has already been attempted.");
      return {
        ...state,
        phase: "sol-recovery",
        stage: "recovery",
        activeRole: "sol",
        solAttempted: true,
        attempts: { ...state.attempts, sol: 1 },
      };
    case "status":
      return { ...state, attempts: { ...state.attempts } };
    default:
      throw new Error(`Unknown gate action: ${String(action)}`);
  }
}

export function canInvokeAgent(previous, agentType, { resume = false } = {}) {
  const state = normalizeState(previous);
  const type = typeof agentType === "string" ? agentType.trim().toLowerCase() : "";
  if (type === "luna-worker") {
    if (resume) return { allowed: false, reason: "Luna must be launched as a new cache-friendly worker call; resume is not supported." };
    if (state.lunaValidationFailures >= 2) {
      return { allowed: false, reason: "Luna is blocked after two failed validation attempts; use a new sol-worker recovery call." };
    }
    if (state.phase !== "luna") return { allowed: false, reason: `Luna is not available from phase ${state.phase}.` };
    if (!["planning", "failure_snapshot"].includes(state.stage)) {
      return { allowed: false, reason: `Luna can start only from planning or failure_snapshot, not ${state.stage}.` };
    }
  }
  if (type === "validator-worker") {
    if (resume) return { allowed: false, reason: "Validator must be a new read-only call; resume is not supported." };
    if (state.stage !== "validating") {
      return { allowed: false, reason: `Validator is allowed only during the validating stage, not ${state.stage}.` };
    }
  }
  if (type === "sol-worker") {
    if (resume) {
      return { allowed: false, reason: "Sol Recovery must be a new sol-worker call; do not resume or hot-switch an existing session." };
    }
    if (state.lunaValidationFailures < 2 || state.phase !== "open") {
      return { allowed: false, reason: "Sol Recovery is blocked until Luna has failed validation twice." };
    }
    if (state.contextId && !state.latestFailureSnapshotId) {
      return { allowed: false, reason: "Sol Recovery requires the latest Failure Snapshot from the current task." };
    }
    if (state.solAttempted) {
      return { allowed: false, reason: "Sol Recovery has already been attempted. The circuit is escalated; ask the user what to do next." };
    }
  }
  if (resume && state.lunaValidationFailures >= 2) {
    return { allowed: false, reason: "Agent resume is blocked after the Luna circuit opens; start the one allowed sol-worker recovery instead." };
  }
  return { allowed: true };
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactAvailableModel(availableModels, { provider, model }) {
  if (!Array.isArray(availableModels)) return false;
  return availableModels.some((entry) => entry?.provider === provider && entry?.id === model);
}

export function findSubagentsConflicts(existing) {
  if (!isPlainObject(existing)) throw new Error("subagents.json must contain a JSON object.");
  return Object.keys(MANAGED_SUBAGENT_VALUES).filter(
    (key) => Object.prototype.hasOwnProperty.call(existing, key) && existing[key] !== MANAGED_SUBAGENT_VALUES[key],
  );
}

export function mergeSubagents(existing, { force = false } = {}) {
  const conflicts = findSubagentsConflicts(existing);
  if (conflicts.length > 0 && !force) return { ok: false, conflicts, value: { ...existing } };
  return { ok: true, conflicts, value: { ...existing, ...MANAGED_SUBAGENT_VALUES } };
}

export function removeManagedSubagents(existing) {
  if (!isPlainObject(existing)) throw new Error("subagents.json must contain a JSON object.");
  const value = { ...existing };
  for (const [key, expected] of Object.entries(MANAGED_SUBAGENT_VALUES)) {
    if (value[key] === expected) delete value[key];
  }
  return value;
}

export function managedFileDecision(
  current,
  desired,
  { force = false, currentHash, managedHash, markerHash, previousHash } = {},
) {
  if (current === undefined) return { action: "create" };
  if (current === desired) return { action: "skip" };
  const recordedHash = managedHash ?? markerHash ?? previousHash;
  if (typeof recordedHash === "string" && recordedHash && currentHash === recordedHash) return { action: "upgrade" };
  if (force) return { action: "overwrite" };
  return { action: "conflict" };
}

export function hasManagedMarker(content) {
  return typeof content === "string"
    && (content.includes(`<!-- ${MANAGED_MARKER} -->`) || content.includes(`<!-- ${LEGACY_MANAGED_MARKER} -->`));
}

export function isMaterialized({ markerExists, lunaExists, solExists, validatorExists = true }) {
  return markerExists === true && lunaExists === true && solExists === true && validatorExists === true;
}

export function formatState(state) {
  const normalized = normalizeState(state);
  return `task=${normalized.taskId ?? "(none)"} context=${normalized.contextId ?? "(none)"} label=${normalized.taskLabel ?? "(none)"} phase=${normalized.phase} stage=${normalized.stage} role=${normalized.activeRole ?? "(none)"} lunaValidationFailures=${normalized.lunaValidationFailures} solAttempted=${normalized.solAttempted} snapshot=${normalized.latestFailureSnapshotId ?? "(none)"}`;
}
