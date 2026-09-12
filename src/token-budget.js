import { canonicalStringify, normalizeContextEnvelope } from "./context-envelope.js";

export const BUDGET_FEEDBACK_VERSION = 1;

export const DEFAULT_TOKEN_BUDGETS = Object.freeze({
  planner: Object.freeze({ thinking: "high", outputTokens: 4_000 }),
  luna: Object.freeze({ thinking: "medium", outputTokens: 8_000 }),
  validator: Object.freeze({ thinking: "low", outputTokens: 2_000 }),
  sol: Object.freeze({ thinking: "high", outputTokens: 6_000 }),
});

const COMPLEXITY_MULTIPLIERS = Object.freeze({ low: 0.75, medium: 1, high: 1.25 });
const ROLES = new Set(Object.keys(DEFAULT_TOKEN_BUDGETS));
const THINKING_LEVELS = new Set(["low", "medium", "high"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roleName(value) {
  const role = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (role === "root") return "planner";
  if (role === "executor") return "luna";
  if (role === "recovery") return "sol";
  if (!ROLES.has(role)) throw new Error(`Unsupported token-budget role: ${String(value)}.`);
  return role;
}

function outputTokens(value, fallback) {
  const candidate = value?.outputTokens ?? value?.outputBudget ?? value?.maxOutputTokens ?? value?.maxTokens;
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

// Route profiles override output allocation only, never frozen reasoning.
export function normalizeRouteBudgetProfile(value, path = "budgetProfile") {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      roleName(value);
    } catch {
      throw new Error(`${path} must name planner, luna/executor, validator, or sol/recovery.`);
    }
    return value.trim().toLowerCase();
  }
  const keys = isObject(value) ? Object.keys(value) : [];
  const aliases = ["outputTokens", "outputBudget", "maxOutputTokens", "maxTokens"];
  if (keys.length !== 1 || !aliases.includes(keys[0])
    || !Number.isSafeInteger(value[keys[0]]) || value[keys[0]] <= 0) {
    throw new Error(`${path} must contain exactly one positive safe integer outputTokens (or outputBudget/maxOutputTokens/maxTokens).`);
  }
  return { ...value };
}

export function normalizeBudgetPolicy(value = {}) {
  if (value != null && !isObject(value)) throw new TypeError("Budget policy must be an object.");
  const source = value ?? {};
  const roleSource = isObject(source.roles) ? source.roles : source;
  const roles = {};
  for (const role of ROLES) {
    const defaults = DEFAULT_TOKEN_BUDGETS[role];
    const configured = isObject(roleSource[role]) ? roleSource[role] : {};
    const thinking = THINKING_LEVELS.has(configured.thinking) ? configured.thinking : defaults.thinking;
    roles[role] = {
      thinking,
      outputTokens: outputTokens(configured, defaults.outputTokens),
    };
  }
  const complexityMultipliers = {};
  const configuredMultipliers = isObject(source.complexityMultipliers) ? source.complexityMultipliers : {};
  for (const [complexity, fallback] of Object.entries(COMPLEXITY_MULTIPLIERS)) {
    const configured = configuredMultipliers[complexity];
    complexityMultipliers[complexity] = typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? configured
      : fallback;
  }
  return {
    roles,
    complexityMultipliers,
    estimator: typeof source.estimator === "function" ? source.estimator : null,
  };
}

export function estimateTokens(value, estimatorOrOptions) {
  const estimator = typeof estimatorOrOptions === "function"
    ? estimatorOrOptions
    : typeof estimatorOrOptions?.estimator === "function"
      ? estimatorOrOptions.estimator
      : null;
  const serialized = typeof value === "string" ? value : canonicalStringify(value);
  if (estimator) {
    const estimate = estimator(serialized, value);
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new Error("Custom token estimator must return a finite non-negative number.");
    }
    return Math.ceil(estimate);
  }
  if (!serialized) return 0;
  return Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
}

