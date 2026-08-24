import { isPlainObject } from "./core.js";
import { rankModelCandidates } from "./model-ranking.js";

// Keep these legacy exports stable for version-1 route-file compatibility.
export const MODEL_ROUTE_VERSION = 1;
export const MODEL_ROUTE_ROLES = Object.freeze(["luna", "sol"]);

export const RUNTIME_MODEL_ROUTE_VERSION = 2;
export const RUNTIME_ROUTE_ROLES = Object.freeze(["planner", "luna", "validator", "sol"]);
export const WORKER_ROUTE_ROLES = Object.freeze(["luna", "validator", "sol"]);
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const TASK_COMPLEXITIES = Object.freeze(["low", "medium", "high"]);
export const PLANNER_ROUTE_MODES = Object.freeze(["inherit", "route"]);

const DEFAULT_LUNA_CANDIDATES = Object.freeze([
  Object.freeze({ provider: "cliproxyapi", model: "gpt-5.6-luna" }),
  Object.freeze({ provider: "openai", model: "gpt-5.6-luna" }),
]);
const DEFAULT_SOL_CANDIDATES = Object.freeze([
  Object.freeze({ provider: "cliproxyapi", model: "gpt-5.6-sol" }),
  Object.freeze({ provider: "openai", model: "gpt-5.6-sol" }),
]);

function candidateFrom(value) {
  if (!value || typeof value !== "object") return null;
  const provider = typeof value.provider === "string" ? value.provider.trim() : "";
  const model = typeof (value.model ?? value.id) === "string" ? (value.model ?? value.id).trim() : "";
  return provider && model && !provider.includes("/") ? { provider, model } : null;
}

function compareCandidateReferences(left, right) {
  const leftReference = `${left.provider}/${left.model}`;
  const rightReference = `${right.provider}/${right.model}`;
  return leftReference < rightReference ? -1 : leftReference > rightReference ? 1 : 0;
}

function orderedUniqueCandidates(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const candidate = candidateFrom(value);
    if (!candidate) continue;
    const reference = modelReference(candidate);
    if (!seen.has(reference)) {
      seen.add(reference);
      result.push(candidate);
    }
  }
  return result;
}

export const DEFAULT_MODEL_ROUTES = Object.freeze({
  version: MODEL_ROUTE_VERSION,
  luna: Object.freeze({
    thinking: "medium",
    candidates: DEFAULT_LUNA_CANDIDATES,
  }),
  sol: Object.freeze({
    thinking: "high",
    candidates: DEFAULT_SOL_CANDIDATES,
  }),
});

export const DEFAULT_RUNTIME_MODEL_ROUTES = Object.freeze({
  version: RUNTIME_MODEL_ROUTE_VERSION,
  planner: Object.freeze({ mode: "inherit", thinking: "high" }),
  luna: Object.freeze({ thinking: "medium", candidates: DEFAULT_LUNA_CANDIDATES }),
  validator: Object.freeze({ thinking: "low", candidates: DEFAULT_LUNA_CANDIDATES }),
  sol: Object.freeze({ thinking: "high", candidates: DEFAULT_SOL_CANDIDATES }),
});

const V1_TOP_LEVEL_KEYS = new Set(["version", ...MODEL_ROUTE_ROLES]);
const V2_TOP_LEVEL_KEYS = new Set(["version", ...RUNTIME_ROUTE_ROLES]);
const V1_ROLE_KEYS = new Set(["thinking", "candidates"]);
const WORKER_ROLE_KEYS = new Set(["thinking", "candidates", "thinkingByComplexity", "budgetProfile"]);
const PLANNER_ROLE_KEYS = new Set(["mode", "thinking", "candidates"]);
const CANDIDATE_KEYS = new Set(["provider", "model"]);
const COMPLEXITY_KEYS = new Set(TASK_COMPLEXITIES);

function rejectUnknownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown field(s): ${unknown.join(", ")}.`);
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function normalizeThinking(value, path) {
  const thinking = nonEmptyString(value, path).toLowerCase();
  if (!THINKING_LEVELS.includes(thinking)) {
    throw new Error(`${path} must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return thinking;
}

function normalizeCandidate(value, path) {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, CANDIDATE_KEYS, path);
  const provider = nonEmptyString(value.provider, `${path}.provider`);
  const model = nonEmptyString(value.model, `${path}.model`);
  if (provider.includes("/")) throw new Error(`${path}.provider must not contain '/'.`);
  return { provider, model };
}

