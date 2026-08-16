# pi-sol-luna-router

A Sol/Luna implementation router with a two-failure circuit breaker.

The package now has two layers:

- A Pi Coding Agent adapter, kept as the default package entry.
- A host-independent router service plus callback-based Codex, DeepSeek, and generic harness adapters.

The Codex and DeepSeek adapters do not assume a particular vendor SDK, CLI, model, or credential format. The host supplies the actual worker invocation and snapshot persistence callbacks. The package root intentionally remains the Pi adapter for backward compatibility; non-Pi consumers must import one of the documented host-independent subpaths.

## Architecture

```text
src/core.js                 Pure state transitions and policy rules
src/model-routing.js        Ordered multi-provider model selection and rendering
src/router-service.js       Stateful, host-independent router facade
src/adapters/pi.js          Pi lifecycle, tools, commands, files, and UI
src/adapters/harness.js     Generic callback-based harness integration
src/adapters/codex.js       Codex-named harness entry
src/adapters/deepseek.js    DeepSeek-named harness entry
src/index.js                Backward-compatible Pi extension entry
```

## Pi installation

Install this package locally in the project where it should run:

```bash
pi install -l /absolute/path/to/pi-sol-luna-router
```

Install the Pi subagent tool separately:

```bash
pi install -l npm:@tintinweb/pi-subagents@0.16.1
```

Configure at least one model provider in Pi. Built-in providers, `~/.pi/agent/models.json`, and provider extensions are all supported. CLIProxyAPI is optional rather than required:

```bash
pi install -l npm:@router-for-me/pi-cliproxyapi-provider@1.4.13
```

Authenticate configured providers with `/login <provider>`, then start a fresh session or run `/reload`. The project must be trusted before initialization.

```text
/sol-luna-init
```

Use `/sol-luna-init --force` only when intentionally replacing modified managed files or conflicting managed keys.

### Pi project files

Initialization creates or synchronizes files in the project Pi configuration directory, normally `.pi`:

- `agents/luna-worker.md`
- `agents/sol-worker.md`
- `subagents.json`
- `sol-luna-models.json` — user-editable ordered model routes
- `sol-luna-router.json`

The Pi adapter dynamically injects its protocol and stores circuit state in the current Pi session with `appendEntry()`. Existing Pi command names, state entries, and the default `src/index.js` extension entry remain compatible.

### Pi commands

- `/sol-luna-init [--force]`
- `/sol-luna-update [--force]`
- `/sol-luna-status`
- `/sol-luna-remove [--force]`
- `/sol-luna-reset`

Parent `edit` and `write` calls are blocked while the Pi project configuration is materialized. Parent `bash` remains available for read-only inspection and validation and must not be used to bypass that restriction.

### Multi-provider model routing

`/sol-luna-init` creates `.pi/sol-luna-models.json` when a default route resolves successfully. If neither default source is available, create this file manually before retrying initialization. Each role has an ordered candidate list; initialization and update select the first exact `provider/model` currently available in Pi's model registry and pin it in the generated agent frontmatter.

Default routes prefer CLIProxyAPI and fall back to direct OpenAI:

```json
{
  "version": 1,
  "luna": {
    "thinking": "xhigh",
    "candidates": [
      { "provider": "cliproxyapi", "model": "gpt-5.6-luna" },
      { "provider": "openai", "model": "gpt-5.6-luna" }
    ]
  },
  "sol": {
    "thinking": "xhigh",
    "candidates": [
      { "provider": "cliproxyapi", "model": "gpt-5.6-sol" },
      { "provider": "openai", "model": "gpt-5.6-sol" }
    ]
  }
}
```

Candidates can reference any provider known to Pi, including OpenRouter, Ollama, vLLM, DeepSeek gateways, or private provider extensions. Model IDs may contain `/`; provider names may not.

```json
{
  "version": 1,
  "luna": {
    "thinking": "high",
    "candidates": [
      { "provider": "openrouter", "model": "anthropic/claude-sonnet-4" },
      { "provider": "ollama", "model": "qwen2.5-coder:32b" }
    ]
  },
  "sol": {
    "thinking": "high",
    "candidates": [
      { "provider": "openai", "model": "gpt-5.6-sol" },
      { "provider": "local-vllm", "model": "deepseek-ai/DeepSeek-V3" }
    ]
  }
}
```

After editing the file, run `/reload` and `/sol-luna-update`. `/sol-luna-status` shows candidate availability, the currently selected route, and the model pinned in each managed agent. Selection is deterministic at initialization/update time; the parent Agent call must not override it. `/sol-luna-remove` preserves the user-editable model route file.

