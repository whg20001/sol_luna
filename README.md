# pi-sol-luna-router

A policy-driven, cache-friendly, memory-aware, failure-resilient agent runtime for Pi, Codex, DeepSeek, and generic harnesses.

Version 2.1 keeps the reliable Root Planner → Luna Executor → Sol Recovery circuit and incrementally adds:

- Frozen task-level Reasoning Profiles
- Execution Policy Engine
- Root/Worker Context Projection
- Fast/Deep Validator tiers
- Failure Decision Summaries without chain-of-thought
- Opt-in Semantic Memory retrieval
- Dynamic token-budget feedback
- Model performance ranking and lifecycle events

The v2.0 foundations remain unchanged:

- Agent Context Envelope
- Task / Runtime / Artifact / Failure Memory
- Failure Snapshots
- Read-only Validator Agent
- Token Budget Controller
- Per-role model and thinking routing
- Stable prompt prefixes for better prompt/KV-cache reuse

## v2.1 architecture

```text
User
  |
Root Planner (high reasoning, no direct writes)
  |
Execution Policy + Context Projection
  |
Task State + Memory + Feedback Manager
  |
  +--> Luna Executor (frozen medium reasoning, edits)
          |
       Fast Validator (low, read-only)
          |
       Deep Validator (medium, risk/failure triggered)
          |
       pass ------------------------------> passed
          |
       failure -> Failure Snapshot
                    |
               Luna retry (first failure)
                    |
               Sol Recovery (second failure, high reasoning)
                    |
               Validator -> passed / escalated
```

The compatible circuit rule remains: one initial Luna attempt, one Luna retry after the first failed validation, and exactly one new Sol recovery after the second failed validation.

## Modules

```text
src/core.js                 Circuit and compatible v2 stage transitions
src/execution-policy.js     Reasoning Profile freeze and scheduling policy
src/task-memory.js          Runtime/Task/Artifact/Failure/Semantic Memory
src/context-envelope.js     Root/Worker projection and stable serialization
src/prompt-protocol.js      Shared prefix, strict output, Decision Summary
src/token-budget.js         Budgets, feedback adaptation, envelope compaction
src/semantic-memory.js      Opt-in relevant-memory retrieval
src/model-ranking.js        Historical model performance ranking
src/runtime-events.js       Bounded lifecycle analytics events
src/model-routing.js        Multi-provider selection plus optional ranking
src/router-service.js       Stateful host-independent runtime facade
src/adapters/pi.js          Pi lifecycle, tools, commands, and project files
src/adapters/harness.js     Generic callback harness integration
src/adapters/codex.js       Codex-named adapter
src/adapters/deepseek.js    DeepSeek-named adapter
```

## Context Envelope

Every prepared worker receives the same ordered protocol:

```text
Shared fixed protocol prefix
+ Role / runtime protocol
+ Context Envelope
+ Current Task
```

The stable envelope shape is:

```json
{
  "version": "2.0",
  "projection": "worker-artifact",
  "runtime": {
    "task_id": "task-123",
    "context_id": "context-123",
    "snapshot_id": null,
    "request_id": null,
    "role": "luna",
    "version": "2.0",
    "stage": "executing",
    "status": "executing",
    "attempt": 1,
    "validator_mode": null,
    "reasoning_profile": {
      "version": "2.1",
      "complexity": "medium"
    },
    "events": []
  },
  "goal": {
    "objective": "Implement authentication",
    "acceptance": ["npm test passes"],
    "constraints": ["Keep the public API compatible"]
  },
  "state": {
    "completed": [],
    "pending": ["Implement authentication"],
    "blocked": []
  },
  "artifact": {
    "changed_files": [],
    "diff_summary": "",
    "tests": [],
    "worker_reports": [],
    "validation_reports": []
  },
  "failure": null,
  "semantic": null,
  "decision": null
}
```

Memory projection is role-specific:

| Role | Loaded memory |
|---|---|
| Planner | Compact Runtime + Goal + blockers/decision-needed summary |
| Luna | Goal/State + Artifact + explicitly retrieved semantic hints |
| Fast Validator | Acceptance + Artifact |
| Deep Validator | Acceptance + Artifact + State + Failure evidence |
| Sol | Goal/State + Artifact + Failure Snapshot + Decision Summary |

