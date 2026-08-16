import { randomUUID } from "node:crypto";
import { createDeepSeekAdapter } from "../src/adapters/deepseek.js";

/** Wire the router to an existing DeepSeek harness runner. */
export function wireDeepSeekRouter({
  initialSnapshot,
  lunaBinding,
  solBinding,
  invokeDeepSeek,
  saveSnapshot,
}) {
  return createDeepSeekAdapter({
    snapshot: initialSnapshot,
    taskIdFactory: () => `task-${randomUUID()}`,
    workerBindings: {
      luna: lunaBinding,
      sol: solBinding,
    },
    invokeWorker: async ({ binding, input, signal, role, routerState }) => invokeDeepSeek({
      binding,
      input,
      signal,
      role,
      routerState,
    }),
    saveSnapshot,
  });
}
