import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  AGENT_NAMES,
  MANAGED_MARKER,
  MANAGED_SUBAGENT_VALUES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  STATE_ENTRY_TYPE,
  canInvokeAgent,
  findSubagentsConflicts,
  formatState,
  hasExactAvailableModel,
  hasManagedMarker,
  initialState,
  isMaterialized,
  isPlainObject,
  managedFileDecision,
  mergeSubagents,
  normalizeState,
  removeManagedSubagents,
  transitionState,
} from "./core.js";

const AGENT_INSTALL_COMMAND = "pi install -l npm:@tintinweb/pi-subagents@0.16.1";
const CLIPROXY_INSTALL_COMMAND = "pi install -l npm:@router-for-me/pi-cliproxyapi-provider@1.4.13";
const REQUIRED_MODELS = Object.freeze([
  Object.freeze({ label: "Sol", provider: "cliproxyapi", model: "gpt-5.6-sol" }),
  Object.freeze({ label: "Luna", provider: "cliproxyapi", model: "gpt-5.6-luna" }),
]);
const AGENT_TEMPLATE_URLS = Object.freeze({
  "agents/luna-worker.md": new URL("../templates/agents/luna-worker.md", import.meta.url),
  "agents/sol-worker.md": new URL("../templates/agents/sol-worker.md", import.meta.url),
});

function projectPaths(cwd) {
  const configDir = join(cwd, CONFIG_DIR_NAME);
  return {
    configDir,
    agentsDir: join(configDir, "agents"),
    subagents: join(configDir, "subagents.json"),
    marker: join(configDir, "sol-luna-router.json"),
    luna: join(configDir, "agents", "luna-worker.md"),
    sol: join(configDir, "agents", "sol-worker.md"),
  };
}

function lstatOrUndefined(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRegularPath(path, { allowMissing = true } = {}) {
  const stat = lstatOrUndefined(path);
  if (!stat && allowMissing) return false;
  if (!stat) throw new Error(`Missing required path: ${path}`);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symbolic link: ${path}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  return true;
}

function assertDirectory(path) {
  const stat = lstatOrUndefined(path);
  if (!stat) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const checked = lstatOrUndefined(path);
  if (!checked || checked.isSymbolicLink() || !checked.isDirectory()) {
    throw new Error(`Refusing unsafe project configuration directory: ${path}`);
  }
}

function readText(path) {
  if (!assertRegularPath(path)) return undefined;
  return readFileSync(path, "utf8");
}

function readJson(path, { defaultValue } = {}) {
  const text = readText(path);
  if (text === undefined) return defaultValue;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} must contain a JSON object.`);
  return parsed;
}

function writeAtomic(path, content) {
  assertRegularPath(path);
  const temp = join(dirname(path), `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write error if cleanup itself fails.
    }
  }
}

function removeRegularFile(path) {
  if (!assertRegularPath(path)) return false;
  unlinkSync(path);
  return true;
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function templateContents() {
  return Object.fromEntries(
    Object.entries(AGENT_TEMPLATE_URLS).map(([relative, url]) => [relative, readFileSync(url, "utf8")]),
  );
}

function makeMarker(templates) {
  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    managedMarker: MANAGED_MARKER,
    managedFiles: Object.fromEntries(Object.entries(templates).map(([relative, content]) => [relative, sha256(content)])),
  };
}

function validMarker(marker) {
  if (!isPlainObject(marker)) return false;
  if (marker.package !== PACKAGE_NAME || marker.managedMarker !== MANAGED_MARKER) return false;
  if (!isPlainObject(marker.managedFiles)) return false;
  const expectedFiles = AGENT_NAMES.map((name) => `agents/${name}.md`);
  if (Object.keys(marker.managedFiles).some((relative) => !expectedFiles.includes(relative))) return false;
  return expectedFiles.every((relative) => {
    const hash = marker.managedFiles[relative];
    return typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash);
  });
}

function materialization(cwd) {
  try {
    const paths = projectPaths(cwd);
    return isMaterialized({
      markerExists: Boolean(assertRegularPath(paths.marker)),
      lunaExists: Boolean(assertRegularPath(paths.luna)),
      solExists: Boolean(assertRegularPath(paths.sol)),
    });
  } catch {
    return false;
  }
}

function hasAgentTool(pi) {
  return pi.getAllTools().some((tool) => tool?.name === "Agent");
}