All roles still receive minimal runtime IDs. Event streams, logs, reports, and arrays are bounded before serialization.

## Failure Snapshot

A failed validation creates and persists a snapshot containing:

```json
{
  "snapshot_id": "failure-2",
  "task_id": "task-123",
  "context_id": "context-123",
  "source_role": "luna",
  "attempt": 2,
  "current_progress": ["JWT parser updated"],
  "modified_files": ["src/auth.js"],
  "diff_summary": "Changed expiry comparison",
  "attempt_history": [],
  "current_error": {
    "type": "test_failure",
    "message": "Authentication suite failed",
    "log": "bounded excerpt"
  },
  "validation": {},
  "decision_summary": {
    "attempt_goal": "Fix JWT expiration",
    "approach": "Modify token parser",
    "reason": "Expiry validation failed",
    "evidence": ["authentication test failure"],
    "not_attempted": ["database migration"],
    "next_action": "inspect affected auth files"
  },
  "memory_revision": 7
}
```

Sol preparation is blocked when a v2 task has no current Failure Snapshot. Sol receives the latest snapshot and is instructed to inspect affected files rather than re-read the entire project. `decision_summary` stores an auditable decision trace, never private chain-of-thought.

## Reasoning Profile and Execution Policy

`start_task` selects and freezes one profile for the task:

```json
{
  "version": "2.1",
  "taskId": "task-123",
  "complexity": "medium",
  "roles": {
    "planner": { "thinking": "high" },
    "luna": { "thinking": "medium" },
    "validator": {
      "fast": { "thinking": "low" },
      "deep": { "thinking": "medium" }
    },
    "sol": { "thinking": "high" }
  }
}
```

Later calls cannot change complexity or thinking for the same task. Sol remains high because recovery is a separate role, not an upgraded Luna attempt. `src/execution-policy.js` decides the authorized next action and returns a serializable `PolicyDecision`.

## Fast and Deep validation

- Fast Validator runs syntax-only and Git diff/status checks through `sol_luna_validate`, then independently inspects supplied compile/test/lint evidence. Project scripts are not executed inside the strict Pi read-only boundary.
- A Fast failure advances to Deep Validator without incrementing the Luna failure counter.
- Security, architecture, public API compatibility, and other high-risk constraints select Deep Validator directly.
- Only a failed Deep validation creates the normal implementation Failure Snapshot and advances the Luna/Sol circuit.

## State machine

The legacy `phase` remains in snapshots for compatibility. The v2 `stage` adds detail:

```text
idle
  -> planning
  -> executing
  -> validating
       -> passed
       -> failure_snapshot
            -> executing (one Luna retry)
            -> recovery (one Sol attempt)
                 -> validating
                      -> passed
                      -> escalated
```

Snapshots retain the outer format:

```js
{ version: 1, state: { /* circuit + v2 memory + pending request */ } }
```

Old raw state and `{ version: 1, state }` snapshots are migrated during restore.

## Token and thinking policy

Default output budgets:

| Role | Thinking | Tokens |
|---|---:|---:|
| Planner | high | 4000 |
| Luna | medium | 8000 |
| Validator | low | 2000 |
| Sol | high | 6000 |

`low`, `medium`, and `high` task complexity apply configurable multipliers. The selected complexity is frozen in the Reasoning Profile. Recent role usage feedback can adjust output budgets within a bounded ±25% loop: repeated successful non-truncated calls reduce budget, while failures and truncation increase it. `compactEnvelopeToBudget()` removes old events, truncates logs, and drops old reports/tests before touching task state. Objective, acceptance criteria, and the current error are retained.

## Pi installation

### Project-level install from GitHub

Install both packages with Pi's project-local `-l` flag:

```bash
pi install -l git:github.com/whg20001/sol_luna.git
pi install -l npm:@tintinweb/pi-subagents@0.16.1
```

This writes package declarations to `.pi/settings.json` and installs managed copies under `.pi/`; it does not install either extension globally. After the project is trusted, Pi automatically reconciles missing project packages on startup. Commit `.pi/settings.json` if the same pinned package setup should be shared with a team.

For development from an existing checkout, replace the first command with:

```bash
pi install -l /absolute/path/to/pi-sol-luna-router
```

