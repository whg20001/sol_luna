import { randomUUID } from "node:crypto";
import { createCodexAdapter } from "../src/adapters/codex.js";

/** Wire the router to an existing Codex CLI/SDK wrapper without assuming its API. */
export function wireCodexRouter({
  initialSnapshot,
  lunaBinding,
  solBinding,
  invokeCodex,
  saveSnapshot,
}) {
  return createCodexAdapter({
    snapshot: initialSnapshot,
    taskIdFactory: () => `task-${randomUUID()}`,
    workerBindings: {
      luna: lunaBinding,
      sol: solBinding,
    },
    invokeWorker: async ({ binding, input, signal, role, routerState }) => invokeCodex({
      binding,
      prompt: input,
      signal,
      role,
      routerState,
    }),
    saveSnapshot,
  });
}