function modelIsAvailable(ctx, { provider, model }) {
  const registry = ctx.modelRegistry;
  try {
    if (typeof registry?.getAvailable === "function") {
      return hasExactAvailableModel(registry.getAvailable(), { provider, model });
    }

    // Compatibility for older registry facades: a catalog hit is insufficient
    // unless the exact model also has configured authentication.
    if (typeof registry?.find !== "function" || typeof registry?.hasConfiguredAuth !== "function") {
      return false;
    }
    const found = registry.find(provider, model);
    return hasExactAvailableModel(found ? [found] : [], { provider, model })
      && registry.hasConfiguredAuth(found);
  } catch {
    return false;
  }
}

function missingAgentMessage() {
  return `The @tintinweb/pi-subagents Agent tool is not installed. Install it separately with:\n${AGENT_INSTALL_COMMAND}`;
}

function missingModelMessage(missing) {
  const names = missing.map(({ label, provider, model }) => `${label} (${provider}/${model})`).join(", ");
  return [
    `Required Sol-Luna model(s) are unavailable in ctx.modelRegistry: ${names}.`,
    `Install the provider with: ${CLIPROXY_INSTALL_COMMAND}`,
    "Configure credentials in Pi with: /login cliproxyapi",
    "Then refresh the model registry with: /reload (or start a fresh Pi session).",
    "No credentials are read or copied by pi-sol-luna-router.",
  ].join("\n");
}

function requiredModelStatus(ctx) {
  return REQUIRED_MODELS.map((entry) => ({ ...entry, available: modelIsAvailable(ctx, entry) }));
}

function notify(ctx, message, level = "info") {
  ctx.ui.notify(message, level);
}

function forceRequested(args) {
  return String(args ?? "").trim().split(/\s+/u).includes("--force");
}

async function confirmConflicts(ctx, descriptions, force) {
  if (force || descriptions.length === 0) return true;
  if (!ctx.hasUI) return false;
  return ctx.ui.confirm(
    "Overwrite project configuration?",
    `The following managed values differ from the package template:\n${descriptions.map((item) => `- ${item}`).join("\n")}\nContinue only if you intend to replace them.`,
  );
}

function requireTrusted(ctx) {
  if (ctx.isProjectTrusted()) return true;
  notify(ctx, "Project is not trusted; refusing to write project-local Sol-Luna configuration. Trust the project first.", "error");
  return false;
}

function ensureProjectDirectories(cwd) {
  const paths = projectPaths(cwd);
  assertDirectory(paths.configDir);
  assertDirectory(paths.agentsDir);
  return paths;
}

function readMarker(paths) {
  const marker = readJson(paths.marker, { defaultValue: undefined });
  return marker;
}

async function syncProject(pi, ctx, force, operation) {
  if (!requireTrusted(ctx)) return;
  if (!hasAgentTool(pi)) {
    notify(ctx, missingAgentMessage(), "error");
    return;
  }

  const missingModels = requiredModelStatus(ctx).filter((entry) => !entry.available);
  if (missingModels.length > 0) {
    notify(ctx, missingModelMessage(missingModels), "error");
    return;
  }

  const paths = ensureProjectDirectories(ctx.cwd);
  const marker = readMarker(paths);
  if (marker !== undefined && !validMarker(marker)) {
    notify(ctx, "Invalid Sol-Luna router marker; refusing to overwrite project files. Remove it deliberately or repair it first.", "error");
    return;
  }
  const templates = templateContents();
  const existingFiles = Object.fromEntries(
    Object.entries(templates).map(([relative]) => {
      const path = join(paths.configDir, relative);
      const content = readText(path);
      return [relative, { path, content }];
    }),
  );
  const fileConflicts = Object.entries(existingFiles)
    .filter(([relative, item]) => managedFileDecision(item.content, templates[relative], {
      force,
      currentHash: item.content === undefined ? undefined : sha256(item.content),
      managedHash: marker?.managedFiles?.[relative],
    }).action === "conflict")
    .map(([relative]) => relative);

  const subagents = readJson(paths.subagents, { defaultValue: {} });
  let subagentMerge = mergeSubagents(subagents, { force });
  const conflicts = [
    ...fileConflicts.map((relative) => `${relative} (agent template)`),
    ...subagentMerge.conflicts.map((key) => `subagents.json:${key}`),
  ];
  if (!subagentMerge.ok || fileConflicts.length > 0) {
    const confirmed = await confirmConflicts(ctx, conflicts, force);
    if (!confirmed) {
      notify(
        ctx,
        ctx.hasUI ? "Configuration update cancelled; no project files were changed." : `Configuration update refused without UI. Re-run with --force to replace: ${conflicts.join(", ")}`,
        "warning",
      );
      return;
    }
    subagentMerge = mergeSubagents(subagents, { force: true });
  }

  for (const [relative, item] of Object.entries(existingFiles)) {
    const desired = templates[relative];
    const decision = managedFileDecision(item.content, desired, { force: true });
    if (decision.action !== "skip") writeAtomic(item.path, desired);
  }
  writeAtomic(paths.subagents, jsonText(subagentMerge.value));
  writeAtomic(paths.marker, jsonText(makeMarker(templates)));

  notify(ctx, `${operation} complete: ${CONFIG_DIR_NAME}/agents/luna-worker.md, ${CONFIG_DIR_NAME}/agents/sol-worker.md, ${CONFIG_DIR_NAME}/subagents.json, and ${CONFIG_DIR_NAME}/sol-luna-router.json are synchronized.`, "success");
  await ctx.reload();
}

