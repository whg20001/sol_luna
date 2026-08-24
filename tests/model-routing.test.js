import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MODEL_ROUTES,
  MODEL_ROUTE_ROLES,
  buildAutoModelRoutes,
  MODEL_ROUTE_VERSION,
  RUNTIME_MODEL_ROUTE_VERSION,
  RUNTIME_ROUTE_ROLES,
  modelReference,
  normalizeModelRoutes,
  renderAgentTemplate,
  resolveModelRoutes,
  resolveRoleRoute,
} from "../src/model-routing.js";

const TEMPLATE = `---\ndescription: worker\nmodel: "__SOL_LUNA_MODEL__"\nthinking: "__SOL_LUNA_THINKING__"\n---\n`;
const candidate = (provider, model) => ({ provider, model });

function v2Config(overrides = {}) {
  return {
    version: 2,
    planner: { mode: "inherit", thinking: "high" },
    luna: { thinking: "medium", candidates: [candidate("openai", "luna")] },
    validator: { thinking: "low", candidates: [candidate("openai", "validator")] },
    sol: { thinking: "high", candidates: [candidate("openai", "sol")] },
    ...overrides,
  };
}

test("legacy exports and v1 normalized shape remain stable", () => {
  assert.equal(MODEL_ROUTE_VERSION, 1);
  assert.deepEqual(MODEL_ROUTE_ROLES, ["luna", "sol"]);
  assert.equal(RUNTIME_MODEL_ROUTE_VERSION, 2);
  assert.deepEqual(RUNTIME_ROUTE_ROLES, ["planner", "luna", "validator", "sol"]);

  const normalized = normalizeModelRoutes({
    version: 1,
    luna: { thinking: "medium", candidates: [candidate("openai", "luna")] },
    sol: { thinking: "high", candidates: [candidate("openai", "sol")] },
  });
  assert.deepEqual(normalized, {
    version: 1,
    luna: { thinking: "medium", candidates: [candidate("openai", "luna")] },
    sol: { thinking: "high", candidates: [candidate("openai", "sol")] },
  });
});

test("default routes retain models with Luna medium, Validator low, Sol high, Planner high", () => {
  const resolution = resolveModelRoutes(DEFAULT_MODEL_ROUTES, () => true);
  assert.equal(modelReference(resolution.selections.luna), "cliproxyapi/gpt-5.6-luna");
  assert.equal(modelReference(resolution.selections.validator), "cliproxyapi/gpt-5.6-luna");
  assert.equal(modelReference(resolution.selections.sol), "cliproxyapi/gpt-5.6-sol");
  assert.equal(resolution.roles.planner.thinking, "high");
  assert.equal(resolution.roles.luna.thinking, "medium");
  assert.equal(resolution.roles.validator.thinking, "low");
  assert.equal(resolution.roles.sol.thinking, "high");
  assert.equal(resolution.selections.planner, null);
});

test("automatic routes prefer dedicated models, then current model, with deterministic fallbacks", () => {
  const available = [
    candidate("z-provider", "z-model"),
    candidate("openai", "gpt-5.6-sol"),
    candidate("openai", "gpt-5.6-luna"),
    candidate("a-provider", "a-model"),
  ];
  const routes = buildAutoModelRoutes({
    availableCandidates: available,
    currentCandidate: candidate("z-provider", "z-model"),
  });
  assert.equal(routes.version, 2);
  assert.deepEqual(routes.planner, { mode: "inherit", thinking: "high" });
  assert.equal(modelReference(routes.luna.candidates[0]), "openai/gpt-5.6-luna");
  assert.equal(modelReference(routes.validator.candidates[0]), "openai/gpt-5.6-luna");
  assert.equal(modelReference(routes.sol.candidates[0]), "openai/gpt-5.6-sol");

  const thirdPartyDedicated = buildAutoModelRoutes({
    availableCandidates: [candidate("custom", "gpt-5.6-luna"), candidate("z-provider", "z-model")],
    currentCandidate: candidate("z-provider", "z-model"),
  });
  assert.equal(modelReference(thirdPartyDedicated.luna.candidates[0]), "custom/gpt-5.6-luna");

  const fallback = buildAutoModelRoutes({
    availableCandidates: [candidate("z-provider", "z-model"), candidate("a-provider", "a-model")],
    currentCandidate: candidate("z-provider", "z-model"),
    plannerMode: "route",
  });
  assert.equal(modelReference(fallback.luna.candidates[0]), "z-provider/z-model");
  assert.equal(modelReference(fallback.validator.candidates[0]), "z-provider/z-model");
  assert.equal(modelReference(fallback.sol.candidates[0]), "z-provider/z-model");
  assert.equal(modelReference(fallback.planner.candidates[0]), "z-provider/z-model");

  const deterministic = buildAutoModelRoutes({
    availableCandidates: [candidate("z-provider", "z-model"), candidate("a-provider", "a-model")],
  });
  assert.equal(modelReference(deterministic.luna.candidates[0]), "a-provider/a-model");
  assert.deepEqual(
    buildAutoModelRoutes({ availableCandidates: [...available].reverse() }),
    buildAutoModelRoutes({ availableCandidates: available }),
  );
  assert.throws(() => buildAutoModelRoutes(), /No authenticated Pi models/);
});

test("v1 runtime completion synthesizes planner and validator while only Luna/Sol affect ok", () => {
  const config = {
    version: 1,
    luna: { thinking: "high", candidates: [candidate("openai", "same")] },
    sol: { thinking: "max", candidates: [candidate("openai", "missing")] },
  };
  const resolution = resolveModelRoutes(config, ({ model }) => model === "same");
  assert.deepEqual(resolution.config.planner, { mode: "inherit", thinking: "high" });
  assert.deepEqual(resolution.config.validator, {
    thinking: "low",
    candidates: [candidate("openai", "same")],
  });
  assert.equal(modelReference(resolution.selections.validator), "openai/same");
  assert.equal(resolution.selections.validator.thinking, "low");
  assert.equal(resolution.ok, false);
  assert.deepEqual(resolution.missingRoles, ["sol"]);

  const none = resolveModelRoutes(config, () => false);
  assert.deepEqual(none.missingRoles, ["luna", "sol"]);
});