> **Current npm status:** `pi-sol-luna-router` is not yet published in the public npm registry. A plain `npm install` also does not register a Pi extension. Until this package is published with its Agent dependency bundled, complete project setup intentionally uses the two `pi install -l` commands above.

Authenticate at least one provider, trust the project, and reload Pi when requested. Then initialize the project runtime:

```text
/sol-luna-init
```

When `.pi/sol-luna-models.json` is missing, initialization now discovers authenticated Pi models and writes an explicit v2 route automatically. Selection order is:

1. Available dedicated `gpt-5.6-luna` / `gpt-5.6-sol` routes.
2. The current authenticated Pi model.
3. The first authenticated model in deterministic `provider/model` order.

Planner defaults to inheriting the current Pi model. Existing v1 or v2 route files remain strict and are never silently rewritten or replaced.

Initialization creates or synchronizes:

- `.pi/agents/luna-worker.md`
- `.pi/agents/validator-worker.md`
- `.pi/agents/sol-worker.md`
- `.pi/subagents.json`
- `.pi/sol-luna-models.json`
- `.pi/sol-luna-router.json`

Legacy v1 two-agent markers are recognized and safely upgraded when their recorded files are unchanged. The v2 runtime remains inactive for a legacy materialization until `/sol-luna-update` creates the Validator template.

### Pi commands

- `/sol-luna-init [--force]`
- `/sol-luna-update [--force]`
- `/sol-luna-models` — interactive model configuration wizard
- `/sol-luna-models status`
- `/sol-luna-models auto [--force]`
- `/sol-luna-models reset [--force]`
- `/sol-luna-models set ... [--force]`
- `/sol-luna-token-ui on|off|status|reset`
- `/sol-luna-status`
- `/sol-luna-remove [--force]`
- `/sol-luna-reset`

### Pi tools

- `sol_luna_gate` — starts a task, marks planning ready, and reports runtime status. It cannot record validation outcomes.
- `sol_luna_prepare_worker` — creates the Context Envelope, request IDs, budget, snapshot reference, and rendered prompt.
- `sol_luna_record_result` — records exact Luna/Sol/Validator JSON output and advances state.
- `sol_luna_record_usage` — records observed tokens, latency, success/truncation, and optional model performance.

The required Pi flow is:

1. `sol_luna_gate(action="start_task", ...)`
2. `sol_luna_prepare_worker(role="luna", ...)`
3. Call `Agent(subagent_type="luna-worker", prompt=rendered_prompt)`
4. `sol_luna_record_result(role="luna", report_json=...)`
5. Prepare and call Fast `validator-worker`
6. Record the Fast result; when policy requests it, prepare and call Deep Validator
7. Record usage/model feedback when available
8. Retry Luna once or prepare Sol when the circuit opens

The adapter rewrites a managed Agent call to the exact prepared prompt, applies the routed model and thinking level, and blocks calls that are scheduled, resumed, model/thinking-overridden, unprepared, or dispatched twice. Managed agent templates intentionally omit fixed `model` and `thinking` frontmatter so pi-subagents uses these per-request routed values. Parent `edit`, `write`, and `bash` remain blocked.

The extension adds only a static runtime protocol to the parent system prompt. Dynamic state is returned by tools rather than appended to the system prompt, improving cache stability.

## Model routing

Most users no longer need to edit JSON. Run the interactive command:

```text
/sol-luna-models
```

It presents authenticated models through Pi's UI and lets the user explicitly select Planner mode plus Luna, Validator, and Sol models. Planner, Luna, and Fast Validator thinking can be selected; Sol remains fixed at `high` by the recovery policy. Scripted or non-interactive configuration is also supported:

```text
/sol-luna-models set \
  --planner-mode inherit \
  --luna openai/model-a \
  --validator openai/model-b \
  --sol openai/model-c \
  --luna-thinking medium \
  --validator-thinking low \
  --force
```

Use `/sol-luna-models status` to inspect current routes. `/sol-luna-models auto` creates recommended routes and `/sol-luna-models reset` explicitly replaces an existing file with newly discovered recommendations. Existing files require UI confirmation or `--force` before replacement.

The generated file remains a normal explicit configuration for reproducibility. Advanced users can still edit it directly.

## Project token-share visualization