function safePresence(path) {
  try {
    return assertRegularPath(path) ? "present" : "missing";
  } catch {
    return "unsafe";
  }
}

function statusReport(pi, ctx, state) {
  const paths = projectPaths(ctx.cwd);
  let markerLine = "missing";
  try {
    const marker = readMarker(paths);
    if (marker === undefined) markerLine = "missing";
    else if (!validMarker(marker)) markerLine = "invalid";
    else markerLine = `${marker.version ?? "unknown"} (valid)`;
  } catch (error) {
    markerLine = `error (${error instanceof Error ? error.message : String(error)})`;
  }
  const modelLines = requiredModelStatus(ctx).map(
    ({ label, provider, model, available }) => `${label} model ${provider}/${model}: ${available ? "available" : "missing"}`,
  );
  const report = [
    `pi-sol-luna-router ${PACKAGE_VERSION}`,
    `Project trusted: ${ctx.isProjectTrusted()}`,
    `Agent dependency: ${hasAgentTool(pi) ? "present" : `missing — install with: ${AGENT_INSTALL_COMMAND}`}`,
    ...modelLines,
    `Marker: ${markerLine}`,
    `luna-worker.md: ${safePresence(paths.luna)}`,
    `sol-worker.md: ${safePresence(paths.sol)}`,
    `subagents.json: ${safePresence(paths.subagents)}`,
    `Circuit: ${formatState(state)}`,
  ].join("\n");
  notify(ctx, report, "info");
}

function stateFromBranch(ctx) {
  let latest;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) latest = entry.data;
  }
  return normalizeState(latest?.state ?? latest);
}

function resultText(text, state) {
  return {
    content: [{ type: "text", text }],
    details: { state: normalizeState(state) },
  };
}

const SYSTEM_PROTOCOL = `

## Sol-Luna Router Protocol
- Sol is the primary orchestrator. Keep planning, coordination, and user communication in the parent session.
- Luna is the default implementation worker. Delegate implementation to a new Agent call with subagent_type "luna-worker", inherit_context false, and run_in_background false. Do not use direct parent edit/write tools.
- Use bash in the parent only for read-only inspection or approved validation; never use bash redirection or scripts to bypass the parent write restriction.
- Before a new task, call sol_luna_gate with action start_task and a useful task label. After Luna reports, run the approved acceptance and validation commands.
- If implementation fails the approved acceptance criteria or validation, call sol_luna_gate with action luna_failed and an evidence-based reason. The first failure permits one more Luna implementation attempt. The second failure immediately opens the circuit.
- When the circuit is open, do not call or resume luna-worker. Start exactly one new sol-worker Agent call for recovery; do not hot-switch an existing Luna session. The gate records this attempt before execution.
- If Sol Recovery fails, call sol_luna_gate with action sol_failed and a reason, then ask the user to decide. If validation passes, call action passed.
- sol_luna_gate has no model-callable reset action. Only the user may use /sol-luna-reset to reset this session's circuit.
- Never bypass a blocked write or Agent call with bash. The gate is authoritative.
`;

