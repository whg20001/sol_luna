# pi-sol-luna-router

A reusable, project-local Pi package that routes implementation work through a Luna worker and provides a two-failure Sol Recovery circuit breaker. It is independent of OpenMythos and does not write global Pi configuration.

## Install

Install this package locally in the project where it should run:

```bash
pi install -l /absolute/path/to/pi-sol-luna-router
```

The providers are intentionally **not** automatic dependencies. Install both providers at project scope:

```bash
pi install -l npm:@tintinweb/pi-subagents@0.16.1
pi install -l npm:@router-for-me/pi-cliproxyapi-provider@1.4.13
```

The CLIProxyAPI provider supplies the exact `cliproxyapi/gpt-5.6-sol` and
`cliproxyapi/gpt-5.6-luna` models used by the templates. Configure its credentials
inside Pi with `/login cliproxyapi`; do not copy, print, or commit API keys. Start
a fresh Pi session (or run `/reload`) after installing or logging in so the model
registry refreshes. The project must be trusted before running commands that
materialize project configuration. Then run:

```text
/sol-luna-init
```

Use `/sol-luna-init --force` only when you intentionally want to replace modified managed files or conflicting managed keys.

## What initialization creates

In the current project's Pi config directory (`<CONFIG_DIR_NAME>`; normally `.pi`) it creates or safely synchronizes:

- `agents/luna-worker.md` — default implementation worker, `cliproxyapi/gpt-5.6-luna`, `xhigh`, 40 turns.
- `agents/sol-worker.md` — one-shot recovery worker, `cliproxyapi/gpt-5.6-sol`, `xhigh`, 40 turns.
- `subagents.json` — merges and preserves unrelated keys while enforcing:
  `disableDefaultAgents: true`, `fallbackSubagent: "none"`, and `strictAgentFiles: true`.
- `sol-luna-router.json` — package/version and managed-file hashes.

The package does not create `APPEND_SYSTEM.md`; protocol instructions are injected dynamically by the extension.

## Commands

- `/sol-luna-init [--force]` — materialize the agents, settings, and marker, then reload Pi.
- `/sol-luna-update [--force]` — safely synchronize package templates, then reload Pi.
- `/sol-luna-status` — report the Agent dependency, exact Sol/Luna model availability in `ctx.modelRegistry`, project files, package version, trust, and session circuit.
- `/sol-luna-remove [--force]` — remove only package-managed agents and marker; preserve unrelated `subagents.json` keys. Modified agent files require `--force`.
- `/sol-luna-reset` — explicitly reset only the current session's circuit state.

Without `--force`, modified templates and conflicting managed JSON keys are never silently overwritten. Interactive Pi sessions may confirm a replacement; headless sessions refuse safely.

## Protocol

Call the `sol_luna_gate` tool at task start, after failed approved validation, and after final validation. Luna is the default implementation worker. The first failed approved validation permits one more Luna attempt. The second opens the circuit, blocks Luna calls/resumes, and permits exactly one new `sol-worker` recovery call. A failed recovery escalates to the user. Parent `edit` and `write` calls are blocked while the package is materialized; parent `bash` remains available for read-only inspection and validation, but must not be used to bypass the write rule.

State is stored in the current Pi session using `appendEntry()` and restored from the current branch on session start. It is not written to global configuration or project files.

## Requirements

- Node `>=22.19`.
- Pi `>=0.84.1 <1` with compatible `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`.
- Separately installed `@tintinweb/pi-subagents@0.16.1` and `@router-for-me/pi-cliproxyapi-provider@1.4.13`.
- `/sol-luna-init` refuses to materialize configuration if the Agent tool or either exact model is missing; install, `/login cliproxyapi`, and `/reload` first.
