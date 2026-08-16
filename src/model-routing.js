import { isPlainObject } from "./core.js";

export const MODEL_ROUTE_VERSION = 1;
export const MODEL_ROUTE_ROLES = Object.freeze(["luna", "sol"]);
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_MODEL_ROUTES = Object.freeze({
  version: MODEL_ROUTE_VERSION,
  luna: Object.freeze({
    thinking: "xhigh",
    candidates: Object.freeze([
      Object.freeze({ provider: "cliproxyapi", model: "gpt-5.6-luna" }),
      Object.freeze({ provider: "openai", model: "gpt-5.6-luna" }),
    ]),
  }),
  sol: Object.freeze({
    thinking: "xhigh",
    candidates: Object.freeze([
      Object.freeze({ provider: "cliproxyapi", model: "gpt-5.6-sol" }),
      Object.freeze({ provider: "openai", model: "gpt-5.6-sol" }),
    ]),
  }),
});

const TOP_LEVEL_KEYS = new Set(["version", ...MODEL_ROUTE_ROLES]);
const ROLE_KEYS = new Set(["thinking", "candidates"]);
const CANDIDATE_KEYS = new Set(["provider", "model"]);

function rejectUnknownKeys(value, allowed, path) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${path} contains unknown field(s): ${unknown.join(", ")}.`);
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function normalizeCandidate(value, path) {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, CANDIDATE_KEYS, path);
  const provider = nonEmptyString(value.provider, `${path}.provider`);
  const model = nonEmptyString(value.model, `${path}.model`);
  if (provider.includes("/")) throw new Error(`${path}.provider must not contain '/'.`);
  return { provider, model };
}

function normalizeRole(value, role) {
  const path = `model routes.${role}`;
  if (!isPlainObject(value)) throw new Error(`${path} must be an object.`);
  rejectUnknownKeys(value, ROLE_KEYS, path);
  const thinking = nonEmptyString(value.thinking, `${path}.thinking`).toLowerCase();
  if (!THINKING_LEVELS.includes(thinking)) {
    throw new Error(`${path}.thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
    throw new Error(`${path}.candidates must be a non-empty array.`);
  }
  const candidates = value.candidates.map((candidate, index) => normalizeCandidate(candidate, `${path}.candidates[${index}]`));
  const seen = new Set();
  for (const candidate of candidates) {
    const key = modelReference(candidate);
    if (seen.has(key)) throw new Error(`${path}.candidates contains duplicate model ${key}.`);
    seen.add(key);
  }
  return { thinking, candidates };
}

export function normalizeModelRoutes(value = DEFAULT_MODEL_ROUTES) {
  if (!isPlainObject(value)) throw new Error("model routes must be a JSON object.");
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, "model routes");
  if (value.version !== MODEL_ROUTE_VERSION) {
    throw new Error(`model routes.version must be ${MODEL_ROUTE_VERSION}.`);
  }
  return {
    version: MODEL_ROUTE_VERSION,
    luna: normalizeRole(value.luna, "luna"),
    sol: normalizeRole(value.sol, "sol"),
  };
}

export function modelReference(candidate) {
  return `${candidate.provider}/${candidate.model}`;
}

export function resolveModelRoutes(value, isAvailable) {
  if (typeof isAvailable !== "function") throw new TypeError("isAvailable must be a function.");
  const config = normalizeModelRoutes(value);
  const roles = {};
  const selections = {};
  const missingRoles = [];

  for (const role of MODEL_ROUTE_ROLES) {
    const candidates = config[role].candidates.map((candidate) => ({
      ...candidate,
      available: isAvailable(candidate) === true,
    }));
    const selected = candidates.find((candidate) => candidate.available) ?? null;
    roles[role] = {
      thinking: config[role].thinking,
      candidates,
      selected,
    };
    selections[role] = selected
      ? { provider: selected.provider, model: selected.model, thinking: config[role].thinking }
      : null;
    if (!selected) missingRoles.push(role);
  }

  return {
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
  const thinking = nonEmptyString(selection.thinking, "selection.thinking").toLowerCase();
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Unsupported selection thinking level: ${thinking}.`);
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