The optional TUI visualization shows cumulative Sol-Luna token shares for the **current project only**:

```text
P(18%),L(52%),V(20%),S(10%)
```

- `P` — Root Planner usage while orchestrating a Sol-Luna task.
- `L` — managed `luna-worker` usage.
- `V` — managed Fast and Deep `validator-worker` usage combined.
- `S` — managed `sol-worker` recovery usage.

Each role uses `input + output + cacheWrite`; `cacheRead` is deliberately excluded so repeated cached-prefix reads do not distort the shares. Percentages use stable integer rounding and sum to 100 when any project usage exists. If no usage has been recorded, every role displays `0%`.

The visualization is off by default. It renders as a right-aligned line immediately below the editor and never replaces Pi's built-in footer or editor:

```text
/sol-luna-token-ui on
/sol-luna-token-ui off
/sol-luna-token-ui status
/sol-luna-token-ui reset
```

Accounting remains active while the visualization is hidden. Totals persist in `.pi/sol-luna-ui.json`, are isolated by the canonical current-project path, continue across sessions and tasks in that project, and never use Pi's global token totals. Updates use an ownership-tagged project-local lock plus atomic replacement, and an active TUI watches the file so another Pi session in the same project can refresh the displayed shares. `reset` clears only the current project's P/L/V/S counters while preserving visibility and replay-deduplication history; it can also explicitly repair malformed project token JSON without following unsafe paths. It is intentionally separate from `/sol-luna-reset`, which resets only the current session's routing circuit. `/sol-luna-remove` preserves the project token file.

Planner totals are staged at Pi `message_end` and committed from the final `turn_end` assistant usage. Worker dispatches receive a request-specific description and are counted only when pi-subagents lifecycle events match that description, managed role, pending request, and Agent ID. The UI therefore does not rely on the model calling `sol_luna_record_usage`, which remains dedicated to budget and performance feedback.

Version 1 route files remain supported:

```json
{
  "version": 1,
  "luna": {
    "thinking": "medium",
    "candidates": [
      { "provider": "cliproxyapi", "model": "gpt-5.6-luna" },
      { "provider": "openai", "model": "gpt-5.6-luna" }
    ]
  },
  "sol": {
    "thinking": "high",
    "candidates": [
      { "provider": "cliproxyapi", "model": "gpt-5.6-sol" },
      { "provider": "openai", "model": "gpt-5.6-sol" }
    ]
  }
}
```

For v1 files, Planner inherits the parent model and Validator reuses Luna's selected model with `low` thinking.

Version 2 supports all roles and complexity overrides:

```json
{
  "version": 2,
  "planner": { "mode": "inherit", "thinking": "high" },
  "luna": {
    "thinking": "medium",
    "thinkingByComplexity": { "low": "low", "medium": "medium", "high": "high" },
    "candidates": [{ "provider": "openai", "model": "gpt-5.6-luna" }]
  },
  "validator": {
    "thinking": "low",
    "candidates": [{ "provider": "openai", "model": "gpt-5.6-luna" }]
  },
  "sol": {
    "thinking": "high",
    "candidates": [{ "provider": "openai", "model": "gpt-5.6-sol" }]
  }
}
```

Selection first filters exact available `provider/model` candidates. With no performance history it preserves configured order. When a performance store is supplied, available candidates are stably ranked by success, quality, normalized cost, and latency; scorer failures fall back to configured order. Provider names cannot contain `/`; model IDs may.

## Host-independent router service

```js
import { createRouterService } from "pi-sol-luna-router/router-service";

const router = createRouterService({
  snapshot: previouslyStoredSnapshot,
  taskIdFactory: () => crypto.randomUUID(),
  contextIdFactory: ({ taskId }) => `context-${taskId}`,
});

router.gate("start_task", {
  taskLabel: "implement feature",
  objective: "Implement feature",
  acceptance: ["npm test passes"],
  constraints: ["Keep the API compatible"],
});

const prepared = router.prepareWorkerRequest({
  role: "luna",
  instruction: "Implement the approved task",
  complexity: "medium",
});

router.markWorkerDispatched({ role: "luna", requestId: prepared.request.requestId });
const workerJson = await runWorker(prepared.request.renderedPrompt);
router.recordWorkerReport({ role: "luna", requestId: prepared.request.requestId, report: workerJson });
const validator = router.prepareWorkerRequest({ role: "validator", instruction: "Run approved checks" });
router.markWorkerDispatched({ role: "validator", requestId: validator.request.requestId });
router.recordValidation({ role: "luna", requestId: validator.request.requestId, report: validatorJson });
```