export function normalizeUsageFeedback(value = []) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(-50).map((entry) => ({
    role: typeof entry?.role === "string" ? entry.role.trim().toLowerCase() : null,
    inputTokens: Number.isInteger(entry?.inputTokens) && entry.inputTokens >= 0 ? entry.inputTokens : 0,
    outputTokens: Number.isInteger(entry?.outputTokens) && entry.outputTokens >= 0 ? entry.outputTokens : 0,
    latencyMs: Number.isInteger(entry?.latencyMs) && entry.latencyMs >= 0 ? entry.latencyMs : 0,
    success: entry?.success === true,
    truncated: entry?.truncated === true,
    validatorMode: typeof entry?.validatorMode === "string" ? entry.validatorMode : null,
    taskType: typeof entry?.taskType === "string" ? entry.taskType.trim().toLowerCase() : null,
  }));
}

export function adaptTokenBudget(baseBudget, feedback = [], options = {}) {
  if (!isObject(baseBudget)) throw new TypeError("adaptTokenBudget requires a base budget object.");
  const taskType = typeof options.taskType === "string" ? options.taskType.trim().toLowerCase() : null;
  const entries = normalizeUsageFeedback(feedback)
    .filter((entry) => entry.role === baseBudget.role && (!taskType || entry.taskType === taskType))
    .slice(-10);
  if (entries.length === 0) return { ...baseBudget, feedbackMultiplier: 1, feedbackSamples: 0 };
  const successRate = entries.filter((entry) => entry.success).length / entries.length;
  const truncatedRate = entries.filter((entry) => entry.truncated).length / entries.length;
  const failureRate = 1 - successRate;
  const maxAdjustment = typeof options.maxAdjustment === "number"
    ? Math.max(0, Math.min(0.5, options.maxAdjustment))
    : 0.25;
  const raw = 1 + (failureRate * 0.2) + (truncatedRate * 0.15) - (successRate === 1 && truncatedRate === 0 ? 0.1 : 0);
  const multiplier = Math.max(1 - maxAdjustment, Math.min(1 + maxAdjustment, raw));
  return {
    ...baseBudget,
    outputTokens: Math.max(1, Math.round(baseBudget.outputTokens * multiplier)),
    feedbackMultiplier: multiplier,
    feedbackSamples: entries.length,
  };
}

export function resolveTokenBudget(roleOrOptions, complexityOrPolicy = "medium", maybePolicy = {}) {
  const objectForm = isObject(roleOrOptions);
  const role = roleName(objectForm ? roleOrOptions.role : roleOrOptions);
  const complexity = objectForm
    ? (roleOrOptions.complexity ?? "medium")
    : (typeof complexityOrPolicy === "string" ? complexityOrPolicy : "medium");
  const policyInput = objectForm
    ? (roleOrOptions.policy ?? roleOrOptions.budgets ?? {})
    : (isObject(complexityOrPolicy) ? complexityOrPolicy : maybePolicy);
  if (!Object.hasOwn(COMPLEXITY_MULTIPLIERS, complexity)) {
    throw new Error(`Unsupported task complexity: ${String(complexity)}.`);
  }
  const policy = normalizeBudgetPolicy(policyInput);
  const profile = normalizeRouteBudgetProfile(objectForm ? roleOrOptions.budgetProfile : undefined);
  const configured = policy.roles[role];
  const allocation = typeof profile === "string"
    ? policy.roles[roleName(profile)].outputTokens
    : outputTokens(profile, configured.outputTokens);
  const baseBudget = {
    role,
    complexity,
    thinking: configured.thinking,
    outputTokens: Math.max(1, Math.round(allocation * policy.complexityMultipliers[complexity])),
  };
  const feedback = objectForm ? roleOrOptions.feedback : undefined;
  return feedback
    ? adaptTokenBudget(baseBudget, feedback, { ...roleOrOptions.feedbackOptions, taskType: roleOrOptions.taskType })
    : baseBudget;
}

function clone(value) {
  return structuredClone(value);
}

function tokenLimit(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (isObject(value)) {
    const candidate = value.inputTokens ?? value.tokenBudget ?? value.maxTokens ?? value.outputTokens ?? value.outputBudget;
    if (Number.isInteger(candidate) && candidate > 0) return candidate;
  }
  throw new Error("compactEnvelopeToBudget requires a positive token budget.");
}