test("v2 normalization and routing cover planner plus all worker roles", () => {
  const input = v2Config({
    planner: { mode: "inherit", thinking: "high", candidates: [candidate("openai", "optional-planner")] },
    luna: {
      thinking: "medium",
      candidates: [candidate("missing", "luna"), candidate("openai", "luna")],
      thinkingByComplexity: { low: "low", medium: "medium", high: "high" },
      budgetProfile: "executor",
    },
    validator: { thinking: "low", candidates: [candidate("missing", "validator")] },
  });
  const normalized = normalizeModelRoutes(input);
  assert.deepEqual(normalized, input);

  const resolution = resolveModelRoutes(normalized, ({ provider }) => provider === "openai", { complexity: "high" });
  assert.equal(resolution.roles.planner.selected, null);
  assert.equal(resolution.selections.luna.thinking, "high");
  assert.equal(resolution.selections.luna.budgetProfile, "executor");
  assert.equal(modelReference(resolution.selections.luna), "openai/luna");
  assert.equal(resolution.ok, false);
  assert.deepEqual(resolution.missingRoles, ["validator"]);

  const role = resolveRoleRoute(normalized, "luna", () => true, "low");
  assert.equal(role.thinking, "low");
});

test("runtime model ranking reorders available candidates with stable fallback", () => {
  const config = v2Config({
    luna: {
      thinking: "medium",
      candidates: [candidate("openai", "first"), candidate("openai", "second")],
    },
  });
  const performanceStore = {
    records: [
      { provider: "openai", model: "first", taskType: "coding", successRate: 0.2, quality: 0.3, cost: 2, latencyMs: 2000, samples: 5 },
      { provider: "openai", model: "second", taskType: "coding", successRate: 1, quality: 1, cost: 1, latencyMs: 1000, samples: 5 },
    ],
  };
  const ranked = resolveModelRoutes(config, () => true, { taskType: "coding", performanceStore });
  assert.equal(ranked.selections.luna.model, "second");
  const fallback = resolveModelRoutes(config, () => true, {
    taskType: "coding",
    performanceStore,
    modelRanker() { throw new Error("ranker unavailable"); },
  });
  assert.equal(fallback.selections.luna.model, "first");
});

test("v2 validator has no Luna fallback", () => {
  const resolution = resolveModelRoutes(v2Config(), ({ model }) => model !== "validator");
  assert.equal(resolution.selections.validator, null);
  assert.deepEqual(resolution.missingRoles, ["validator"]);
});

test("model route validation rejects malformed or ambiguous configuration", () => {
  assert.throws(() => normalizeModelRoutes({}), /version must be 1 or 2/);
  assert.throws(() => normalizeModelRoutes({ ...DEFAULT_MODEL_ROUTES, extra: true }), /unknown field/i);
  assert.throws(
    () => normalizeModelRoutes({ ...DEFAULT_MODEL_ROUTES, luna: { thinking: "turbo", candidates: [] } }),
    /thinking must be one of/i,
  );
  assert.throws(
    () => normalizeModelRoutes(v2Config({
      luna: { thinking: "high", candidates: [candidate("openai", "same"), candidate("openai", "same")] },
    })),
    /duplicate model/i,
  );
  assert.throws(
    () => normalizeModelRoutes(v2Config({
      luna: { thinking: "high", candidates: [candidate("bad/provider", "model")] },
    })),
    /must not contain '\/'/i,
  );
  assert.throws(
    () => normalizeModelRoutes(v2Config({ validator: { thinking: "low", candidates: [] } })),
    /non-empty array/i,
  );
});

test("agent templates are rendered compatibly", () => {
  const rendered = renderAgentTemplate(TEMPLATE, {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    thinking: "high",
  });
  assert.match(rendered, /model: "openrouter\/anthropic\/claude-sonnet-4"/);
  assert.match(rendered, /thinking: "high"/);
  assert.doesNotMatch(rendered, /__SOL_LUNA_/);
  assert.throws(() => renderAgentTemplate("model: none", { provider: "x", model: "y", thinking: "high" }), /exactly one/);
});

test("worker templates share a byte-identical protocol body and Validator is read-only", () => {
  const directory = fileURLToPath(new URL("../templates/agents/", import.meta.url));
  const names = ["luna-worker.md", "validator-worker.md", "sol-worker.md"];
  const sources = Object.fromEntries(names.map((name) => [name, readFileSync(`${directory}${name}`, "utf8")]));
  const body = (source) => source.replace(/^---\n[\s\S]*?\n---\n/u, "");
  assert.equal(body(sources[names[0]]), body(sources[names[1]]));
  assert.equal(body(sources[names[1]]), body(sources[names[2]]));

  const frontmatter = (source) => source.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
  const validatorFrontmatter = frontmatter(sources["validator-worker.md"]);
  assert.match(validatorFrontmatter, /^tools: read, grep, find, ls, sol_luna_validate$/mu);
  assert.doesNotMatch(validatorFrontmatter, /\b(?:edit|write)\b/u);
  assert.match(body(sources["sol-worker.md"]), /require `failure\.snapshot`/);
  assert.match(body(sources["validator-worker.md"]), /Do not modify files or redesign the solution/);
  assert.match(body(sources["luna-worker.md"]), /Return exactly one JSON object/);
});
