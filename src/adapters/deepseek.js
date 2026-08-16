import { createHarnessAdapter } from "./harness.js";

/**
 * DeepSeek harness integration entry point. The caller supplies the concrete
 * runner through invokeWorker; no SDK, model, or credential format is assumed.
 */
export function createDeepSeekAdapter(options = {}) {
  return createHarnessAdapter({
    ...options,
    harnessName: "deepseek",
  });
}

export const createDeepSeekHarnessAdapter = createDeepSeekAdapter;
export default createDeepSeekAdapter;
