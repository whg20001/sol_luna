import {
  canInvokeAgent,
  initialState,
  normalizeState,
  transitionState,
} from "./core.js";

export const ROUTER_STATE_VERSION = 1;

export const ROUTER_ROLES = Object.freeze({
  LUNA: "luna",
  SOL: "sol",
});

const ROLE_TO_AGENT = Object.freeze({
  [ROUTER_ROLES.LUNA]: "luna-worker",
  [ROUTER_ROLES.SOL]: "sol-worker",
});

function copyState(state) {
  return { ...normalizeState(state) };
}

function statesEqual(left, right) {
  return JSON.stringify(normalizeState(left)) === JSON.stringify(normalizeState(right));
}

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(ROLE_TO_AGENT, normalized)) {
    throw new Error(`Unknown router worker role: ${String(role)}`);
  }
  return normalized;
}

/**
 * Create the host-independent stateful facade around the pure routing rules.
 * Persistence and worker execution are intentionally supplied by adapters.
 */
export function createRouterService({ snapshot, taskIdFactory = () => null } = {}) {
  if (typeof taskIdFactory !== "function") {
    throw new TypeError("taskIdFactory must be a function.");
  }

  let state = initialState();

  function getState() {
    return copyState(state);
  }

  function restore(snapshotOrState) {
    const source = snapshotOrState && typeof snapshotOrState === "object"
      && Object.prototype.hasOwnProperty.call(snapshotOrState, "state")
      ? snapshotOrState.state
      : snapshotOrState;
    state = normalizeState(source);
    return getState();
  }

  if (snapshot !== undefined) restore(snapshot);

  function currentSnapshot() {
    return {
      version: ROUTER_STATE_VERSION,
      state: getState(),
    };
  }

  function gate(action, payload = {}) {
    const previousState = getState();
    if (action === "status") {
      return {
        changed: false,
        previousState,
        state: getState(),
      };
    }

    const transitionPayload = action === "start_task"
      ? {
          ...payload,
          taskId: payload.taskId ?? taskIdFactory(),
        }
      : payload;
    state = transitionState(state, action, transitionPayload);
    return {
      changed: !statesEqual(previousState, state),
      previousState,
      state: getState(),
    };
  }

  function prepareAgentCall({ agentType, resume = false } = {}) {
    const normalizedAgentType = typeof agentType === "string" ? agentType.trim().toLowerCase() : "";
    const previousState = getState();
    const verdict = canInvokeAgent(state, normalizedAgentType, { resume: Boolean(resume) });
    if (!verdict.allowed) {
      return {
        allowed: false,
        reason: verdict.reason,
        changed: false,
        previousState,
        state: getState(),
      };
    }

    if (normalizedAgentType === ROLE_TO_AGENT[ROUTER_ROLES.SOL]) {
      state = transitionState(state, "sol_started");
    }

    return {
      allowed: true,
      changed: !statesEqual(previousState, state),
      previousState,
      state: getState(),
    };
  }

  function prepareWorkerCall({ role, resume = false } = {}) {
    const normalizedRole = normalizeRole(role);
    return prepareAgentCall({
      agentType: ROLE_TO_AGENT[normalizedRole],
      resume,
    });
  }

  function reset() {
    const previousState = getState();
    state = initialState();
    return {
      changed: !statesEqual(previousState, state),
      previousState,
      state: getState(),
    };
  }

  return Object.freeze({
    getState,
    snapshot: currentSnapshot,
    restore,
    gate,
    prepareAgentCall,
    prepareWorkerCall,
    reset,
  });
}
