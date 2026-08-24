import { randomUUID } from "node:crypto";
import { createCodexAdapter } from "../src/adapters/codex.js";

/** Wire the v2 router to an existing Codex CLI/SDK wrapper without assuming its API. */
export function wireCodexRouter({
  initialSnapshot,
  lunaBinding,
  validatorBinding,
  solBinding,
  invokeCodex,
  saveSnapshot,
}) {
  return createCodexAdapter({
    snapshot: initialSnapshot,
    taskIdFactory: () => `task-${randomUUID()}`,
    contextIdFactory: ({ taskId }) => `context-${taskId}`,
    workerBindings: {
      luna: lunaBinding,
      ...(validatorBinding === undefined ? {} : { validator: validatorBinding }),
      sol: solBinding,
    },
    invokeWorker: async ({ binding, signal, role, routerState, request, input }) => invokeCodex({
      binding,
      // Prefer the cache-friendly rendered prompt; input remains available for legacy runners.
      prompt: request.renderedPrompt,
      legacyInput: input,
      signal,
      role,
      routerState,
      budget: request.budget,
      routing: request.routing,
      taskId: request.taskId,
      contextId: request.contextId,
      snapshotId: request.snapshotId,
    }),
    saveSnapshot,
  });
}
