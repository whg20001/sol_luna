import { createHarnessAdapter } from "./harness.js";

/**
 * Codex integration entry point. The caller supplies the concrete Codex CLI or
 * SDK invocation through invokeWorker; this package only enforces routing.
 */
export function createCodexAdapter(options = {}) {
  return createHarnessAdapter({
    ...options,
    harnessName: "codex",
  });
}

export const createCodexHarnessAdapter = createCodexAdapter;
export default createCodexAdapter;