function normalizeCandidates(value, path, { required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array.`);
  }
  const candidates = value.map((candidate, index) => normalizeCandidate(candidate, `${path}[${index}]`));
  const seen = new Set();
  for (const candidate of candidates) {
    const key = modelReference(candidate);
    if (seen.has(key)) throw new Error(`${path} contains duplicate model ${key}.`);
    seen.add(key);
  }
  return candidates;
}

function normalizeThinkingByComplexity(value, path) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, COMPLEXITY_KEYS, path);
  const result = {};
  for (const complexity of TASK_COMPLEXITIES) {
    if (value[complexity] !== undefined) {
      result[complexity] = normalizeThinking(value[complexity], `${path}.${complexity}`);
    }
  }
  return result;
}

function normalizeBudgetProfile(value, path) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return nonEmptyString(value, path);
  if (!isPlainObject(value)) throw new Error(`${path} must be a non-empty string or JSON object.`);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`${path} must be JSON serializable.`);
  }
}

function normalizeWorkerRole(value, role, { legacy = false } = {}) {
  const path = `model routes.${role}`;
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, legacy ? V1_ROLE_KEYS : WORKER_ROLE_KEYS, path);
  const result = {
    thinking: normalizeThinking(value.thinking, `${path}.thinking`),
    candidates: normalizeCandidates(value.candidates, `${path}.candidates`),
  };
  if (!legacy) {
    const thinkingByComplexity = normalizeThinkingByComplexity(value.thinkingByComplexity, `${path}.thinkingByComplexity`);
    const budgetProfile = normalizeBudgetProfile(value.budgetProfile, `${path}.budgetProfile`);
    if (thinkingByComplexity !== undefined) result.thinkingByComplexity = thinkingByComplexity;
    if (budgetProfile !== undefined) result.budgetProfile = budgetProfile;
  }
  return result;
}

function normalizePlannerRole(value) {
  const path = "model routes.planner";
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, PLANNER_ROLE_KEYS, path);
  const mode = value.mode === undefined ? "inherit" : nonEmptyString(value.mode, `${path}.mode`).toLowerCase();
  if (!PLANNER_ROUTE_MODES.includes(mode)) {
    throw new Error(`${path}.mode must be one of: ${PLANNER_ROUTE_MODES.join(", ")}.`);
  }
  const candidates = normalizeCandidates(value.candidates, `${path}.candidates`, { required: mode === "route" });
  const result = {
    mode,
    thinking: normalizeThinking(value.thinking, `${path}.thinking`),
  };
  if (candidates !== undefined) result.candidates = candidates;
  return result;
}

function normalizeV1(value) {
  rejectUnknownKeys(value, V1_TOP_LEVEL_KEYS, "model routes");
  return {
    version: MODEL_ROUTE_VERSION,
    luna: normalizeWorkerRole(value.luna, "luna", { legacy: true }),
    sol: normalizeWorkerRole(value.sol, "sol", { legacy: true }),
  };
}

function toRuntimeConfig(config) {
  if (config.version === RUNTIME_MODEL_ROUTE_VERSION) return config;
  return {
    ...config,
    planner: { mode: "inherit", thinking: "high" },
    validator: {
      thinking: "low",
      candidates: config.luna.candidates.map((candidate) => ({ ...candidate })),
    },
  };
}

function normalizeV2(value) {
  rejectUnknownKeys(value, V2_TOP_LEVEL_KEYS, "model routes");
  return {
    version: RUNTIME_MODEL_ROUTE_VERSION,
    planner: normalizePlannerRole(value.planner),
    luna: normalizeWorkerRole(value.luna, "luna"),
    validator: normalizeWorkerRole(value.validator, "validator"),
    sol: normalizeWorkerRole(value.sol, "sol"),
  };
}

export function normalizeModelRoutes(value = DEFAULT_MODEL_ROUTES) {
  if (!isPlainObject(value)) throw new Error("model routes must be a JSON object.");
  if (value.version === MODEL_ROUTE_VERSION) return normalizeV1(value);
  if (value.version === RUNTIME_MODEL_ROUTE_VERSION) return normalizeV2(value);
  throw new Error(`model routes.version must be ${MODEL_ROUTE_VERSION} or ${RUNTIME_MODEL_ROUTE_VERSION}.`);
}

export function modelReference(candidate) {
  return `${candidate.provider}/${candidate.model}`;
}

/**
 * Build an explicit v2 route file from Pi's already-authenticated model set.
 * Dedicated Luna/Sol models remain preferred, followed by the current Pi model,
 * then a deterministic provider/model ordering. The returned config is a normal
 * explicit route file and can be edited or replaced by the user later.
 */
export function buildAutoModelRoutes({
  availableCandidates = [],
  currentCandidate = null,
  plannerMode = "inherit",
} = {}) {
  if (!Array.isArray(availableCandidates)) {
    throw new TypeError("availableCandidates must be an array.");
  }
  if (!PLANNER_ROUTE_MODES.includes(plannerMode)) {
    throw new Error(`plannerMode must be one of: ${PLANNER_ROUTE_MODES.join(", ")}.`);
  }
  const available = orderedUniqueCandidates(availableCandidates).sort(compareCandidateReferences);
  if (available.length === 0) throw new Error("No authenticated Pi models are available for automatic Sol-Luna routing.");
  const availableByReference = new Map(available.map((candidate) => [modelReference(candidate), candidate]));
  const current = candidateFrom(currentCandidate);
  const eligibleCurrent = current ? availableByReference.get(modelReference(current)) ?? null : null;
  const roleCandidates = (preferred, dedicatedModelId) => {
    const preferredProviders = new Map(preferred.map((candidate, index) => [candidate.provider, index]));
    const dedicated = available
      .filter((candidate) => candidate.model === dedicatedModelId)
      .sort((left, right) => (
        (preferredProviders.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
        - (preferredProviders.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
        || compareCandidateReferences(left, right)
      ));
    return orderedUniqueCandidates([
      ...dedicated,
      eligibleCurrent,
      ...available,
    ]);
  };
  const lunaCandidates = roleCandidates(DEFAULT_LUNA_CANDIDATES, "gpt-5.6-luna");
  const solCandidates = roleCandidates(DEFAULT_SOL_CANDIDATES, "gpt-5.6-sol");
  const plannerCandidates = roleCandidates([]);
  return normalizeModelRoutes({
    version: RUNTIME_MODEL_ROUTE_VERSION,
    planner: {
      mode: plannerMode,
      thinking: "high",
      ...(plannerMode === "route" ? { candidates: plannerCandidates } : {}),
    },
    luna: { thinking: "medium", candidates: lunaCandidates },
    validator: { thinking: "low", candidates: lunaCandidates.map((candidate) => ({ ...candidate })) },
    sol: { thinking: "high", candidates: solCandidates },
  });
}

function normalizeComplexity(options) {
  const complexity = typeof options === "string" ? options : options?.complexity;
  if (complexity === undefined || complexity === null || complexity === "") return undefined;
  const normalized = nonEmptyString(complexity, "task complexity").toLowerCase();
  if (!TASK_COMPLEXITIES.includes(normalized)) {
    throw new Error(`task complexity must be one of: ${TASK_COMPLEXITIES.join(", ")}.`);
  }
  return normalized;
}

function resolveNormalizedRole(route, isAvailable, options = {}) {
  if (typeof isAvailable !== "function") throw new TypeError("isAvailable must be a function.");
  const complexity = normalizeComplexity(options);
  const thinking = complexity && route.thinkingByComplexity?.[complexity]
    ? route.thinkingByComplexity[complexity]
    : route.thinking;
  const availableCandidates = (route.candidates ?? []).map((candidate) => ({
    ...candidate,
    available: isAvailable(candidate) === true,
  }));
  let candidates = availableCandidates;
  const rankingOptions = {
    taskType: options?.taskType ?? complexity ?? "",
    scorer: options?.modelScorer,
    isAvailable: (candidate) => candidate.available === true,
  };
  try {
    candidates = typeof options?.modelRanker === "function"
      ? options.modelRanker(options.performanceStore, availableCandidates, rankingOptions)
      : options?.performanceStore
        ? rankModelCandidates(options.performanceStore, availableCandidates, rankingOptions)
        : availableCandidates;
    if (!Array.isArray(candidates) || candidates.length !== availableCandidates.length) candidates = availableCandidates;
  } catch {
    candidates = availableCandidates;
  }
  const selected = route.mode === "inherit" ? null : (candidates.find((candidate) => candidate.available) ?? null);
  const selection = selected
    ? {
        provider: selected.provider,
        model: selected.model,
        thinking,
        ...(route.budgetProfile !== undefined ? { budgetProfile: route.budgetProfile } : {}),
      }
    : null;
  return {
    ...(route.mode !== undefined ? { mode: route.mode } : {}),
    thinking,
    ...(route.thinkingByComplexity !== undefined ? { thinkingByComplexity: route.thinkingByComplexity } : {}),
    ...(route.budgetProfile !== undefined ? { budgetProfile: route.budgetProfile } : {}),
    candidates,
    selected,
    selection,
  };
}

// Supports both resolveRoleRoute(route, isAvailable, options) and
// resolveRoleRoute(config, role, isAvailable, options).
export function resolveRoleRoute(value, roleOrIsAvailable, isAvailableOrOptions, maybeOptions) {
  if (typeof roleOrIsAvailable === "string") {
    const config = value?.version === MODEL_ROUTE_VERSION || value?.version === RUNTIME_MODEL_ROUTE_VERSION
      ? toRuntimeConfig(normalizeModelRoutes(value))
      : value;
    const role = roleOrIsAvailable;
    if (!RUNTIME_ROUTE_ROLES.includes(role)) throw new Error(`Unknown model route role: ${role}.`);
    if (!config?.[role]) throw new Error(`model routes.${role} is required.`);
    return resolveNormalizedRole(config[role], isAvailableOrOptions, maybeOptions);
  }
  return resolveNormalizedRole(value, roleOrIsAvailable, isAvailableOrOptions);
}

export function resolveModelRoutes(value, isAvailable, options = {}) {
  if (typeof isAvailable !== "function") throw new TypeError("isAvailable must be a function.");
  const sourceConfig = normalizeModelRoutes(value);
  const config = toRuntimeConfig(sourceConfig);
  const roles = {};
  const selections = {};
  const missingRoles = [];

  roles.planner = resolveRoleRoute(config.planner, isAvailable, options);
  selections.planner = roles.planner.selection;
  if (config.planner.mode === "route" && !roles.planner.selected) missingRoles.push("planner");

  roles.luna = resolveRoleRoute(config.luna, isAvailable, options);
  selections.luna = roles.luna.selection;
  if (!roles.luna.selected) missingRoles.push("luna");

  if (sourceConfig.version === MODEL_ROUTE_VERSION) {
    // A v1 validator is a runtime fallback, not a third independently required route.
    roles.validator = {
      ...resolveRoleRoute(config.validator, isAvailable, options),
      candidates: roles.luna.candidates.map((candidate) => ({ ...candidate })),
      selected: roles.luna.selected ? { ...roles.luna.selected } : null,
    };
    roles.validator.selection = roles.validator.selected
      ? {
          provider: roles.validator.selected.provider,
          model: roles.validator.selected.model,
          thinking: roles.validator.thinking,
        }
      : null;
    selections.validator = roles.validator.selection;
  } else {
    roles.validator = resolveRoleRoute(config.validator, isAvailable, options);
    selections.validator = roles.validator.selection;
    if (!roles.validator.selected) missingRoles.push("validator");
  }

  roles.sol = resolveRoleRoute(config.sol, isAvailable, options);
  selections.sol = roles.sol.selection;
  if (!roles.sol.selected) missingRoles.push("sol");

  return {
    runtimeVersion: RUNTIME_MODEL_ROUTE_VERSION,
    config,
    ok: missingRoles.length === 0,
    roles,
    selections,
    missingRoles,
  };
}

const MODEL_PLACEHOLDER = 'model: "__SOL_LUNA_MODEL__"';
const THINKING_PLACEHOLDER = 'thinking: "__SOL_LUNA_THINKING__"';

export function renderAgentTemplate(source, selection) {
  if (typeof source !== "string") throw new TypeError("Agent template source must be a string.");
  if (!selection || typeof selection !== "object") throw new TypeError("A resolved model selection is required.");
  const model = modelReference(selection);
  const thinking = normalizeThinking(selection.thinking, "selection.thinking");
  if (source.split(MODEL_PLACEHOLDER).length !== 2) {
    throw new Error(`Agent template must contain exactly one ${MODEL_PLACEHOLDER} placeholder.`);
  }
  if (source.split(THINKING_PLACEHOLDER).length !== 2) {
    throw new Error(`Agent template must contain exactly one ${THINKING_PLACEHOLDER} placeholder.`);
  }
  return source
    .replace(MODEL_PLACEHOLDER, `model: ${JSON.stringify(model)}`)
    .replace(THINKING_PLACEHOLDER, `thinking: ${JSON.stringify(thinking)}`);
}
