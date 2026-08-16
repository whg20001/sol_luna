import { formatState } from "../core.js";
import { ROUTER_ROLES, createRouterService } from "../router-service.js";

const VALID_ROLES = new Set(Object.values(ROUTER_ROLES));

function normalizeRole(role) {
  const normalized = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!VALID_ROLES.has(normalized)) {
    throw new Error(`Unknown router worker role: ${String(role)}`);
  }
  return normalized;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

export function createHarnessInstructions({ harnessName = "agent harness", state } = {}) {
  return [
    "## Sol-Luna Router Protocol",
    `- The active host is ${harnessName}. Keep planning, coordination, acceptance checks, and user communication in the parent agent.`,
    "- Call gate(\"start_task\", ...) before implementation, then invoke(\"luna\", ...) for the default worker.",
    "- Run the approved acceptance checks after each worker result. Record evidence with gate(\"luna_failed\", ...) when validation fails.",
    "- The first Luna validation failure permits one further Luna attempt. The second opens the circuit and blocks Luna.",
    "- After the circuit opens, invoke exactly one new Sol worker with invoke(\"sol\", ...); never resume or hot-switch Luna.",
    "- Mark successful validation with gate(\"passed\"). If Sol recovery validation fails, call gate(\"sol_failed\", ...) and escalate to the user.",
    "- Enforce parent write restrictions with host permissions or a sandbox rather than relying only on these instructions.",
    `- Current gate state: ${formatState(state)}`,
  ].join("\n");
}

/**
 * Callback-based adapter for agent harnesses. It deliberately makes no
 * assumptions about a vendor SDK, CLI arguments, authentication, or models.
 */
export function createHarnessAdapter({
  harnessName = "agent-harness",
  snapshot,
  taskIdFactory,
  workerBindings,
  invokeWorker,
  saveSnapshot = async () => {},
} = {}) {
  requireFunction(invokeWorker, "invokeWorker");
  requireFunction(saveSnapshot, "saveSnapshot");
  if (!workerBindings || typeof workerBindings !== "object" || Array.isArray(workerBindings)) {
    throw new TypeError("workerBindings must be an object with luna and sol entries.");
  }
  for (const role of VALID_ROLES) {
    if (!Object.prototype.hasOwnProperty.call(workerBindings, role)) {
      throw new TypeError(`workerBindings.${role} is required.`);
    }
  }

  const router = createRouterService({ snapshot, taskIdFactory });
  let transactionTail = Promise.resolve();

  function transact(operation) {
    const result = transactionTail.then(operation, operation);
    transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function persist(update, reason, metadata = {}) {
    if (!update.changed) return;
    try {
      await saveSnapshot(router.snapshot(), {
        ...metadata,
        harnessName,
        reason,
      });
    } catch (error) {
      router.restore(update.previousState);
      throw error;
    }
  }

  async function gate(action, payload = {}) {
    return transact(async () => {
      const update = router.gate(action, payload);
      await persist(update, "gate", { action });
      return {
        ...update,
        snapshot: router.snapshot(),
      };
    });
  }

  async function invoke(role, input, { resume = false, signal, metadata } = {}) {
    const normalizedRole = normalizeRole(role);
    const launch = await transact(async () => {
      const prepared = router.prepareWorkerCall({ role: normalizedRole, resume });
      if (!prepared.allowed) {
        return {
          blocked: true,
          reason: prepared.reason,
          state: prepared.state,
          snapshot: router.snapshot(),
        };
      }

      await persist(prepared, "sol_started", { role: normalizedRole });
      const routerState = router.getState();
      const launchSnapshot = router.snapshot();
      const resultPromise = Promise.resolve(invokeWorker({
        harnessName,
        role: normalizedRole,
        binding: workerBindings[normalizedRole],
        input,
        resume: Boolean(resume),
        signal,
        metadata,
        routerState,
        snapshot: launchSnapshot,
      }));
      return {
        blocked: false,
        resultPromise,
      };
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

    const result = await launch.resultPromise;
    return {
      ok: true,
      blocked: false,
      result,
      state: router.getState(),
      snapshot: router.snapshot(),
    };
  }

  async function reset(metadata = {}) {
    return transact(async () => {
      const update = router.reset();
      await persist(update, "reset", metadata);
      return {
        ...update,
        snapshot: router.snapshot(),
      };
    });
  }

  return Object.freeze({
    harnessName,
    getState: router.getState,
    getSnapshot: router.snapshot,
    getInstructions: () => createHarnessInstructions({ harnessName, state: router.getState() }),
    gate,
    invoke,
    reset,
  });
}

export default createHarnessAdapter;