function findArrays(root, matcher, path = [], result = []) {
  if (Array.isArray(root)) {
    if (matcher(path)) result.push({ array: root, path });
    for (let index = 0; index < root.length; index += 1) findArrays(root[index], matcher, [...path, index], result);
  } else if (isObject(root)) {
    for (const [key, value] of Object.entries(root)) findArrays(value, matcher, [...path, key], result);
  }
  return result;
}

function shortenLogs(root, maxLength) {
  let changed = false;
  function visit(value, key = "") {
    if (!isObject(value) && !Array.isArray(value)) return;
    for (const childKey of Object.keys(value)) {
      const child = value[childKey];
      if (typeof child === "string" && /(?:log|output|stderr|stdout|diffSummary|diff_summary)$/i.test(childKey) && child.length > maxLength) {
        value[childKey] = `${child.slice(0, Math.max(0, maxLength - 14))}\n…[truncated]`;
        changed = true;
      } else visit(child, childKey);
    }
  }
  visit(root);
  return changed;
}

export function compactEnvelopeToBudget(envelope, budgetOrOptions, maybeOptions = {}) {
  const options = isObject(budgetOrOptions) ? { ...budgetOrOptions, ...maybeOptions } : maybeOptions;
  const budget = tokenLimit(budgetOrOptions);
  const estimator = typeof options.estimator === "function" ? options.estimator : null;
  const compacted = clone(normalizeContextEnvelope(envelope, options));
  // Hosts may measure a fully rendered prompt: tokenizers need not be additive.
  // Repeated fit checks of an unchanged candidate reuse the expensive measurement.
  let lastSerialized;
  let measured;
  const fits = () => {
    const serialized = canonicalStringify(compacted);
    if (serialized !== lastSerialized) {
      measured = typeof options.measureTokens === "function"
        ? options.measureTokens(compacted)
        : estimateTokens(serialized, estimator ? (text) => estimator(text, compacted) : undefined);
      if (!Number.isFinite(measured) || measured < 0) {
        throw new Error("Token measurement must return a finite non-negative number.");
      }
      lastSerialized = serialized;
    }
    return Math.ceil(measured) <= budget;
  };
  if (fits()) return compacted;

  // Old runtime events are cheapest to reconstruct and are removed first.
  const eventArrays = findArrays(compacted, (path) => path.at(-1) === "events");
  while (!fits() && eventArrays.some(({ array }) => array.length > 0)) {
    for (const { array } of eventArrays) if (array.length > 0) array.shift();
  }

  // Then progressively shorten diagnostic logs, while never deleting currentError.
  for (const length of [4_000, 2_000, 1_000, 500, 200]) {
    if (fits()) break;
    shortenLogs(compacted, length);
  }

  // Historical tests/reports are removed oldest-first; acceptance is never touched.
  const historyNames = new Set([
    "tests",
    "workerReports",
    "validationReports",
    "attemptHistory",
    "worker_reports",
    "validation_reports",
    "attempt_history",
    "snapshots",
  ]);
  const histories = findArrays(compacted, (path) => historyNames.has(path.at(-1)));
  while (!fits() && histories.some(({ array }) => array.length > 1)) {
    for (const { array } of histories) if (array.length > 1) array.shift();
  }
  while (!fits() && histories.some(({ array }) => array.length > 0)) {
    for (const { array, path } of histories) {
      if (array.length > 0 && !["attemptHistory", "attempt_history"].includes(path.at(-1))) array.shift();
    }
    if (histories.every(({ array, path }) => array.length === 0 || ["attemptHistory", "attempt_history"].includes(path.at(-1)))) break;
  }

  // Finally trim non-essential task state. objective, acceptance, and currentError are invariant.
  const stateNames = new Set(["completed", "pending", "blocked", "constraints"]);
  const stateArrays = findArrays(compacted, (path) => stateNames.has(path.at(-1)));
  while (!fits() && stateArrays.some(({ array }) => array.length > 0)) {
    for (const { array } of stateArrays) if (array.length > 0) array.shift();
  }
  if (!fits()) {
    throw new Error(`Unable to compact Context Envelope to ${budget} tokens without removing required objective, acceptance, or current-error evidence.`);
  }
  return compacted;
}
