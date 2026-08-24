import { randomUUID } from "node:crypto";
import { createDeepSeekAdapter } from "../src/adapters/deepseek.js";

/** Wire the v2 router to an existing DeepSeek harness runner. */
export function wireDeepSeekRouter({
  initialSnapshot,
  lunaBinding,
  validatorBinding,
  solBinding,
  invokeDeepSeek,
  saveSnapshot,
}) {
  return createDeepSeekAdapter({
    snapshot: initialSnapshot,
    taskIdFactory: () => `task-${randomUUID()}`,
    contextIdFactory: ({ taskId }) => `context-${taskId}`,
    workerBindings: {
      luna: lunaBinding,
      ...(validatorBinding === undefined ? {} : { validator: validatorBinding }),
      sol: solBinding,
    },
    invokeWorker: async ({ binding, signal, role, routerState, request, input }) => invokeDeepSeek({
      binding,
      input: request.renderedPrompt,
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