Important methods:

- `getState()`
- `getMemory()`
- `getPendingRequest()`
- `getReasoningProfile()` / `getPolicyDecision()`
- `getContextEnvelope({ role, validatorMode })`
- `getFailureSnapshot(snapshotId?)`
- `retrieveRelevantMemory(query)` / `addSemanticMemory(entry)`
- `snapshot()` / `restore()`
- `gate(action, payload)`
- `prepareWorkerRequest(...)`
- `markWorkerDispatched(...)`
- `recordWorkerReport(...)`
- `recordValidation(...)`
- `recordUsageFeedback(...)` / `recordModelFeedback(...)`
- `prepareWorkerCall(...)` — legacy compatibility
- `reset()`

## Generic harness adapter

```js
import { createHarnessAdapter } from "pi-sol-luna-router/adapters/harness";

const runtime = createHarnessAdapter({
  snapshot,
  workerBindings: {
    luna: lunaProfile,
    validator: validatorProfile,
    sol: solProfile,
  },
  invokeWorker: async ({ binding, request, signal }) => {
    return harness.run({
      binding,
      prompt: request.renderedPrompt,
      maxOutputTokens: request.budget.maxOutputTokens,
      signal,
    });
  },
  saveSnapshot,
});

await runtime.gate("start_task", {
  taskLabel: "implement feature",
  acceptance: ["tests pass"],
});
await runtime.invoke("luna", "Implement the approved task");
await runtime.invoke("validator", "Run approved validation");
```

`validator` binding is optional for compatibility. Without it, the host can run checks itself and call the adapter's trusted-host `recordValidation()` method explicitly. The Pi flow always requires a prepared and dispatched Validator result.

The adapter forwards both legacy fields (`binding`, `input`, `routerState`) and v2 fields (`request`, `contextEnvelope`, `taskId`, `contextId`, `snapshotId`, `budget`, `routing`, `renderedPrompt`). Managed output is validated against the role-specific strict JSON schema by default (`strictWorkerOutput: true`); malformed output becomes a recorded failure snapshot rather than a deadlocked pending request. A worker's self-reported success never marks the task passed; only Validator output or explicit trusted-host validation does.

Codex and DeepSeek wrappers are in `examples/`.

## Security and persistence

- Generic adapters cannot enforce filesystem permissions for unknown hosts. Use sandboxes, read-only mounts, or capability allowlists for the parent and Validator.
- Logs and histories are bounded, but integrating hosts should still avoid placing secrets in worker reports.
- Adapter operations are serialized per instance. Multiple instances sharing storage should add compare-and-swap checks using the persisted revision.
- Sol start is persisted before execution. A failed persistence prevents launch; a started Sol attempt is never silently restored.

## Package exports

Host-independent imports do not load Pi peers:

- `pi-sol-luna-router/core`
- `pi-sol-luna-router/router-service`
- `pi-sol-luna-router/context-envelope`
- `pi-sol-luna-router/task-memory`
- `pi-sol-luna-router/prompt-protocol`
- `pi-sol-luna-router/token-budget`
- `pi-sol-luna-router/model-routing`
- `pi-sol-luna-router/adapters/harness`
- `pi-sol-luna-router/adapters/codex`
- `pi-sol-luna-router/adapters/deepseek`

The package root remains the Pi adapter for backward compatibility.

## Requirements and validation

- Node `>=22.19`
- Pi peer packages `>=0.84.1 <1`
- Project-local `@tintinweb/pi-subagents@0.16.1`
- At least one authenticated Pi model; the Sol route must support `high` thinking

```bash
npm run check
npm pack --dry-run
```

The current v2.1 suite contains 111 tests when Pi peer dependencies are available. Pi integration tests skip cleanly in a host-independent install without those peers.

For the complete design, compatibility matrix, security boundaries, and lifecycle specification, see [`MODEL_ARCHITECTURE.md`](./MODEL_ARCHITECTURE.md).
