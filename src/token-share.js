export const PROJECT_TOKEN_UI_VERSION = 1;
export const PROJECT_TOKEN_ROLES = Object.freeze(["planner", "luna", "validator", "sol"]);
export const PROJECT_TOKEN_LABELS = Object.freeze({
  planner: "P",
  luna: "L",
  validator: "V",
  sol: "S",
});

const MAX_SEEN_KEYS = 4096;
const TOP_LEVEL_KEYS = new Set(["version", "visible", "tokens", "seen"]);
const TOKEN_KEYS = new Set(PROJECT_TOKEN_ROLES);
const SEEN_KEYS = new Set(["plannerMessages", "workerRuns"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown field(s): ${unknown.join(", ")}.`);
}

function safeInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeSeenKeys(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  const seen = new Set();
  const result = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${path} entries must be non-empty strings.`);
    const key = entry.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result.slice(-MAX_SEEN_KEYS);
}

export function initialProjectTokenState({ visible = false } = {}) {
  return {
    version: PROJECT_TOKEN_UI_VERSION,
    visible: visible === true,
    tokens: Object.fromEntries(PROJECT_TOKEN_ROLES.map((role) => [role, 0])),
    seen: {
      plannerMessages: [],
      workerRuns: [],
    },
  };
}

export function normalizeProjectTokenState(value = initialProjectTokenState()) {
  if (!isPlainObject(value)) throw new Error("project token UI state must be a JSON object.");
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, "project token UI state");
  if (value.version !== PROJECT_TOKEN_UI_VERSION) {
    throw new Error(`project token UI state.version must be ${PROJECT_TOKEN_UI_VERSION}.`);
  }
  if (typeof value.visible !== "boolean") throw new Error("project token UI state.visible must be a boolean.");
  if (!isPlainObject(value.tokens)) throw new Error("project token UI state.tokens must be an object.");
  if (!isPlainObject(value.seen)) throw new Error("project token UI state.seen must be an object.");
  rejectUnknownKeys(value.tokens, TOKEN_KEYS, "project token UI state.tokens");
  rejectUnknownKeys(value.seen, SEEN_KEYS, "project token UI state.seen");
  return {
    version: PROJECT_TOKEN_UI_VERSION,
    visible: value.visible,
    tokens: Object.fromEntries(PROJECT_TOKEN_ROLES.map((role) => [
      role,
      safeInteger(value.tokens[role], `project token UI state.tokens.${role}`),
    ])),
    seen: {
      plannerMessages: normalizeSeenKeys(value.seen.plannerMessages, "project token UI state.seen.plannerMessages"),
      workerRuns: normalizeSeenKeys(value.seen.workerRuns, "project token UI state.seen.workerRuns"),
    },
  };
}

function usageComponent(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function tokenTotalFromUsage(usage) {
  if (!isPlainObject(usage)) return null;
  const input = usageComponent(usage.input);
  const output = usageComponent(usage.output);
  const cacheWrite = usageComponent(usage.cacheWrite);
  if (input === null && output === null && cacheWrite === null) return null;
  const total = (input ?? 0) + (output ?? 0) + (cacheWrite ?? 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function tokenTotalFromWorkerEvent(event) {
  const direct = tokenTotalFromUsage(event?.usage);
  if (direct !== null) return direct;
  const fallback = event?.tokens?.total;
  return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : null;
}

function boundedAppend(values, key) {
  return [...values, key].slice(-MAX_SEEN_KEYS);
}

export function recordProjectTokenUsage(value, { role, tokens, kind, key } = {}) {
  const state = normalizeProjectTokenState(value);
  if (!PROJECT_TOKEN_ROLES.includes(role)) throw new Error(`Unknown project token role: ${String(role)}.`);
  safeInteger(tokens, "project token usage tokens");
  if (!SEEN_KEYS.has(kind)) throw new Error(`Unknown project token deduplication kind: ${String(kind)}.`);
  if (typeof key !== "string" || !key.trim()) throw new Error("project token deduplication key must be a non-empty string.");
  const normalizedKey = key.trim();
  if (state.seen[kind].includes(normalizedKey)) {
    return { state, changed: false, duplicate: true };
  }
  return {
    state: {
      ...state,
      tokens: {
        ...state.tokens,
        [role]: state.tokens[role] > Number.MAX_SAFE_INTEGER - tokens
          ? Number.MAX_SAFE_INTEGER
          : state.tokens[role] + tokens,
      },
      seen: {
        ...state.seen,
        [kind]: boundedAppend(state.seen[kind], normalizedKey),
      },
    },
    changed: true,
    duplicate: false,
  };
}

export function setProjectTokenVisibility(value, visible) {
  const state = normalizeProjectTokenState(value);
  const nextVisible = visible === true;
  return {
    state: nextVisible === state.visible ? state : { ...state, visible: nextVisible },
    changed: nextVisible !== state.visible,
  };
}

export function resetProjectTokenTotals(value) {
  const state = normalizeProjectTokenState(value);
  const changed = PROJECT_TOKEN_ROLES.some((role) => state.tokens[role] !== 0);
  return {
    state: changed
      ? { ...state, tokens: Object.fromEntries(PROJECT_TOKEN_ROLES.map((role) => [role, 0])) }
      : state,
    changed,
  };
}

export function projectTokenPercentages(value) {
  const state = normalizeProjectTokenState(value);
  const total = PROJECT_TOKEN_ROLES.reduce((sum, role) => sum + BigInt(state.tokens[role]), 0n);
  if (total === 0n) return Object.fromEntries(PROJECT_TOKEN_ROLES.map((role) => [role, 0]));

  const allocations = PROJECT_TOKEN_ROLES.map((role, index) => {
    const scaled = BigInt(state.tokens[role]) * 100n;
    return {
      role,
      index,
      percentage: Number(scaled / total),
      remainder: scaled % total,
    };
  });
  let remaining = 100 - allocations.reduce((sum, entry) => sum + entry.percentage, 0);
  const ranked = [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.index - right.index;
  });
  for (let index = 0; index < remaining; index += 1) ranked[index].percentage += 1;
  return Object.fromEntries(allocations.map(({ role, percentage }) => [role, percentage]));
}

export function formatProjectTokenShares(value) {
  const percentages = projectTokenPercentages(value);
  return PROJECT_TOKEN_ROLES
    .map((role) => `${PROJECT_TOKEN_LABELS[role]}(${percentages[role]}%)`)
    .join(",");
}
