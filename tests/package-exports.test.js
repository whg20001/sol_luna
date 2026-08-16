import test from "node:test";
import assert from "node:assert/strict";

test("host-independent package subpaths are importable without Pi peers", async () => {
  const [core, modelRouting, service, harness, codex, deepseek] = await Promise.all([
    import("pi-sol-luna-router/core"),
    import("pi-sol-luna-router/model-routing"),
    import("pi-sol-luna-router/router-service"),
    import("pi-sol-luna-router/adapters/harness"),
    import("pi-sol-luna-router/adapters/codex"),
    import("pi-sol-luna-router/adapters/deepseek"),
  ]);

  assert.equal(typeof core.transitionState, "function");
  assert.equal(typeof modelRouting.resolveModelRoutes, "function");
  assert.equal(typeof service.createRouterService, "function");
  assert.equal(typeof harness.createHarnessAdapter, "function");
  assert.equal(typeof codex.createCodexAdapter, "function");
  assert.equal(typeof deepseek.createDeepSeekAdapter, "function");
});
