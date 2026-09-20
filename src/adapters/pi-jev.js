import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { jevRequestKey } from "../jev-router.js";
import { workerOutputSchemaForRole } from "../prompt-protocol.js";

/** Tool-mediated bridge: reuse TypeSafe consent, credentials, budgets and timeout.
 * No direct HTTP calls, key access, or model-granted capabilities live here.
 */
export function registerJevRouting(pi, { router, assertEnabled, persist, resolveLunaRouting, isJevEnabled = () => true }) {
  const evaluations = new Map();
  const notices = new Set();
  const retiredQueries = new Set();
  const availability = (ctx) => {
    try {
      if (!isJevEnabled(ctx)) return { available: false, reason: "jev_disabled", notice: "Jev/TypeSafe routing is disabled for this project. Using the original serial strategy. Other plugins may still use TypeSafe. Enable this plugin's routing explicitly with /sol-luna-jev on if wanted." };
    } catch {
      return { available: false, reason: "jev_config_invalid", notice: "Jev routing preference is invalid or unsafe. Using the original serial strategy without a Jev request. Inspect sol-luna-jev.json or explicitly repair a regular file using /sol-luna-jev on|off; symlinks are refused." };
    }
    try {
      if (typeof pi.getAllTools !== "function") throw new Error("Tool discovery unavailable.");
      if (!pi.getAllTools().some((tool) => tool.name === "typesafe_evaluate")) {
        return { available: false, reason: "typesafe_missing", notice: "TypeSafe's typesafe_evaluate tool is not installed or loaded in this session. Using the original serial Planner → Luna → Validator / Sol strategy. Optional installation: pi install -l npm:pi-typesafe, then /reload and TypeSafe authentication/consent setup. No automatic installation or external request." };
      }
      if (typeof pi.getActiveTools === "function" && !pi.getActiveTools().includes("typesafe_evaluate")) {
        return { available: false, reason: "typesafe_inactive", notice: "typesafe_evaluate is registered but not active in this session. Using the original serial strategy; restore the tool to use Jev. No reinstallation or automatic activation is needed." };
      }
      return { available: true };
    } catch {
      return { available: false, reason: "typesafe_discovery_unavailable", notice: "TypeSafe tool availability could not be checked. Using the original serial strategy without an external request; check the loaded extensions before enabling Jev routing." };
    }
  };
  const fallbackToLegacy = (ctx) => {
    const status = availability(ctx);
    if (status.available) return null;
    // A tool may disappear after reload or after an assessment was prepared.
    // Release only the judgment wait, never active executors or their reports.
    const pending = router.getOrchestration().jev?.pending;
    if (pending) {
      const update = router.recordJevAssessment({ assessmentId: pending.assessmentId, response: null, failureReason: "evaluation_unavailable" });
      persist(update.previousSnapshot);
      retiredQueries.add(pending.key);
      if (retiredQueries.size > 32) retiredQueries.delete(retiredQueries.values().next().value);
      evaluations.clear();
    }
    return { source: "policy", advisoryOnly: true, strategy: "legacy", recommendation: "plan_act", ...status,
      next: "Use sol_luna_gate to start/inspect the task, then the existing serial prepare_worker → Agent → record_result → Validator flow. Keep the original retry/Sol recovery rules. Do not wait for Jev, auto-enable direct execution, or launch a new parallel batch." };
  };
  const result = (details) => {
    const text = JSON.stringify(details);
    if (Buffer.byteLength(text) > 48 * 1024) throw new Error("Routing output exceeds 48 KiB; use shorter summaries or fewer subtasks. No partial prompts will be dispatched.");
    return { content: [{ type: "text", text }], details };
  };
  const summary = () => {
    const state = router.getOrchestration();
    return {
      ...state,
      jev: { ...state.jev, pending: state.jev?.pending ? { assessmentId: state.jev.pending.assessmentId, kind: state.jev.pending.kind } : null },
      requests: state.requests.map(({ requestId, subtaskId, dispatched, writeScopes }) => ({ requestId, subtaskId, dispatched, writeScopes })),
      reports: state.reports.map(({ requestId, subtaskId, report }) => ({ requestId, subtaskId, status: report.status })),
    };
  };
  const commit = (update, details) => {
    let reply;
    try {
      reply = result(details);
    } catch (error) {
      router.restore(update.previousSnapshot);
      throw error;
    }
    // Pi's persistState owns rollback for storage failures; this bridge owns
    // rollback only when result construction fails before persistence.
    persist(update.previousSnapshot);
    return reply;
  };
  pi.registerTool({
    name: "sol_luna_route",
    label: "Jev Task Routing",
    description: "Prepare Jev advisory questions, explicitly select main-agent direct execution, or prepare isolated parallel executors. Does not call external services itself. If Jev routing is disabled or typesafe_evaluate is missing or inactive, immediately use the original serial strategy without a pending assessment. Copy evaluation_request unchanged to typesafe_evaluate; its actual tool result is correlated automatically. Submit only a permitted task summary, never secrets. Context compression is unchanged.",
    promptSnippet: "Assess workflows with Jev and select direct or isolated parallel execution",
    parameters: Type.Object({
      action: StringEnum(["entry", "parallel", "direct", "dispatch_parallel", "complete", "executor_failed", "cancel_assessment", "status"]),
      summary: Type.Optional(Type.String({ maxLength: 4000, description: "User-permitted task summary to send externally; no source files, credentials, or conversation history." })),
      reason: Type.Optional(Type.String({ maxLength: 2000, description: "Main agent's explicit mode/dispatch decision, not model confidence as authorization." })),
      subtasks: Type.Optional(Type.Array(Type.Object({
        id: Type.String(), instruction: Type.String(),
        acceptance: Type.Array(Type.String()),
        writeScopes: Type.Array(Type.String()),
        dependsOn: Type.Array(Type.String()),
      }), { minItems: 2, maxItems: 8 })),
      request_id: Type.Optional(Type.String({ description: "Dispatched parallel request ID, for reporting an observed executor failure." })),
      report_json: Type.Optional(Type.String({ description: "Main-agent implementation or integration report, matching the Luna output schema." })),
      validation_json: Type.Optional(Type.String({ description: "Optional main-agent verification report in the Validator schema, for low-risk direct tasks only. Parallel integration requires independent validation." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      assertEnabled(ctx);
      if (params.action === "status") return result({ ...summary(), typesafe: availability(ctx) });
      if (["entry", "parallel", "dispatch_parallel"].includes(params.action)) {
        const fallback = fallbackToLegacy(ctx);
        if (fallback) return result(fallback);
      }
      let update;
      if (["entry", "parallel"].includes(params.action)) {
        update = router.prepareJevAssessment({ kind: params.action, summary: params.summary, subtasks: params.subtasks });
        return commit(update, { assessment_id: update.assessmentId, evaluation_request: update.request, next: "Call typesafe_evaluate with evaluation_request unchanged. Jev provides advice only; choose an execution mode explicitly afterwards. If TypeSafe is unavailable, cancel_assessment and let the main agent decide." });
      }
      if (params.action === "cancel_assessment") {
        const pending = router.getOrchestration().jev?.pending;
        if (!pending) throw new Error("No Jev assessment is pending.");
        update = router.recordJevAssessment({ assessmentId: pending.assessmentId, response: null, failureReason: "cancelled" });
      } else if (params.action === "direct") {
        update = router.startDirectExecution({ reason: params.reason });
      } else if (params.action === "dispatch_parallel") {
        const assessmentId = router.getOrchestration().jev?.parallel?.assessmentId;
        const head = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: ctx.cwd, signal });
        const status = await pi.exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: ctx.cwd, signal });
        if (head.code !== 0 || status.code !== 0 || status.stdout?.trim()) throw new Error("Parallel worktrees require a clean, committed repository baseline. Commit or explicitly preserve current changes before dispatch; do not stash or discard user work automatically.");
        assertEnabled(ctx);
        const fallback = fallbackToLegacy(ctx);
        if (fallback) return result(fallback);
        signal?.throwIfAborted();
        if (router.getOrchestration().jev?.parallel?.assessmentId !== assessmentId) throw new Error("Parallel plan changed during repository checks; review the current plan first.");
        update = router.prepareParallelExecution({ reason: params.reason, routing: resolveLunaRouting(ctx) });
      } else if (params.action === "executor_failed") {
        update = router.recordExecutorFailure({ requestId: params.request_id, reason: params.reason });
      } else if (params.action === "complete") {
        update = router.finishParentExecution({ report: JSON.parse(params.report_json), ...(params.validation_json === undefined ? {} : { validation: JSON.parse(params.validation_json) }) });
      } else throw new Error("Unknown routing action.");
      return commit(update, {
        orchestration: summary(), state: router.getState(),
        ...(update.requests ? { requests: update.requests.map(({ requestId, subtaskId, renderedPrompt, isolation }) => ({ requestId, subtaskId, renderedPrompt, isolation })), next: "Launch every request using luna-worker, its exact renderedPrompt, isolation: worktree, and run_in_background: true in one batch. Record each result with its request_id. After all succeed, integrate their worktrees and submit complete, then run the independent Validator." } : {}),
        ...(params.action === "direct" ? {
          next: "The main agent may implement and test directly. Submit complete with these report schemas. Without self-verification, or for high-risk work, run the independent Validator afterwards.",
          implementation_schema: workerOutputSchemaForRole("luna"), validation_schema: workerOutputSchemaForRole("validator"),
        } : {}),
      });
    },
  });
  return {
    clear: () => evaluations.clear(),
    resetSession: () => { notices.clear(); retiredQueries.clear(); evaluations.clear(); },
    fallbackToLegacy,
    noticeOnce(ctx, fallback) {
      if (!fallback) return undefined;
      const key = `${ctx?.cwd ?? ""}:${fallback.reason}`;
      if (notices.has(key)) return undefined;
      notices.add(key);
      return { customType: "sol-luna-typesafe-optional", content: fallback.notice, display: true };
    },
    toolCall(event, ctx) {
      if (event.toolName !== "typesafe_evaluate") return;
      const pending = router.getOrchestration().jev?.pending;
      if (!pending && !retiredQueries.size) return;
      const key = jevRequestKey(event.input);
      if (retiredQueries.has(key)) {
        const status = availability(ctx);
        if (!status.available) return { block: true, reason: status.notice };
      }
      if (!pending || key !== pending.key) return;
      const fallback = fallbackToLegacy(ctx);
      if (fallback) return { block: true, reason: fallback.notice };
      if ([...evaluations.values()].includes(pending.assessmentId)) return { block: true, reason: "This Jev assessment is already in flight." };
      if (!event.toolCallId) return { block: true, reason: "Jev routing requires a correlated tool call ID." };
      evaluations.set(event.toolCallId, pending.assessmentId);
    },
    toolResult(event, ctx) {
      if (event.toolName !== "typesafe_evaluate") return;
      const assessmentId = evaluations.get(event.toolCallId);
      if (!assessmentId) return;
      evaluations.delete(event.toolCallId);
      try { assertEnabled(ctx); } catch { return; }
      if (fallbackToLegacy(ctx)) return;
      if (router.getOrchestration().jev?.pending?.assessmentId !== assessmentId) return;
      let response = event.details;
      if (!response?.answers && !event.isError) {
        try { response = JSON.parse(event.content?.filter((part) => part.type === "text").map((part) => part.text).join("")); } catch { response = null; }
      }
      const update = router.recordJevAssessment({ assessmentId, response: event.isError ? null : response, failureReason: event.isError ? "evaluation_unavailable" : undefined });
      persist(update.previousSnapshot);
      return {
        content: [...(event.content ?? []), { type: "text", text: `Jev routing advice (not permission): ${JSON.stringify(update.advice)}` }],
        details: { ...event.details, routingAdvice: update.advice },
      };
    },
  };
}