export default function (pi) {
  let state = initialState();

  pi.on("session_start", (_event, ctx) => {
    state = stateFromBranch(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!materialization(ctx.cwd)) return;
    return { systemPrompt: `${_event.systemPrompt}${SYSTEM_PROTOCOL}\nCurrent gate state: ${formatState(state)}` };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!materialization(ctx.cwd)) return;

    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: "Parent direct edit/write is blocked by pi-sol-luna-router. Delegate implementation to luna-worker or the one permitted sol-worker recovery. Bash must not be used to bypass this rule.",
      };
    }

    if (event.toolName !== "Agent") return;
    const input = event.input ?? {};
    const agentType = typeof input.subagent_type === "string" ? input.subagent_type : "";
    const verdict = canInvokeAgent(state, agentType, { resume: Boolean(input.resume) });
    if (!verdict.allowed) return { block: true, reason: verdict.reason };

    if (agentType.trim().toLowerCase() === "sol-worker") {
      try {
        state = transitionState(state, "sol_started");
        pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, state });
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    }
  });

  pi.registerTool({
    name: "sol_luna_gate",
    label: "Sol-Luna Gate",
    description: "Track Sol-Luna implementation validation and enforce the two-failure recovery circuit.",
    promptSnippet: "Track Luna validation and the Sol Recovery circuit",
    promptGuidelines: [
      "Use sol_luna_gate at task start, after every failed approved Luna validation, and after final validation; do not invent a reset action.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start_task", "luna_failed", "passed", "sol_failed", "status"]),
      task_label: Type.Optional(Type.String({ description: "Short label for a new task." })),
      task_id: Type.Optional(Type.String({ description: "Stable task identifier for a new task." })),
      reason: Type.Optional(Type.String({ description: "Evidence for a validation or recovery failure." })),
    }),
    async execute(_toolCallId, params) {
      if (params.action === "status") return resultText(formatState(state), state);
      let next;
      if (params.action === "start_task") {
        next = transitionState(state, "start_task", {
          taskId: params.task_id ?? `task-${randomUUID()}`,
          taskLabel: params.task_label,
        });
      } else {
        next = transitionState(state, params.action, { reason: params.reason });
      }
      state = next;
      pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, state });
      return resultText(`Gate updated: ${formatState(state)}`, state);
    },
  });

  pi.registerCommand("sol-luna-init", {
    description: "Initialize Sol-Luna project agents and routing policy",
    handler: async (args, ctx) => {
      try {
        await syncProject(pi, ctx, forceRequested(args), "Sol-Luna initialization");
      } catch (error) {
        notify(ctx, `Sol-Luna initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-update", {
    description: "Safely update Sol-Luna project agents from package templates",
    handler: async (args, ctx) => {
      try {
        await syncProject(pi, ctx, forceRequested(args), "Sol-Luna update");
      } catch (error) {
        notify(ctx, `Sol-Luna update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-status", {
    description: "Show Sol-Luna dependency, files, version, and circuit status",
    handler: async (_args, ctx) => {
      try {
        statusReport(pi, ctx, state);
      } catch (error) {
        notify(ctx, `Sol-Luna status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-remove", {
    description: "Remove only Sol-Luna-managed project files and settings",
    handler: async (args, ctx) => {
      if (!requireTrusted(ctx)) return;
      const force = forceRequested(args);
      try {
        const paths = projectPaths(ctx.cwd);
        const marker = readMarker(paths);
        if (marker === undefined) {
          notify(ctx, "No Sol-Luna router marker found; nothing was removed.", "info");
          return;
        }
        if (!validMarker(marker)) {
          notify(ctx, "Invalid Sol-Luna router marker; refusing removal to avoid deleting user files.", "error");
          return;
        }
        const modified = [];
        for (const name of AGENT_NAMES) {
          const path = join(paths.agentsDir, `${name}.md`);
          const content = readText(path);
          if (content === undefined) continue;
          const managed = hasManagedMarker(content) && sha256(content) === marker.managedFiles[`agents/${name}.md`];
          if (!managed && !force) modified.push(`agents/${name}.md`);
        }
        if (modified.length > 0) {
          notify(ctx, `Refusing to remove modified agent files without --force: ${modified.join(", ")}`, "warning");
          return;
        }

        const subagents = readJson(paths.subagents, { defaultValue: undefined });
        if (subagents !== undefined) {
          const cleaned = removeManagedSubagents(subagents);
          if (JSON.stringify(cleaned) !== JSON.stringify(subagents)) writeAtomic(paths.subagents, jsonText(cleaned));
        }
        for (const name of AGENT_NAMES) removeRegularFile(join(paths.agentsDir, `${name}.md`));
        removeRegularFile(paths.marker);
        notify(ctx, "Removed Sol-Luna-managed agents and marker; unrelated project configuration was preserved.", "success");
        await ctx.reload();
      } catch (error) {
        notify(ctx, `Sol-Luna removal failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-reset", {
    description: "Reset the current session's Sol-Luna circuit state",
    handler: async (_args, ctx) => {
      state = initialState();
      pi.appendEntry(STATE_ENTRY_TYPE, { version: 1, state });
      notify(ctx, "Sol-Luna circuit reset for the current session only.", "info");
    },
  });
}
