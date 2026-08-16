import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_ROUTES,
  modelReference,
  normalizeModelRoutes,
  renderAgentTemplate,
  resolveModelRoutes,
} from "../src/model-routing.js";

const TEMPLATE = `---\ndescription: worker\nmodel: "__SOL_LUNA_MODEL__"\nthinking: "__SOL_LUNA_THINKING__"\n---\n`;

test("default routes prefer CLIProxy and fall back to direct OpenAI", () => {
  const allAvailable = resolveModelRoutes(DEFAULT_MODEL_ROUTES, () => true);
  assert.equal(modelReference(allAvailable.selections.luna), "cliproxyapi/gpt-5.6-luna");
  assert.equal(modelReference(allAvailable.selections.sol), "cliproxyapi/gpt-5.6-sol");

  const openAiOnly = resolveModelRoutes(
    DEFAULT_MODEL_ROUTES,
    ({ provider }) => provider === "openai",
  );
  assert.equal(openAiOnly.ok, true);
  assert.equal(modelReference(openAiOnly.selections.luna), "openai/gpt-5.6-luna");
  assert.equal(modelReference(openAiOnly.selections.sol), "openai/gpt-5.6-sol");
});

test("routes require an exact provider and model match", () => {
  const available = new Set(["other/gpt-5.6-luna", "openai/gpt-5.6-sol"]);
  const resolution = resolveModelRoutes(
    DEFAULT_MODEL_ROUTES,
    (candidate) => available.has(modelReference(candidate)),
  );
  assert.equal(resolution.ok, false);
  assert.deepEqual(resolution.missingRoles, ["luna"]);
  assert.equal(resolution.selections.luna, null);
  assert.equal(modelReference(resolution.selections.sol), "openai/gpt-5.6-sol");
});

test("custom providers and model IDs containing slashes are supported", () => {
  const config = normalizeModelRoutes({
    version: 1,
    luna: {
      thinking: "high",
      candidates: [{ provider: "openrouter", model: "anthropic/claude-sonnet-4" }],
    },
    sol: {
      thinking: "max",
      candidates: [{ provider: "local-vllm", model: "deepseek-ai/DeepSeek-V3" }],
    },
  });
  const resolution = resolveModelRoutes(config, () => true);
  assert.equal(modelReference(resolution.selections.luna), "openrouter/anthropic/claude-sonnet-4");
  assert.equal(resolution.selections.luna.thinking, "high");
  assert.equal(modelReference(resolution.selections.sol), "local-vllm/deepseek-ai/DeepSeek-V3");
  assert.equal(resolution.selections.sol.thinking, "max");
});

test("model route validation rejects malformed or ambiguous configuration", () => {
  assert.throws(() => normalizeModelRoutes({}), /version must be 1/);
  assert.throws(() => normalizeModelRoutes({ ...DEFAULT_MODEL_ROUTES, extra: true }), /unknown field/i);
  assert.throws(
    () => normalizeModelRoutes({ ...DEFAULT_MODEL_ROUTES, luna: { thinking: "turbo", candidates: [] } }),
    /thinking must be one of/i,
  );
  assert.throws(
    () => normalizeModelRoutes({
      ...DEFAULT_MODEL_ROUTES,
      luna: {
        thinking: "high",
        candidates: [
          { provider: "openai", model: "gpt-5.6-luna" },
          { provider: "openai", model: "gpt-5.6-luna" },
        ],
      },
    }),
    /duplicate model/i,
  );
  assert.throws(
    () => normalizeModelRoutes({
      ...DEFAULT_MODEL_ROUTES,
      luna: { thinking: "high", candidates: [{ provider: "bad/provider", model: "model" }] },
    }),
    /must not contain '\/'/i,
  );
});

test("agent templates are rendered with the selected model and thinking level", () => {
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
