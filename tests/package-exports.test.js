import test from "node:test";
import assert from "node:assert/strict";

test("host-independent package subpaths are importable without Pi peers", async () => {
  const [core, modelRouting, service, jevRouter, contextEnvelope, taskMemory, promptProtocol, tokenBudget, executionPolicy, semanticMemory, modelRanking, runtimeEvents, harness, codex, deepseek] = await Promise.all([
    import("pi-sol-luna-router/core"),
    import("pi-sol-luna-router/model-routing"),
    import("pi-sol-luna-router/router-service"),
    import("pi-sol-luna-router/jev-router"),
    import("pi-sol-luna-router/context-envelope"),
    import("pi-sol-luna-router/task-memory"),
    import("pi-sol-luna-router/prompt-protocol"),
    import("pi-sol-luna-router/token-budget"),
    import("pi-sol-luna-router/execution-policy"),
    import("pi-sol-luna-router/semantic-memory"),
    import("pi-sol-luna-router/model-ranking"),
    import("pi-sol-luna-router/runtime-events"),
    import("pi-sol-luna-router/adapters/harness"),
    import("pi-sol-luna-router/adapters/codex"),
    import("pi-sol-luna-router/adapters/deepseek"),
  ]);

  assert.equal(typeof core.transitionState, "function");
  assert.equal(typeof modelRouting.resolveModelRoutes, "function");
  assert.equal(typeof service.createRouterService, "function");
  assert.equal(typeof jevRouter.buildJevRequest, "function");
  assert.equal(typeof contextEnvelope.buildContextEnvelope, "function");
  assert.equal(typeof taskMemory.createFailureSnapshot, "function");
  assert.equal(typeof promptProtocol.renderWorkerPrompt, "function");
  assert.equal(typeof tokenBudget.resolveTokenBudget, "function");
  assert.equal(typeof executionPolicy.evaluateExecutionPolicy, "function");
  assert.equal(typeof semanticMemory.retrieveSemanticMemory, "function");
  assert.equal(typeof modelRanking.rankModelCandidates, "function");
  assert.equal(typeof runtimeEvents.emitRuntimeEvent, "function");
  assert.equal(typeof harness.createHarnessAdapter, "function");
  assert.equal(typeof codex.createCodexAdapter, "function");
  assert.equal(typeof deepseek.createDeepSeekAdapter, "function");
});
