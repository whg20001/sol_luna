export const PACKAGE_NAME = "pi-sol-luna-router";
export const PACKAGE_VERSION = "0.1.0";
export const MANAGED_MARKER = "pi-sol-luna-router:managed:v1";
export const STATE_ENTRY_TYPE = "pi-sol-luna-router/state";

export const AGENT_NAMES = Object.freeze(["luna-worker", "sol-worker"]);
export const MANAGED_SUBAGENT_VALUES = Object.freeze({
  disableDefaultAgents: true,
  fallbackSubagent: "none",
  strictAgentFiles: true,
});

const PHASES = new Set(["idle", "luna", "open", "sol-recovery", "passed", "escalated"]);

export function initialState() {
  return {
    taskLabel: null,
    taskId: null,
    phase: "idle",
    lunaValidationFailures: 0,
    solAttempted: false,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  const failures = Number.isInteger(source.lunaValidationFailures)
    ? Math.max(0, Math.min(2, source.lunaValidationFailures))
    : 0;
  let phase = PHASES.has(source.phase) ? source.phase : "idle";
  let solAttempted = source.solAttempted === true;

  const phaseForFailures = () => (failures >= 2 ? "open" : failures > 0 ? "luna" : "idle");

  // Persisted state can predate the circuit's stricter transitions. Repair it to
  // the nearest state that could have been produced by a legal transition.
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
    } else if (solAttempted) {
      phase = "sol-recovery";
    }
  }
  if (phase === "sol-recovery") {
    if (failures < 2) {
      phase = phaseForFailures();
      solAttempted = false;
    } else if (!solAttempted) {
      phase = "open";
    }
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

  return {
    taskLabel: nonEmptyString(source.taskLabel),
    taskId: nonEmptyString(source.taskId),
    phase,
    lunaValidationFailures: failures,
    solAttempted,
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
        phase: "luna",
        lunaValidationFailures: 0,
        solAttempted: false,
      });
    case "luna_failed": {
      requireReason(payload);
      if (state.phase !== "luna") {
        throw new Error(`Cannot record a Luna failure from phase ${state.phase}.`);
      }
      const failures = Math.min(2, state.lunaValidationFailures + 1);
      return { ...state, lunaValidationFailures: failures, phase: failures >= 2 ? "open" : "luna" };
    }
    case "passed":
      if (state.phase !== "luna" && state.phase !== "sol-recovery") {
        throw new Error(`Cannot mark a task passed from phase ${state.phase}.`);
      }
      return { ...state, phase: "passed" };
    case "sol_failed":
      requireReason(payload);
      if (state.phase !== "sol-recovery" || state.lunaValidationFailures !== 2 || !state.solAttempted) {
        throw new Error("Sol Recovery can be marked failed only after its one allowed attempt has started.");
      }
      return { ...state, phase: "escalated" };
    case "sol_started":
      if (state.lunaValidationFailures < 2 || state.phase !== "open") {
        throw new Error("Sol Recovery is allowed only after two Luna validation failures.");
      }
      if (state.solAttempted) throw new Error("Sol Recovery has already been attempted.");
      return { ...state, phase: "sol-recovery", solAttempted: true };
    case "status":
      return { ...state };
    default:
      throw new Error(`Unknown gate action: ${String(action)}`);
  }
}

export function canInvokeAgent(previous, agentType, { resume = false } = {}) {
  const state = normalizeState(previous);
  const type = typeof agentType === "string" ? agentType.trim().toLowerCase() : "";
  if (type === "luna-worker" && state.lunaValidationFailures >= 2) {
    return { allowed: false, reason: "Luna is blocked after two failed validation attempts; use a new sol-worker recovery call." };
  }
  if (type === "sol-worker") {
    if (resume) {
      return { allowed: false, reason: "Sol Recovery must be a new sol-worker call; do not resume or hot-switch an existing session." };
    }
    if (state.lunaValidationFailures < 2 || state.phase !== "open") {
      return { allowed: false, reason: "Sol Recovery is blocked until Luna has failed validation twice." };
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
  return availableModels.some(
    (entry) => entry?.provider === provider && entry?.id === model,
  );
}

export function findSubagentsConflicts(existing) {
  if (!isPlainObject(existing)) throw new Error("subagents.json must contain a JSON object.");
  return Object.keys(MANAGED_SUBAGENT_VALUES).filter(
    (key) => Object.prototype.hasOwnProperty.call(existing, key) && existing[key] !== MANAGED_SUBAGENT_VALUES[key],
  );
}

export function mergeSubagents(existing, { force = false } = {}) {
  const conflicts = findSubagentsConflicts(existing);
  if (conflicts.length > 0 && !force) {
    return { ok: false, conflicts, value: { ...existing } };
  }
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
  if (typeof recordedHash === "string" && recordedHash && currentHash === recordedHash) {
    return { action: "upgrade" };
  }
  if (force) return { action: "overwrite" };
  return { action: "conflict" };
}

export function hasManagedMarker(content) {
  return typeof content === "string" && content.includes(`<!-- ${MANAGED_MARKER} -->`);
}

export function isMaterialized({ markerExists, lunaExists, solExists }) {
  return markerExists === true && lunaExists === true && solExists === true;
}

export function formatState(state) {
  const normalized = normalizeState(state);
  return `task=${normalized.taskId ?? "(none)"} label=${normalized.taskLabel ?? "(none)"} phase=${normalized.phase} lunaValidationFailures=${normalized.lunaValidationFailures} solAttempted=${normalized.solAttempted}`;
}