## Host-independent router service

Importing this subpath does not load the Pi adapter:

```js
import { createRouterService } from "pi-sol-luna-router/router-service";

const router = createRouterService({
  snapshot: previouslyStoredSnapshot,
  taskIdFactory: () => crypto.randomUUID(),
});

router.gate("start_task", { taskLabel: "implement feature" });
const luna = router.prepareWorkerCall({ role: "luna" });

// After the host runs validation:
router.gate("luna_failed", { reason: "approved test command failed" });
```

Important methods:

- `getState()`
- `snapshot()`
- `restore(snapshotOrState)`
- `gate(action, payload)`
- `prepareWorkerCall({ role, resume })`
- `reset()`

Snapshots retain the compatible `{ version: 1, state }` format.

## Generic harness adapter

```js
import { createHarnessAdapter } from "pi-sol-luna-router/adapters/harness";

const router = createHarnessAdapter({
  harnessName: "my-agent-runtime",
  snapshot: previouslyStoredSnapshot,
  taskIdFactory: () => createTaskId(),
  workerBindings: {
    luna: lunaWorkerConfig,
    sol: solWorkerConfig,
  },
  invokeWorker: async ({ role, binding, input, signal, routerState }) => {
    return myHarness.runWorker({ role, binding, input, signal, routerState });
  },
  saveSnapshot: async (snapshot, metadata) => {
    await sessionStore.save(snapshot, metadata);
  },
});

await router.gate("start_task", { taskLabel: "implement feature" });
const lunaResult = await router.invoke("luna", { prompt: "Implement the approved task" });

// Run the real acceptance checks, then explicitly update the gate:
await router.gate("passed");
```

The adapter deliberately does not infer validation success or failure from a worker return value. The parent harness must run its approved checks and call `gate()` explicitly.

For Sol recovery, the adapter persists `sol_started` before invoking the worker. If persistence fails, execution is prevented and state is rolled back. If the worker starts and then throws, the one allowed Sol attempt remains consumed. Operations are serialized within one adapter instance; applications running multiple router instances against the same store should add storage-level compare-and-swap or version checks.

## Codex adapter

```js
import { createCodexAdapter } from "pi-sol-luna-router/adapters/codex";

const router = createCodexAdapter({
  snapshot,
  workerBindings: {
    luna: codexLunaProfile,
    sol: codexSolProfile,
  },
  invokeWorker: ({ binding, input, signal }) => {
    return runCodex({ profile: binding, prompt: input, signal });
  },
  saveSnapshot,
});
```

`runCodex` is supplied by the integrating application and may wrap Codex CLI, an SDK, or an existing internal runner. See `examples/codex-harness.mjs`.

## DeepSeek harness adapter

```js
import { createDeepSeekAdapter } from "pi-sol-luna-router/adapters/deepseek";

const router = createDeepSeekAdapter({
  snapshot,
  workerBindings: {
    luna: deepSeekLunaConfig,
    sol: deepSeekSolConfig,
  },
  invokeWorker: ({ binding, input, signal }) => {
    return deepSeekHarness.run({ config: binding, input, signal });
  },
  saveSnapshot,
});
```

The package does not assume that “DeepSeek” means a specific API shape. See `examples/deepseek-harness.mjs`.

## Protocol

1. Start each task with `start_task`.
2. Use Luna as the default implementation worker.
3. Run approved acceptance and validation commands in the parent harness.
4. The first `luna_failed` permits one more Luna attempt.
5. The second `luna_failed` opens the circuit and blocks Luna calls and resumes.
6. Start exactly one new Sol recovery worker; do not hot-switch or resume Luna.
7. Record final success with `passed` or failed recovery with `sol_failed`.
8. Escalate to the user after failed Sol recovery.

## Security boundary

The generic, Codex, and DeepSeek adapters enforce routing state, but they cannot automatically control an unknown host's filesystem tools. Integrations should enforce parent read-only behavior with sandboxing, capability allowlists, or read-only workspace mounts instead of relying only on prompts.

## Requirements

- Node `>=22.19`.
- Generic/Codex/DeepSeek adapter users need no Pi runtime dependency.
- The Pi adapter requires compatible `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox` packages.
- The Pi workflow requires `@tintinweb/pi-subagents@0.16.1`.
- Model providers are user-selectable; CLIProxyAPI is only one optional route source.

## Validation

```bash
npm run check
```
