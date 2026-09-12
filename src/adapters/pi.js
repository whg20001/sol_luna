import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  AGENT_NAMES,
  LEGACY_AGENT_NAMES,
  LEGACY_MANAGED_MARKER,
  MANAGED_MARKER,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  STATE_ENTRY_TYPE,
  findSubagentsConflicts,
  formatState,
  hasExactAvailableModel,
  hasManagedMarker,
  isMaterialized,
  isPlainObject,
  managedFileDecision,
  mergeSubagents,
  normalizeState,
  removeManagedSubagents,
} from "../core.js";
import {
  THINKING_LEVELS,
  WORKER_ROUTE_ROLES,
  buildAutoModelRoutes,
  modelReference,
  normalizeModelRoutes,
  resolveModelRoutes,
} from "../model-routing.js";
import { CACHE_FRIENDLY_PROTOCOL_PREFIX, validateWorkerOutput } from "../prompt-protocol.js";
import { createRouterService } from "../router-service.js";
import {
  formatProjectTokenShares,
  initialProjectTokenState,
  normalizeProjectTokenState,
  projectTokenPercentages,
  recordProjectTokenUsage,
  resetProjectTokenTotals,
  setProjectTokenVisibility,
  tokenTotalFromUsage,
  tokenTotalFromWorkerEvent,
} from "../token-share.js";

const AGENT_INSTALL_COMMAND = "pi install -l npm:@tintinweb/pi-subagents@0.16.1";
const MODEL_ROUTES_FILE = "sol-luna-models.json";
const RUNTIME_FILE = "sol-luna-runtime.json";
const RUNTIME_VERSION = 1;
const TOKEN_UI_FILE = "sol-luna-ui.json";
const TOKEN_UI_WIDGET = "sol-luna-token-ui";
const MANAGED_WORKER_ROLES = new Map([
  ["luna-worker", "luna"],
  ["validator-worker", "validator"],
  ["sol-worker", "sol"],
]);
const AGENT_TEMPLATE_URLS = Object.freeze({
  "agents/luna-worker.md": new URL("../../templates/agents/luna-worker.md", import.meta.url),
  "agents/validator-worker.md": new URL("../../templates/agents/validator-worker.md", import.meta.url),
  "agents/sol-worker.md": new URL("../../templates/agents/sol-worker.md", import.meta.url),
});
function projectPaths(cwd) {
  const configDir = join(cwd, CONFIG_DIR_NAME);
  return {
    configDir,
    agentsDir: join(configDir, "agents"),
    subagents: join(configDir, "subagents.json"),
    marker: join(configDir, "sol-luna-router.json"),
    modelRoutes: join(configDir, MODEL_ROUTES_FILE),
    runtime: join(configDir, RUNTIME_FILE),
    tokenUi: join(configDir, TOKEN_UI_FILE),
    tokenUiLock: join(configDir, `.${TOKEN_UI_FILE}.lock`),
    luna: join(configDir, "agents", "luna-worker.md"),
    validator: join(configDir, "agents", "validator-worker.md"),
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

export function projectWatchRefreshTargets(filename) {
  if (filename == null) return { runtime: true, tokenUi: true };
  const changed = String(filename);
  if (!changed) return { runtime: true, tokenUi: true };
  return {
    runtime: changed === RUNTIME_FILE,
    tokenUi: changed === TOKEN_UI_FILE,
  };
}

function managedWorkerAgentType(event) {
  if (event?.toolName !== "Agent" || typeof event.input?.subagent_type !== "string") return "";
  const agentType = event.input.subagent_type.trim().toLowerCase();
  return MANAGED_WORKER_ROLES.has(agentType) ? agentType : "";
}

function assertProjectPath(cwd, path) {
  const outside = (value) => !value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
  const relativeTarget = relative(resolve(cwd), resolve(cwd, path));
  if (outside(relativeTarget)) throw new Error("Validation path must remain inside the current project.");
  // Canonicalize the trusted root, but reject links at every level beneath it.
  // This also permits a legitimate cwd alias (e.g. macOS /var -> /private/var).
  const projectRoot = realpathSync(cwd);
  const parts = relativeTarget.split(sep);
  let current = projectRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symbolic link: ${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
  }
  assertRegularPath(current, { allowMissing: false });
  const canonicalTarget = realpathSync(current);
  if (outside(relative(projectRoot, canonicalTarget))) {
    throw new Error("Validation path must remain inside the current project.");
  }
  return canonicalTarget;
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

function projectIdentity(cwd) {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function initialProjectRuntimeState() {
  return { version: RUNTIME_VERSION, paused: false };
}

function normalizeProjectRuntimeState(value) {
  if (!isPlainObject(value)) throw new Error("Sol-Luna runtime state must be a JSON object.");
  const unknown = Object.keys(value).filter((key) => !["version", "paused"].includes(key));
  if (unknown.length > 0) throw new Error(`Sol-Luna runtime state contains unknown field(s): ${unknown.join(", ")}.`);
  if (value.version !== RUNTIME_VERSION) throw new Error(`Sol-Luna runtime state.version must be ${RUNTIME_VERSION}.`);
  if (typeof value.paused !== "boolean") throw new Error("Sol-Luna runtime state.paused must be a boolean.");
  return { version: RUNTIME_VERSION, paused: value.paused };
}

function readProjectRuntimeState(paths, { repairInvalid = false } = {}) {
  const missing = () => ({
    state: initialProjectRuntimeState(),
    repaired: false,
    status: "missing",
    missing: true,
    valid: false,
  });
  const configStat = lstatOrUndefined(paths.configDir);
  if (!configStat) return missing();
  if (configStat.isSymbolicLink() || !configStat.isDirectory()) {
    throw new Error(`Refusing unsafe project configuration directory: ${paths.configDir}`);
  }
  const text = readText(paths.runtime);
  if (text === undefined) return missing();
  try {
    return {
      state: normalizeProjectRuntimeState(JSON.parse(text)),
      repaired: false,
      status: "valid",
      missing: false,
      valid: true,
    };
  } catch (error) {
    if (!repairInvalid) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${paths.runtime}: ${error.message}`);
      throw new Error(`${paths.runtime} is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      state: initialProjectRuntimeState(),
      repaired: true,
      status: "invalid",
      missing: false,
      valid: false,
    };
  }
}

function writeProjectRuntimeState(paths, paused) {
  assertDirectory(paths.configDir);
  writeAtomic(paths.runtime, jsonText({ version: RUNTIME_VERSION, paused: paused === true }));
}

function readProjectTokenState(paths, { repairInvalid = false } = {}) {
  const configStat = lstatOrUndefined(paths.configDir);
  if (!configStat) return { state: initialProjectTokenState(), repaired: false, status: "missing" };
  if (configStat.isSymbolicLink() || !configStat.isDirectory()) {
    throw new Error(`Refusing unsafe project configuration directory: ${paths.configDir}`);
  }
  const text = readText(paths.tokenUi);
  if (text === undefined) return { state: initialProjectTokenState(), repaired: false, status: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error(`${paths.tokenUi} must contain a JSON object.`);
    return { state: normalizeProjectTokenState(parsed), repaired: false, status: "valid" };
  } catch (error) {
    if (!repairInvalid) {
      if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${paths.tokenUi}: ${error.message}`);
      throw error;
    }
    return {
      state: initialProjectTokenState({ visible: isPlainObject(parsed) && parsed.visible === true }),
      repaired: true,
      status: "invalid",
    };
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withProjectTokenLock(paths, callback) {
  const deadline = Date.now() + 2000;
  const owner = `${process.pid}:${randomUUID()}`;
  let descriptor;
  while (descriptor === undefined) {
    let created = false;
    try {
      descriptor = openSync(paths.tokenUiLock, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, `${owner}\n`, { encoding: "utf8" });
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
        descriptor = undefined;
      }
      if (created) {
        try { unlinkSync(paths.tokenUiLock); } catch {}
      }
      if (error?.code !== "EEXIST") throw error;
      const stat = lstatOrUndefined(paths.tokenUiLock);
      if (!stat) continue;
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Refusing unsafe project token lock: ${paths.tokenUiLock}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for project token lock: ${paths.tokenUiLock}. Remove it only after confirming no Pi process is updating this project.`);
      }
      sleepSync(10);
    }
  }
  const assertOwnership = () => {
    const currentOwner = readText(paths.tokenUiLock)?.trim();
    if (currentOwner !== owner) throw new Error("Project token lock ownership was lost; refusing to write stale totals.");
  };
  try {
    assertOwnership();
    return callback(assertOwnership);
  } finally {
    closeSync(descriptor);
    try {
      if (readText(paths.tokenUiLock)?.trim() === owner) unlinkSync(paths.tokenUiLock);
    } catch {
      // Never remove a lock that was replaced by another process.
    }
  }
}

function mutateProjectTokenState(cwd, mutator, { repairInvalid = false } = {}) {
  const paths = projectPaths(cwd);
  assertDirectory(paths.configDir);
  return withProjectTokenLock(paths, (assertOwnership) => {
    const current = readProjectTokenState(paths, { repairInvalid });
    const result = mutator(current.state);
    const next = normalizeProjectTokenState(result?.state ?? result);
    const changed = result?.changed !== false || current.repaired;
    if (changed) {
      assertOwnership();
      writeAtomic(paths.tokenUi, jsonText(next));
    }
    return { state: next, changed, repaired: current.repaired };
  });
}

function assistantMessageKey(ctx, message) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? "ephemeral";
  return sha256(JSON.stringify({
    sessionFile,
    timestamp: message?.timestamp ?? null,
    responseId: message?.responseId ?? null,
    provider: message?.provider ?? null,
    model: message?.model ?? null,
  }));
}

function startTaskToolCalls(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter((part) => (
    part?.type === "toolCall"
      && part.name === "sol_luna_gate"
      && isPlainObject(part.arguments)
      && part.arguments.action === "start_task"
      && typeof part.id === "string"
      && part.id
  ));
}

function activeProjectTask(state) {
  return Boolean(state?.taskId) && ["luna", "open", "sol-recovery"].includes(state.phase);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function templateContents() {
  return Object.fromEntries(
    Object.entries(AGENT_TEMPLATE_URLS).map(([relative, url]) => [relative, readFileSync(url, "utf8")]),
  );
}

function makeMarker(templates, selections) {
  return {
    package: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    managedMarker: MANAGED_MARKER,
    managedFiles: Object.fromEntries(Object.entries(templates).map(([relative, content]) => [relative, sha256(content)])),
    resolvedModels: Object.fromEntries(
      WORKER_ROUTE_ROLES.map((role) => [role, {
        provider: selections[role].provider,
        model: selections[role].model,
        thinking: selections[role].thinking,
      }]),
    ),
  };
}

function validMarker(marker) {
  if (!isPlainObject(marker)) return false;
  if (marker.package !== PACKAGE_NAME) return false;
  if (![MANAGED_MARKER, LEGACY_MANAGED_MARKER].includes(marker.managedMarker)) return false;
  if (!isPlainObject(marker.managedFiles)) return false;
  const currentFiles = AGENT_NAMES.map((name) => `agents/${name}.md`);
  const legacyFiles = LEGACY_AGENT_NAMES.map((name) => `agents/${name}.md`);
  const recordedFiles = Object.keys(marker.managedFiles);
  const expectedFiles = recordedFiles.length === legacyFiles.length ? legacyFiles : currentFiles;
  if (recordedFiles.length !== expectedFiles.length || recordedFiles.some((relative) => !expectedFiles.includes(relative))) return false;
  return expectedFiles.every((relative) => {
    const hash = marker.managedFiles[relative];
    return typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash);
  });
}

function materialization(cwd) {
  try {
    const paths = projectPaths(cwd);
    const marker = readMarker(paths);
    if (!validMarker(marker) || marker.managedMarker !== MANAGED_MARKER || marker.version !== PACKAGE_VERSION) return false;
    const expectedTemplates = templateContents();
    const managedFiles = {
      "agents/luna-worker.md": paths.luna,
      "agents/validator-worker.md": paths.validator,
      "agents/sol-worker.md": paths.sol,
    };
    const integrity = Object.entries(managedFiles).every(([relative, path]) => {
      const content = readText(path);
      const expectedHash = sha256(expectedTemplates[relative]);
      return content !== undefined
        && sha256(content) === expectedHash
        && marker.managedFiles[relative] === expectedHash;
    });
    return integrity && isMaterialized({
      markerExists: true,
      lunaExists: true,
      validatorExists: true,
      solExists: true,
    });
  } catch {
    return false;
  }
}

function managedRuntimeState(cwd) {
  try {
    const paths = projectPaths(cwd);
    const marker = readMarker(paths);
    if (marker === undefined) {
      const managedAgentPresent = [paths.luna, paths.validator, paths.sol]
        .some((path) => lstatOrUndefined(path) !== undefined);
      return managedAgentPresent ? "unsafe" : "inactive";
    }
    if (!validMarker(marker) || marker.managedMarker !== MANAGED_MARKER) return "unsafe";
    return materialization(cwd) ? "ready" : "unsafe";
  } catch {
    return "unsafe";
  }
}

function hasAgentTool(pi) {
  return pi.getAllTools().some((tool) => tool?.name === "Agent");
}

function modelIsAvailable(ctx, { provider, model }) {
  const registry = ctx.modelRegistry;
  const scoped = Array.isArray(ctx.scopedModels) && ctx.scopedModels.length > 0
    ? ctx.scopedModels.some((entry) => entry?.model?.provider === provider && entry?.model?.id === model)
    : true;
  if (!scoped) return false;
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

function readModelRoutes(paths) {
  const existing = readJson(paths.modelRoutes, { defaultValue: undefined });
  return existing === undefined
    ? { config: null, source: "missing" }
    : { config: normalizeModelRoutes(existing), source: "project" };
}

function candidateFromModel(model) {
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";
  return provider && id ? { provider, model: id } : null;
}

function availableProjectModels(ctx) {
  if (typeof ctx.modelRegistry?.getAvailable !== "function") {
    throw new Error("This Pi model registry cannot enumerate authenticated models. Upgrade Pi or use /sol-luna-models set with a supported Pi version.");
  }
  const scoped = Array.isArray(ctx.scopedModels) && ctx.scopedModels.length > 0
    ? new Set(ctx.scopedModels.map((entry) => candidateFromModel(entry?.model)).filter(Boolean).map(modelReference))
    : null;
  const models = [];
  const seen = new Set();
  for (const model of ctx.modelRegistry.getAvailable()) {
    const candidate = candidateFromModel(model);
    if (!candidate) continue;
    const reference = modelReference(candidate);
    if ((scoped && !scoped.has(reference)) || seen.has(reference)) continue;
    seen.add(reference);
    models.push(model);
  }
  return models.sort((left, right) => {
    const leftReference = modelReference(candidateFromModel(left));
    const rightReference = modelReference(candidateFromModel(right));
    return leftReference < rightReference ? -1 : leftReference > rightReference ? 1 : 0;
  });
}

function modelByReference(models, reference) {
  return models.find((model) => modelReference(candidateFromModel(model)) === reference) ?? null;
}

function scopedThinkingLevel(ctx, model) {
  if (!model || !Array.isArray(ctx?.scopedModels)) return null;
  const match = ctx.scopedModels.find((entry) => (
    entry?.model?.provider === model.provider && entry?.model?.id === model.id
  ));
  return THINKING_LEVELS.includes(match?.thinkingLevel) ? match.thinkingLevel : null;
}

function supportedThinkingLevels(model) {
  if (model?.reasoning === false) return ["off"];
  const mapping = model?.thinkingLevelMap;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return ["off", "minimal", "low", "medium", "high"];
  }
  return THINKING_LEVELS.filter((level) => {
    if (Object.hasOwn(mapping, level)) return mapping[level] !== null;
    return !["xhigh", "max"].includes(level);
  });
}

function clampThinking(model, requested, ctx) {
  const pinned = scopedThinkingLevel(ctx, model);
  if (pinned) return pinned;
  const supported = supportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index >= 0; index -= 1) {
    if (supported.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
  }
  return supported[0] ?? "off";
}

function currentModelCandidate(ctx, models) {
  const current = candidateFromModel(ctx.model);
  if (!current) return null;
  return modelByReference(models, modelReference(current)) ? current : null;
}

function automaticModelRoutes(ctx, { plannerMode = "inherit" } = {}) {
  const models = availableProjectModels(ctx);
  if (models.length === 0) {
    throw new Error("No authenticated models are available. Configure a provider with /login or /model, then run /sol-luna-init again.");
  }
  const base = buildAutoModelRoutes({
    availableCandidates: models.map(candidateFromModel),
    currentCandidate: currentModelCandidate(ctx, models),
    plannerMode,
  });
  const solCandidates = base.sol.candidates.filter((candidate) => {
    const model = modelByReference(models, modelReference(candidate));
    const pinned = scopedThinkingLevel(ctx, model);
    return supportedThinkingLevels(model).includes("high") && (!pinned || pinned === "high");
  });
  if (solCandidates.length === 0) {
    throw new Error("Sol Recovery requires at least one authenticated model that supports high thinking within the current Pi model scope.");
  }
  const configured = { ...base, sol: { ...base.sol, candidates: solCandidates } };
  const routeModel = (role) => modelByReference(models, modelReference(configured[role].candidates[0]));
  const plannerModel = plannerMode === "route" ? routeModel("planner") : ctx.model;
  return normalizeModelRoutes({
    ...configured,
    planner: { ...configured.planner, thinking: clampThinking(plannerModel, configured.planner.thinking, ctx) },
    luna: { ...configured.luna, thinking: clampThinking(routeModel("luna"), configured.luna.thinking, ctx) },
    validator: { ...configured.validator, thinking: clampThinking(routeModel("validator"), configured.validator.thinking, ctx) },
    sol: { ...configured.sol, thinking: "high" },
  });
}

function effectiveModelRoutes(ctx, paths) {
  const existing = readModelRoutes(paths);
  return existing.config
    ? existing
    : { config: automaticModelRoutes(ctx), source: "auto-preview" };
}

function resolveProjectModels(ctx, config, options = {}) {
  const resolution = resolveModelRoutes(config, (candidate) => modelIsAvailable(ctx, candidate), options);
  for (const role of ["planner", ...WORKER_ROUTE_ROLES]) {
    const selection = resolution.selections[role];
    const model = selection
      ? (ctx.modelRegistry?.find?.(selection.provider, selection.model)
        ?? ctx.modelRegistry?.getAvailable?.().find((entry) => entry.provider === selection.provider && entry.id === selection.model)
        ?? { provider: selection.provider, id: selection.model })
      : role === "planner" && resolution.roles.planner.mode === "inherit"
        ? ctx.model
        : null;
    const pinned = scopedThinkingLevel(ctx, model);
    const supported = supportedThinkingLevels(model);
    if (role === "sol" && selection) {
      if ((pinned && pinned !== "high") || !supported.includes("high")) {
        throw new Error(`Sol route ${modelReference(selection)} must support the fixed high thinking level${pinned ? ` and is scope-pinned to ${pinned}` : ""}.`);
      }
      resolution.roles.sol.thinking = "high";
      resolution.roles.sol.selection.thinking = "high";
      resolution.selections.sol.thinking = "high";
      continue;
    }
    const effectiveThinking = pinned ?? resolution.roles[role].thinking;
    if (model && !supported.includes(effectiveThinking)) {
      throw new Error(`${role} route ${modelReference(candidateFromModel(model))} does not support thinking=${effectiveThinking}.`);
    }
    if (!pinned) continue;
    resolution.roles[role].thinking = pinned;
    if (resolution.roles[role].selection) resolution.roles[role].selection.thinking = pinned;
    if (resolution.selections[role]) resolution.selections[role].thinking = pinned;
  }
  return resolution;
}

function missingModelMessage(resolution) {
  const roleLines = resolution.missingRoles.map((role) => {
    const candidates = resolution.roles[role].candidates.map((candidate) => modelReference(candidate)).join(", ");
    return `${role}: ${candidates}`;
  });
  return [
    "No available model route could be resolved for one or more Sol-Luna roles:",
    ...roleLines.map((line) => `- ${line}`),
    "Run /sol-luna-models to select models interactively, or /sol-luna-models auto --force to rebuild from authenticated models.",
    "Configure each provider and authentication in Pi, then run /sol-luna-update.",
    "Custom providers from models.json or provider extensions are supported; credentials are never read or copied by this package.",
  ].join("\n");
}

function modelStatusLines(resolution) {
  return WORKER_ROUTE_ROLES.flatMap((role) => {
    const detail = resolution.roles[role];
    const selected = detail.selected ? modelReference(detail.selected) : "(none)";
    return [
      `${role} route: selected=${selected} thinking=${detail.thinking}`,
      ...detail.candidates.map(
        (candidate, index) => `  ${index + 1}. ${modelReference(candidate)}: ${candidate.available ? "available" : "missing"}`,
      ),
    ];
  });
}

function notify(ctx, message, level = "info") {
  ctx.ui.notify(message, level);
}

function forceRequested(args) {
  return String(args ?? "").trim().split(/\s+/u).includes("--force");
}

function deepValidatorThinking(value) {
  return ["high", "xhigh", "max"].includes(value) ? value : "medium";
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

async function syncProject(pi, ctx, force, operation, options = {}) {
  if (!requireTrusted(ctx)) return false;
  if (!hasAgentTool(pi)) {
    notify(ctx, missingAgentMessage(), "error");
    return false;
  }

  const paths = projectPaths(ctx.cwd);
  const existingRoutes = options.modelRoutesOverride ? { config: null, source: "override" } : readModelRoutes(paths);
  let modelRoutes;
  let shouldWriteModelRoutes = false;
  let modelRoutesSource;
  try {
    if (options.modelRoutesOverride) {
      modelRoutes = normalizeModelRoutes(options.modelRoutesOverride);
      modelRoutesSource = "configured";
      shouldWriteModelRoutes = true;
    } else if (existingRoutes.config) {
      modelRoutes = existingRoutes.config;
      modelRoutesSource = "project";
    } else {
      modelRoutes = automaticModelRoutes(ctx);
      modelRoutesSource = "auto-discovered";
      shouldWriteModelRoutes = true;
    }
  } catch (error) {
    notify(ctx, `Model route discovery failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return false;
  }
  const modelResolution = resolveProjectModels(ctx, modelRoutes);
  if (!modelResolution.ok) {
    notify(ctx, missingModelMessage(modelResolution), "error");
    return false;
  }

  const marker = readMarker(paths);
  if (marker !== undefined && !validMarker(marker)) {
    notify(ctx, "Invalid Sol-Luna router marker; refusing to overwrite project files. Remove it deliberately or repair it first.", "error");
    return false;
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
      return false;
    }
    subagentMerge = mergeSubagents(subagents, { force: true });
  }

  ensureProjectDirectories(ctx.cwd);
  if (shouldWriteModelRoutes) writeAtomic(paths.modelRoutes, jsonText(modelRoutes));
  for (const [relative, item] of Object.entries(existingFiles)) {
    const desired = templates[relative];
    const decision = managedFileDecision(item.content, desired, { force: true });
    if (decision.action !== "skip") writeAtomic(item.path, desired);
  }
  writeAtomic(paths.subagents, jsonText(subagentMerge.value));
  writeAtomic(paths.marker, jsonText(makeMarker(templates, modelResolution.selections)));

  const selectedModels = WORKER_ROUTE_ROLES.map(
    (role) => `${role}=${modelReference(modelResolution.selections[role])}`,
  ).join(", ");
  notify(ctx, `${operation} complete (${modelRoutesSource} routes): ${CONFIG_DIR_NAME}/agents/luna-worker.md, ${CONFIG_DIR_NAME}/agents/validator-worker.md, ${CONFIG_DIR_NAME}/agents/sol-worker.md, ${CONFIG_DIR_NAME}/subagents.json, ${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE}, and ${CONFIG_DIR_NAME}/sol-luna-router.json are synchronized. Selected models: ${selectedModels}.`, "success");
  await ctx.reload();
  return true;
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
  let marker;
  let markerLine = "missing";
  try {
    marker = readMarker(paths);
    if (marker === undefined) markerLine = "missing";
    else if (!validMarker(marker)) markerLine = "invalid";
    else markerLine = `${marker.version ?? "unknown"} (valid)`;
  } catch (error) {
    markerLine = `error (${error instanceof Error ? error.message : String(error)})`;
  }

  let routeLines;
  try {
    const { config, source } = effectiveModelRoutes(ctx, paths);
    const resolution = resolveProjectModels(ctx, config);
    routeLines = [
      `Model routes: ${source === "project" ? `${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE}` : "automatic preview (file missing)"}`,
      ...modelStatusLines(resolution),
    ];
    if (validMarker(marker) && isPlainObject(marker.resolvedModels)) {
      routeLines.push(...WORKER_ROUTE_ROLES.map((role) => {
        const recorded = marker.resolvedModels[role];
        if (!recorded?.provider || !recorded?.model) return `${role} marker model: unknown (legacy marker)`;
        const relative = `agents/${role}-worker.md`;
        const path = role === "luna" ? paths.luna : role === "validator" ? paths.validator : paths.sol;
        let integrity;
        try {
          const content = readText(path);
          if (content === undefined) integrity = "agent missing";
          else integrity = sha256(content) === marker.managedFiles[relative] ? "verified" : "agent modified";
        } catch {
          integrity = "agent unsafe";
        }
        const selected = resolution.selections[role];
        const drift = selected && modelReference(selected) !== modelReference(recorded) ? ", route drift" : "";
        return `${role} marker model: ${modelReference(recorded)} thinking=${recorded.thinking ?? "unknown"} (${integrity}${drift})`;
      }));
    }
  } catch (error) {
    routeLines = [`Model routes: invalid (${error instanceof Error ? error.message : String(error)})`];
  }

  let runtimeLine;
  try {
    const runtime = readProjectRuntimeState(paths).state;
    runtimeLine = `Runtime: ${runtime.paused ? "paused" : "active"} (${CONFIG_DIR_NAME}/${RUNTIME_FILE})`;
  } catch (error) {
    runtimeLine = `Runtime: invalid (${error instanceof Error ? error.message : String(error)})`;
  }
  const report = [
    `pi-sol-luna-router ${PACKAGE_VERSION}`,
    `Project trusted: ${ctx.isProjectTrusted()}`,
    runtimeLine,
    `Agent dependency: ${hasAgentTool(pi) ? "present" : `missing — install with: ${AGENT_INSTALL_COMMAND}`}`,
    ...routeLines,
    `Marker: ${markerLine}`,
    `${MODEL_ROUTES_FILE}: ${safePresence(paths.modelRoutes)}`,
    `${TOKEN_UI_FILE}: ${safePresence(paths.tokenUi)}`,
    `luna-worker.md: ${safePresence(paths.luna)}`,
    `validator-worker.md: ${safePresence(paths.validator)}`,
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
  return latest;
}

function tokenizeCommandArguments(value) {
  const input = String(value ?? "");
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else token += character;
  }
  if (escaped || quote) throw new Error("Unterminated escape or quote in command arguments.");
  if (token) tokens.push(token);
  return tokens;
}

const MODEL_COMMAND_ACTIONS = new Set(["configure", "auto", "status", "reset", "set"]);
const MODEL_COMMAND_VALUE_OPTIONS = new Set([
  "planner-mode", "planner", "planner-thinking",
  "luna", "luna-thinking", "validator", "validator-thinking", "sol",
]);

function parseModelCommandArguments(value) {
  const tokens = tokenizeCommandArguments(value);
  const action = tokens[0] && MODEL_COMMAND_ACTIONS.has(tokens[0]) ? tokens.shift() : "configure";
  const options = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--force") {
      if (options.force) throw new Error("Duplicate option --force.");
      options.force = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}.`);
    const key = token.slice(2);
    if (!MODEL_COMMAND_VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${key}.`);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option: --${key}.`);
    const optionValue = tokens[index + 1];
    if (!optionValue || optionValue.startsWith("--")) throw new Error(`Option --${key} requires a value.`);
    options[key] = optionValue;
    index += 1;
  }
  return { action, options };
}

function candidateFromReference(reference) {
  if (typeof reference !== "string") return null;
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
}

function requireConfiguredModel(models, reference, optionName) {
  const candidate = candidateFromReference(reference);
  const model = candidate ? modelByReference(models, modelReference(candidate)) : null;
  if (!model) throw new Error(`${optionName} must reference an authenticated available model as provider/model.`);
  return { candidate, model };
}

function selectedThinking(model, value, fallback, optionName, { allowFutureModel = false, ctx } = {}) {
  const pinned = scopedThinkingLevel(ctx, model);
  const thinking = value ?? (allowFutureModel ? (pinned ?? fallback) : clampThinking(model, fallback, ctx));
  if (!THINKING_LEVELS.includes(thinking)) {
    throw new Error(`${optionName} must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  if (pinned && thinking !== pinned) {
    throw new Error(`${optionName} must be ${pinned} because the current Pi model scope pins ${modelReference(candidateFromModel(model))} to that level.`);
  }
  if (!allowFutureModel && model && !supportedThinkingLevels(model).includes(thinking)) {
    throw new Error(`${optionName}=${thinking} is not supported by ${modelReference(candidateFromModel(model))}. Supported levels: ${supportedThinkingLevels(model).join(", ")}.`);
  }
  return thinking;
}

function explicitModelRoutes(ctx, options) {
  const models = availableProjectModels(ctx);
  if (models.length === 0) throw new Error("No authenticated models are available for explicit Sol-Luna configuration.");
  const plannerMode = options["planner-mode"] ?? "inherit";
  if (!['inherit', 'route'].includes(plannerMode)) throw new Error("--planner-mode must be inherit or route.");
  if (plannerMode === "route" && !options.planner) throw new Error("--planner is required when --planner-mode is route.");
  if (plannerMode === "inherit" && options.planner) throw new Error("--planner is allowed only when --planner-mode is route.");
  for (const role of WORKER_ROUTE_ROLES) {
    if (!options[role]) throw new Error(`--${role} is required for /sol-luna-models set.`);
  }
  const planner = plannerMode === "route" ? requireConfiguredModel(models, options.planner, "--planner") : null;
  const luna = requireConfiguredModel(models, options.luna, "--luna");
  const validator = requireConfiguredModel(models, options.validator, "--validator");
  const sol = requireConfiguredModel(models, options.sol, "--sol");
  const solPinned = scopedThinkingLevel(ctx, sol.model);
  if (!supportedThinkingLevels(sol.model).includes("high") || (solPinned && solPinned !== "high")) {
    throw new Error(`--sol must reference a model that supports the fixed high recovery thinking level${solPinned ? `; the selected model is scope-pinned to ${solPinned}` : ""}.`);
  }
  return normalizeModelRoutes({
    version: 2,
    planner: {
      mode: plannerMode,
      thinking: selectedThinking(planner?.model ?? ctx.model, options["planner-thinking"], "high", "--planner-thinking", { allowFutureModel: plannerMode === "inherit", ctx }),
      ...(planner ? { candidates: [planner.candidate] } : {}),
    },
    luna: {
      thinking: selectedThinking(luna.model, options["luna-thinking"], "medium", "--luna-thinking", { ctx }),
      candidates: [luna.candidate],
    },
    validator: {
      thinking: selectedThinking(validator.model, options["validator-thinking"], "low", "--validator-thinking", { ctx }),
      candidates: [validator.candidate],
    },
    sol: {
      thinking: "high",
      candidates: [sol.candidate],
    },
  });
}

async function selectModel(ctx, models, title, preferredReference) {
  const references = models.map((model) => modelReference(candidateFromModel(model)));
  const choices = preferredReference && references.includes(preferredReference)
    ? [preferredReference, ...references.filter((reference) => reference !== preferredReference)]
    : references;
  const selected = await ctx.ui.select(title, choices);
  return selected ? requireConfiguredModel(models, selected, title) : null;
}

async function selectThinking(ctx, title, model, preferred) {
  const pinned = scopedThinkingLevel(ctx, model);
  const supported = pinned ? [pinned] : supportedThinkingLevels(model);
  const choices = supported.includes(preferred)
    ? [preferred, ...supported.filter((level) => level !== preferred)]
    : supported;
  return ctx.ui.select(title, choices);
}

function routesSummary(config) {
  const planner = config.planner.mode === "inherit"
    ? `planner=inherit thinking=${config.planner.thinking}`
    : `planner=${modelReference(config.planner.candidates[0])} thinking=${config.planner.thinking}`;
  return [
    planner,
    ...WORKER_ROUTE_ROLES.map((role) => `${role}=${modelReference(config[role].candidates[0])} thinking=${config[role].thinking}`),
  ].join("\n");
}

async function interactiveModelRoutes(ctx) {
  if (!ctx.hasUI) throw new Error("Interactive model configuration requires Pi TUI/RPC mode. Use /sol-luna-models set ... or /sol-luna-models auto instead.");
  const models = availableProjectModels(ctx);
  if (models.length === 0) throw new Error("No authenticated models are available. Configure a provider first.");
  const paths = projectPaths(ctx.cwd);
  let existing;
  try {
    existing = readModelRoutes(paths).config;
  } catch {
    existing = null;
  }
  const runtime = resolveProjectModels(ctx, existing ?? automaticModelRoutes(ctx)).config;
  const modeLabel = await ctx.ui.select("Planner routing", [
    runtime.planner.mode === "route" ? "route to explicit model" : "inherit current Pi model",
    runtime.planner.mode === "route" ? "inherit current Pi model" : "route to explicit model",
  ]);
  if (!modeLabel) return null;
  const plannerMode = modeLabel.startsWith("route") ? "route" : "inherit";
  const planner = plannerMode === "route"
    ? await selectModel(ctx, models, "Planner model", runtime.planner.candidates?.[0] ? modelReference(runtime.planner.candidates[0]) : null)
    : null;
  if (plannerMode === "route" && !planner) return null;
  const plannerThinking = await selectThinking(ctx, "Planner thinking", planner?.model ?? ctx.model, runtime.planner.thinking);
  if (!plannerThinking) return null;
  const selections = {};
  for (const role of WORKER_ROUTE_ROLES) {
    const preferred = runtime[role]?.candidates?.[0] ? modelReference(runtime[role].candidates[0]) : null;
    const roleModels = role === "sol"
      ? models.filter((model) => supportedThinkingLevels(model).includes("high")
          && (!scopedThinkingLevel(ctx, model) || scopedThinkingLevel(ctx, model) === "high"))
      : models;
    if (roleModels.length === 0) throw new Error("No authenticated model supports Sol Recovery's fixed high thinking level in the current scope.");
    selections[role] = await selectModel(ctx, roleModels, `${role} model`, preferred);
    if (!selections[role]) return null;
    selections[role].thinking = role === "sol"
      ? "high"
      : await selectThinking(ctx, `${role} thinking`, selections[role].model, runtime[role]?.thinking);
    if (!selections[role].thinking) return null;
  }
  return normalizeModelRoutes({
    version: 2,
    planner: {
      mode: plannerMode,
      thinking: plannerThinking,
      ...(planner ? { candidates: [planner.candidate] } : {}),
    },
    ...Object.fromEntries(WORKER_ROUTE_ROLES.map((role) => [role, {
      thinking: selections[role].thinking,
      candidates: [selections[role].candidate],
    }])),
  });
}

function modelCommandUsage() {
  return [
    "/sol-luna-models                         Interactive configuration",
    "/sol-luna-models status                  Show explicit routes and availability",
    "/sol-luna-models auto [--force]          Generate recommended v2 routes",
    "/sol-luna-models reset [--force]         Replace routes with auto-discovered recommendations",
    "/sol-luna-models set --planner-mode inherit --luna provider/model --validator provider/model --sol provider/model [--force]",
  ].join("\n");
}

function modelConfigurationStatus(ctx) {
  const paths = projectPaths(ctx.cwd);
  const explicit = readModelRoutes(paths);
  let models = [];
  let discoveryError = null;
  try {
    models = availableProjectModels(ctx);
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
  }
  let config = explicit.config;
  if (!config && models.length > 0) config = automaticModelRoutes(ctx);
  const current = candidateFromModel(ctx.model);
  const lines = [
    `Route source: ${explicit.config ? `${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE}` : "missing"}`,
    `Current Pi model: ${current ? modelReference(current) : "(none)"}`,
    `Authenticated eligible models: ${models.length}${Array.isArray(ctx.scopedModels) && ctx.scopedModels.length > 0 ? " (session scoped)" : ""}`,
  ];
  if (discoveryError) lines.push(`Model discovery: unavailable (${discoveryError})`);
  if (!config) {
    lines.push("No explicit or automatically discoverable route is available.");
    return lines.join("\n");
  }
  const resolution = resolveProjectModels(ctx, config);
  lines.push(
    `Route version: ${config.version}${explicit.config ? "" : " (automatic preview)"}`,
    `planner: ${config.version === 2 && config.planner.mode === "route" ? (resolution.selections.planner ? modelReference(resolution.selections.planner) : "(none)") : "inherit"} thinking=${resolution.roles.planner.thinking}`,
    ...modelStatusLines(resolution),
  );
  return lines.join("\n");
}

function resultText(text, state, details = {}) {
  return {
    content: [{ type: "text", text }],
    details: { state: normalizeState(state), ...details },
  };
}

const SYSTEM_PROTOCOL = `

${CACHE_FRIENDLY_PROTOCOL_PREFIX}

## Sol-Luna Host Orchestration Protocol
- The parent is the Root Planner: understand the goal, define acceptance criteria, schedule workers, and make the final decision. The parent must not edit or write project files.
- Start each task with sol_luna_gate(action=start_task), then call sol_luna_prepare_worker before every managed Agent call. Pass the returned rendered_prompt as the worker task without rewriting it.
- Luna is the default implementation worker. Validator is a new read-only worker for diff checks, tests, lint, and static analysis. A Luna or Sol success claim is not final until Validator passes.
- After each Agent returns, call sol_luna_record_result with its exact JSON report, then record observed token/latency feedback with sol_luna_record_usage when available. Fast Validator failures escalate to Deep Validator before creating a Failure Snapshot. One failed deep Luna validation permits one new Luna retry; the second opens the circuit.
- When the circuit opens, prepare and start exactly one new sol-worker call. Sol must consume the latest Failure Snapshot and inspect affected files rather than re-exploring the project.
- Managed Agent calls must be immediate, inherit_context false, unscheduled, without resume or model overrides. Models and thinking levels are pinned by the project routing policy.
- Parent bash is limited to read-only inspection or emergency compatibility validation and must never bypass write restrictions.
- Only the user may run /sol-luna-reset. The router state, Context Envelope, Task Memory, and Failure Snapshot are authoritative.
`;

export function createPiAdapter(pi, options = {}) {
  const managedDispatches = new Map();
  const workerDispatchByAgentId = new Map();
  const pendingPlannerUsage = new Map();
  const eligiblePlannerMessages = new Set();
  const router = createRouterService({
    taskIdFactory: () => `task-${randomUUID()}`,
  });
  let activeSession = null;
  let tokenUiState = initialProjectTokenState();
  let tokenWidgetTui = null;
  let tokenWidgetInstalled = false;
  let tokenUiWatcher = null;
  let watcherGeneration = 0;
  let tokenUiRefreshTimer = null;
  let tokenUiWarning = null;
  let runtimeRefreshTimer = null;
  const readRetries = {
    tokenUi: { timer: null, count: 0, projectId: null },
    runtime: { timer: null, count: 0, projectId: null },
  };
  const watchProject = options.watch ?? watch;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const READ_RETRY_LIMIT = 5;
  const READ_RETRY_DELAY = 100;
  const WATCH_REFRESH_DELAY = 75;

  const clearTransientCorrelations = () => {
    managedDispatches.clear();
    workerDispatchByAgentId.clear();
    pendingPlannerUsage.clear();
    eligiblePlannerMessages.clear();
  };

  const runtimeStateFor = (ctx) => readProjectRuntimeState(projectPaths(projectIdentity(ctx.cwd))).state;

  const assertRuntimeEnabled = (ctx) => {
    if (ctx?.cwd && runtimeStateFor(ctx).paused) {
      throw new Error("Sol-Luna is paused for this project. Run /sol-luna-enable to resume orchestration.");
    }
  };

  const persistState = (previousSnapshot) => {
    try {
      pi.appendEntry(STATE_ENTRY_TYPE, router.snapshot());
    } catch (error) {
      if (previousSnapshot !== undefined) router.restore(previousSnapshot);
      throw error;
    }
  };

  const requestTokenWidgetRender = () => tokenWidgetTui?.requestRender?.();

  const resetReadRetry = (kind) => {
    const retry = readRetries[kind];
    if (retry.timer !== null) clearTimer(retry.timer);
    retry.timer = null;
    retry.count = 0;
    retry.projectId = null;
  };

  const cancelTokenUiTimers = () => {
    if (tokenUiRefreshTimer !== null) clearTimer(tokenUiRefreshTimer);
    tokenUiRefreshTimer = null;
    resetReadRetry("tokenUi");
  };

  const cancelRuntimeTimers = () => {
    if (runtimeRefreshTimer !== null) clearTimer(runtimeRefreshTimer);
    runtimeRefreshTimer = null;
    resetReadRetry("runtime");
  };

  const closeTokenUiWatcher = () => {
    watcherGeneration += 1;
    cancelTokenUiTimers();
    cancelRuntimeTimers();
    tokenUiWatcher?.close?.();
    tokenUiWatcher = null;
  };

  const applyTokenWidget = (ctx, { force = false } = {}) => {
    if (!ctx?.ui?.setWidget) return;
    const eligible = ctx.mode === "tui" && tokenUiState.visible === true
      && activeSession?.paused !== true && activeSession?.runtimeInvalid !== true;
    if (!eligible) {
      if (tokenWidgetInstalled) ctx.ui.setWidget(TOKEN_UI_WIDGET, undefined);
      tokenWidgetTui = null;
      tokenWidgetInstalled = false;
      return;
    }
    if (tokenWidgetInstalled && !force) {
      requestTokenWidgetRender();
      return;
    }
    ctx.ui.setWidget(TOKEN_UI_WIDGET, (tui) => {
      tokenWidgetTui = tui;
      return {
        render(width) {
          if (!Number.isInteger(width) || width <= 0) return [];
          const text = formatProjectTokenShares(tokenUiState);
          const fitted = text.length > width ? text.slice(text.length - width) : text.padStart(width, " ");
          return [fitted];
        },
        invalidate() {},
      };
    }, { placement: "belowEditor" });
    tokenWidgetInstalled = true;
  };

  const warnTokenUiOnce = (ctx, error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (tokenUiWarning === message) return;
    tokenUiWarning = message;
    if (ctx?.hasUI && ctx.ui?.notify) {
      notify(ctx, `Sol-Luna project token accounting is unavailable: ${message}`, "warning");
    }
  };

  const currentWatcherProject = (projectId, generation) => (
    generation === watcherGeneration && activeSession?.projectId === projectId && activeSession?.ctx
  );

  const resetTokenUiRetry = () => resetReadRetry("tokenUi");
  const resetRuntimeRetry = () => resetReadRetry("runtime");

  const scheduleReadRetry = (kind, projectId, generation, refresh) => {
    const retry = readRetries[kind];
    if (retry.projectId !== projectId) retry.count = 0;
    retry.projectId = projectId;
    retry.count += 1;
    if (retry.timer !== null) clearTimer(retry.timer);
    retry.timer = setTimer(() => {
      retry.timer = null;
      if (currentWatcherProject(projectId, generation)) refresh(activeSession.ctx);
    }, READ_RETRY_DELAY);
  };

  const refreshRuntimeState = (ctx, {
    watcherOrigin = false,
    generation = watcherGeneration,
    applyWidget = true,
  } = {}) => {
    if (!ctx || typeof ctx.cwd !== "string") return false;
    const projectId = projectIdentity(ctx.cwd);
    if (watcherOrigin && !currentWatcherProject(projectId, generation)) return false;
    try {
      const result = readProjectRuntimeState(projectPaths(projectId));
      const preserveInactive = watcherOrigin && result.missing === true
        && activeSession?.projectId === projectId
        && (activeSession.paused === true || activeSession.runtimeInvalid === true);
      if (preserveInactive && readRetries.runtime.count < READ_RETRY_LIMIT) {
        scheduleReadRetry("runtime", projectId, generation, (retryCtx) => refreshRuntimeState(retryCtx, { watcherOrigin: true, generation }));
        if (applyWidget) applyTokenWidget(ctx);
        return activeSession.runtimeInvalid === true ? null : true;
      }
      resetRuntimeRetry();
      const paused = result.state.paused;
      const changed = activeSession?.projectId === projectId && activeSession.paused !== paused;
      if (activeSession?.projectId === projectId) activeSession = { ...activeSession, ctx, paused, runtimeInvalid: false };
      if (paused && changed) clearTransientCorrelations();
      if (activeSession?.projectId === projectId && applyWidget) applyTokenWidget(ctx);
      return paused;
    } catch (error) {
      resetRuntimeRetry();
      // An unreadable runtime must fail closed for Sol-Luna state. Do not turn
      // an integrity failure into an active widget/accounting session.
      if (activeSession?.projectId === projectId) activeSession = { ...activeSession, ctx, paused: true, runtimeInvalid: true };
      clearTransientCorrelations();
      warnTokenUiOnce(ctx, error);
      if (applyWidget) applyTokenWidget(ctx);
      return null;
    }
  };

  const refreshTokenUiState = (ctx, {
    watcherOrigin = false,
    generation = watcherGeneration,
    applyWidget = true,
  } = {}) => {
    if (!ctx || typeof ctx.cwd !== "string") return false;
    const projectId = projectIdentity(ctx.cwd);
    if (watcherOrigin && !currentWatcherProject(projectId, generation)) return false;
    try {
      const result = readProjectTokenState(projectPaths(projectId));
      if (watcherOrigin && result.status === "missing" && readRetries.tokenUi.count < READ_RETRY_LIMIT) {
        scheduleReadRetry("tokenUi", projectId, generation, (retryCtx) => refreshTokenUiState(retryCtx, { watcherOrigin: true, generation }));
        if (applyWidget) applyTokenWidget(ctx);
        return false;
      }
      resetTokenUiRetry();
      tokenUiState = result.state;
      tokenUiWarning = null;
      if (activeSession?.projectId === projectId) activeSession.ctx = ctx;
      if (applyWidget) {
        applyTokenWidget(ctx);
        requestTokenWidgetRender();
      }
      return true;
    } catch (error) {
      if (watcherOrigin && readRetries.tokenUi.count < READ_RETRY_LIMIT) {
        scheduleReadRetry("tokenUi", projectId, generation, (retryCtx) => refreshTokenUiState(retryCtx, { watcherOrigin: true, generation }));
        if (applyWidget) applyTokenWidget(ctx);
        return false;
      }
      resetTokenUiRetry();
      // A stable deletion or persistent corruption is not an atomic-write gap:
      // fail closed and remove the stale display instead of preserving forever.
      tokenUiState = initialProjectTokenState();
      if (applyWidget) applyTokenWidget(ctx);
      warnTokenUiOnce(ctx, error);
      return false;
    }
  };

  const startTokenUiWatcher = (ctx) => {
    closeTokenUiWatcher();
    if (ctx?.mode !== "tui" || typeof ctx.cwd !== "string") return;
    try {
      const projectId = projectIdentity(ctx.cwd);
      const paths = projectPaths(projectId);
      const stat = lstatOrUndefined(paths.configDir);
      if (!stat) return;
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing unsafe project configuration directory: ${paths.configDir}`);
      }
      const generation = watcherGeneration;
      tokenUiWatcher = watchProject(paths.configDir, { persistent: false }, (_eventType, filename) => {
        if (!currentWatcherProject(projectId, generation)) return;
        const targets = projectWatchRefreshTargets(filename);
        if (targets.tokenUi) {
          if (tokenUiRefreshTimer !== null) clearTimer(tokenUiRefreshTimer);
          tokenUiRefreshTimer = setTimer(() => {
            tokenUiRefreshTimer = null;
            if (currentWatcherProject(projectId, generation)) {
              refreshTokenUiState(activeSession.ctx, { watcherOrigin: true, generation });
            }
          }, WATCH_REFRESH_DELAY);
        }
        if (targets.runtime) {
          if (runtimeRefreshTimer !== null) clearTimer(runtimeRefreshTimer);
          runtimeRefreshTimer = setTimer(() => {
            runtimeRefreshTimer = null;
            if (currentWatcherProject(projectId, generation)) {
              refreshRuntimeState(activeSession.ctx, { watcherOrigin: true, generation });
            }
          }, WATCH_REFRESH_DELAY);
        }
      });
      tokenUiWatcher.on("error", (error) => {
        if (currentWatcherProject(projectId, generation)) warnTokenUiOnce(ctx, error);
      });
    } catch (error) {
      warnTokenUiOnce(ctx, error);
    }
  };

  const mutateActiveProjectTokens = (ctx, mutator) => {
    if (!ctx || typeof ctx.cwd !== "string" || !ctx.isProjectTrusted?.()) return false;
    const projectId = projectIdentity(ctx.cwd);
    try {
      if (readProjectRuntimeState(projectPaths(projectId)).state.paused) return false;
    } catch (error) {
      warnTokenUiOnce(ctx, error);
      return false;
    }
    if (activeSession?.projectId && activeSession.projectId !== projectId) return false;
    try {
      const update = mutateProjectTokenState(projectId, mutator);
      tokenUiState = update.state;
      tokenUiWarning = null;
      if (activeSession?.projectId === projectId) activeSession.ctx = ctx;
      applyTokenWidget(ctx);
      requestTokenWidgetRender();
      return true;
    } catch (error) {
      warnTokenUiOnce(ctx, error);
      return false;
    }
  };

  const recordActiveProjectTokens = (ctx, { role, tokens, kind, key }) => {
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return false;
    return mutateActiveProjectTokens(ctx, (state) => recordProjectTokenUsage(state, { role, tokens, kind, key }));
  };

  const findManagedDispatch = (role) => {
    const pending = router.getPendingRequest();
    if (!pending || pending.role !== role || pending.dispatched !== true) return null;
    for (const [dispatchKey, dispatch] of [...managedDispatches.entries()].reverse()) {
      if (dispatch.role !== role || dispatch.requestId !== pending.requestId || dispatch.taskId !== pending.taskId) continue;
      if (activeSession?.projectId && dispatch.projectId !== activeSession.projectId) continue;
      return { dispatchKey, dispatch };
    }
    return null;
  };

  const correlateWorkerStart = (event) => {
    const role = MANAGED_WORKER_ROLES.get(event?.type);
    if (!role || typeof event?.id !== "string" || !event.id) return;
    const match = findManagedDispatch(role);
    if (!match || event.description !== match.dispatch.expectedDescription) return;
    match.dispatch.agentId = event.id;
    workerDispatchByAgentId.set(event.id, match.dispatchKey);
  };

  const recordWorkerCompletion = (event) => {
    const role = MANAGED_WORKER_ROLES.get(event?.type);
    if (!role || typeof event?.id !== "string" || !event.id || !activeSession?.ctx) return;
    const dispatchKey = workerDispatchByAgentId.get(event.id);
    if (dispatchKey === undefined) return;
    const match = { dispatchKey, dispatch: managedDispatches.get(dispatchKey) };
    if (!match?.dispatch || match.dispatch.role !== role || match.dispatch.usageCounted === true) return;
    if (match.dispatch.projectId !== activeSession.projectId) return;
    const tokens = tokenTotalFromWorkerEvent(event);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
    const counted = recordActiveProjectTokens(activeSession.ctx, {
      role,
      tokens,
      kind: "workerRuns",
      key: `subagent:${event.id}`,
    });
    if (!counted) return;
    match.dispatch.usageCounted = true;
    match.dispatch.agentId = event.id;
    workerDispatchByAgentId.set(event.id, match.dispatchKey);
    if (match.dispatch.toolResultSeen === true) {
      managedDispatches.delete(match.dispatchKey);
      workerDispatchByAgentId.delete(event.id);
    }
  };

  if (pi.events?.on) {
    pi.events.on("subagents:started", correlateWorkerStart);
    pi.events.on("subagents:completed", recordWorkerCompletion);
    pi.events.on("subagents:failed", recordWorkerCompletion);
  }

  pi.on("session_start", (_event, ctx) => {
    if (activeSession?.ctx?.ui?.setWidget && tokenWidgetInstalled) {
      activeSession.ctx.ui.setWidget(TOKEN_UI_WIDGET, undefined);
    }
    closeTokenUiWatcher();
    tokenUiState = initialProjectTokenState();
    tokenWidgetTui = null;
    tokenWidgetInstalled = false;
    clearTransientCorrelations();
    router.restore(stateFromBranch(ctx));
    if (typeof ctx?.cwd !== "string") {
      activeSession = null;
      tokenUiState = initialProjectTokenState();
      return;
    }
    const projectId = projectIdentity(ctx.cwd);
    let paused = false;
    let runtimeInvalid = false;
    try {
      paused = readProjectRuntimeState(projectPaths(projectId)).state.paused;
    } catch (error) {
      warnTokenUiOnce(ctx, error);
      // Preserve ordinary Pi access, but fail closed for Sol-Luna.
      paused = true;
      runtimeInvalid = true;
    }
    activeSession = { ctx, projectId, paused, runtimeInvalid };
    refreshTokenUiState(ctx, { applyWidget: false });
    startTokenUiWatcher(ctx);
    applyTokenWidget(ctx, { force: true });
  });

  // Pi can rebuild UI registrations after an agent turn. Reinstall only for
  // this explicit lifecycle self-heal; ordinary refreshes reuse ownership.
  pi.on("agent_settled", (_event, ctx) => {
    if (!activeSession?.ctx || !ctx || activeSession.projectId !== projectIdentity(ctx.cwd)) return;
    refreshRuntimeState(ctx, { applyWidget: false });
    refreshTokenUiState(ctx, { applyWidget: false });
    applyTokenWidget(ctx, { force: true });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx?.ui?.setWidget) ctx.ui.setWidget(TOKEN_UI_WIDGET, undefined);
    tokenWidgetTui = null;
    tokenWidgetInstalled = false;
    closeTokenUiWatcher();
    activeSession = null;
    tokenUiState = initialProjectTokenState();
    clearTransientCorrelations();
  });

  pi.on("message_end", (event, ctx) => {
    const message = event?.message;
    if (message?.role !== "assistant" || typeof ctx?.cwd !== "string") return;
    const projectId = projectIdentity(ctx.cwd);
    if (activeSession?.projectId !== projectId || refreshRuntimeState(ctx) !== false || managedRuntimeState(ctx.cwd) !== "ready") return;
    const candidate = {
      projectId,
      key: `planner:${assistantMessageKey(ctx, message)}`,
    };
    if (activeProjectTask(router.getState())) eligiblePlannerMessages.add(candidate.key);
    else for (const part of startTaskToolCalls(message)) pendingPlannerUsage.set(part.id, candidate);
  });

  pi.on("turn_end", (event, ctx) => {
    const message = event?.message;
    if (message?.role !== "assistant" || typeof ctx?.cwd !== "string") return;
    if (refreshRuntimeState(ctx) !== false) return;
    const key = `planner:${assistantMessageKey(ctx, message)}`;
    if (!eligiblePlannerMessages.delete(key)) return;
    const tokens = tokenTotalFromUsage(message.usage);
    if (!Number.isSafeInteger(tokens) || tokens <= 0) return;
    recordActiveProjectTokens(ctx, { role: "planner", tokens, kind: "plannerMessages", key });
  });

  pi.on("before_agent_start", (_event, ctx) => {
    let runtimeError = null;
    try {
      if (runtimeStateFor(ctx).paused) return;
    } catch (error) {
      // Preserve the normal managed-file integrity boundary below while keeping
      // a malformed runtime from enabling orchestration.
      runtimeError = error;
    }
    const runtimeState = managedRuntimeState(ctx.cwd);
    if (runtimeState === "inactive") return;
    if (runtimeState === "unsafe") {
      return {
        systemPrompt: `${_event.systemPrompt}\n\n## Sol-Luna Integrity Failure\nManaged files do not match the project marker. Do not run implementation workers or mutate files. Ask the user to run /sol-luna-update or /sol-luna-models reset --force.`,
      };
    }
    if (runtimeError) return;
    const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
    if (activeTools.includes("sol_luna_validate") && !activeTools.includes("Agent")) {
      return {
        systemPrompt: `${_event.systemPrompt}\n\n## Validator Capability Boundary\nUse sol_luna_validate only for syntax, JSON, and Git diff/status checks. Project scripts, direct shell execution, and file mutation are unavailable; report when external CI/test evidence is still required.`,
      };
    }
    return { systemPrompt: `${_event.systemPrompt}${SYSTEM_PROTOCOL}` };
  });

  pi.on("tool_call", (event, ctx) => {
    let projectRuntime;
    try {
      projectRuntime = runtimeStateFor(ctx);
    } catch (error) {
      const reason = `Sol-Luna runtime state is invalid or unsafe: ${error instanceof Error ? error.message : String(error)}`;
      if (typeof event.toolName === "string" && event.toolName.startsWith("sol_luna_")) {
        return { block: true, reason };
      }
      if (managedWorkerAgentType(event)) return { block: true, reason };
      // Fail closed only for Sol-Luna orchestration. Ordinary unrelated Pi
      // tools and Agent calls remain available, matching explicit pause behavior.
      return;
    }
    if (projectRuntime?.paused === true) {
      if ((typeof event.toolName === "string" && event.toolName.startsWith("sol_luna_")) || managedWorkerAgentType(event)) {
        return { block: true, reason: "Sol-Luna is paused for this project. Run /sol-luna-enable to resume orchestration." };
      }
      return;
    }
    const runtimeState = managedRuntimeState(ctx.cwd);
    if (runtimeState === "inactive") return;
    if (runtimeState === "unsafe") {
      if (["edit", "write", "bash", "Agent"].includes(event.toolName) || event.toolName.startsWith("sol_luna_")) {
        return {
          block: true,
          reason: "Sol-Luna managed-file integrity verification failed. Run /sol-luna-update or /sol-luna-models reset --force before continuing.",
        };
      }
      return;
    }

    if (["edit", "write", "bash"].includes(event.toolName)) {
      return {
        block: true,
        reason: "Parent filesystem mutation and shell execution are blocked by pi-sol-luna-router. Use managed Luna/Sol workers for implementation and Validator for approved checks.",
      };
    }

    if (event.toolName !== "Agent") return;
    const input = event.input ?? {};
    const managedRole = MANAGED_WORKER_ROLES.get(managedWorkerAgentType(event));
    if (!managedRole) {
      return { block: true, reason: "Only prepared luna-worker, validator-worker, or sol-worker Agent calls are allowed while the Sol-Luna runtime is active." };
    }
    if (input.schedule) {
      return { block: true, reason: "Scheduled Sol/Luna/Validator calls are blocked because delayed execution can violate the current task state. Start the worker immediately." };
    }
    if (typeof input.model === "string" && input.model.trim()) {
      return { block: true, reason: `Model overrides are blocked for managed workers. Edit ${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE} and run /sol-luna-update instead.` };
    }
    if (typeof input.thinking === "string" && input.thinking.trim()) {
      return { block: true, reason: "Thinking overrides are blocked for managed workers; use the routed task complexity." };
    }
    if (input.resume) {
      return { block: true, reason: "Managed workers must be new isolated calls; resume and hot-switching are blocked." };
    }
    try {
      const pending = router.getPendingRequest();
      if (!pending || pending.role !== managedRole) {
        return { block: true, reason: `No prepared ${managedRole} request is pending. Call sol_luna_prepare_worker first.` };
      }
      if (pending.dispatched === true) {
        return { block: true, reason: `Prepared ${managedRole} request ${pending.requestId} has already been dispatched.` };
      }
      const dispatched = router.markWorkerDispatched({ role: managedRole, requestId: pending.requestId });
      if (!dispatched.allowed) return { block: true, reason: dispatched.reason };
      persistState(dispatched.previousSnapshot);
      input.prompt = pending.renderedPrompt;
      input.description = `sol-luna ${managedRole} ${pending.requestId}`;
      input.model = pending.routing?.provider && pending.routing?.model
        ? `${pending.routing.provider}/${pending.routing.model}`
        : input.model;
      input.thinking = pending.budget.thinking;
      input.inherit_context = false;
      input.run_in_background = false;
      const dispatchKey = event.toolCallId ?? pending.requestId;
      managedDispatches.set(dispatchKey, {
        role: managedRole,
        requestId: pending.requestId,
        validatorMode: pending.validatorMode,
        taskId: pending.taskId,
        projectId: projectIdentity(ctx.cwd),
        usageCounted: false,
        toolResultSeen: false,
        agentId: null,
        expectedDescription: input.description,
      });
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (managedRuntimeState(ctx.cwd) === "inactive" || event.toolName !== "Agent") return;
    const dispatched = managedDispatches.get(event.toolCallId);
    if (!dispatched) return;
    dispatched.toolResultSeen = true;
    if (dispatched.usageCounted === true) {
      managedDispatches.delete(event.toolCallId);
      if (dispatched.agentId) workerDispatchByAgentId.delete(dispatched.agentId);
    }
    const pending = router.getPendingRequest();
    if (!pending || pending.requestId !== dispatched.requestId || pending.taskId !== dispatched.taskId) return;
    if (!event.isError) return;
    try {
      const currentState = router.getState();
      const reason = event.content?.find?.((part) => part?.type === "text")?.text ?? "Managed Agent execution failed.";
      const update = dispatched.role === "validator"
        ? router.recordValidation({
            role: currentState.phase === "sol-recovery" ? "sol" : "luna",
            requestId: dispatched.requestId,
            report: {
              passed: false,
              reason,
              current_error: { type: "agent_execution_failure", message: reason, log: reason },
            },
          })
        : router.gate(currentState.phase === "sol-recovery" ? "sol_failed" : "luna_failed", {
            reason,
            errorLog: reason,
          });
      persistState(update.previousSnapshot);
    } catch {
      // Pi still reports the original Agent failure. State restoration remains available via session snapshot/reset.
    }
  });

  pi.registerTool({
    name: "sol_luna_validate",
    label: "Sol-Luna Safe Validation",
    description: "Run syntax-only or non-executing repository checks without project scripts, shell parsing, redirection, or arbitrary code loading.",
    parameters: Type.Object({
      check: StringEnum(["node-check", "json-check", "git-diff-check", "git-status"]),
      path: Type.Optional(Type.String({ description: "Project-relative .js/.mjs/.cjs or JSON file for syntax-only checks." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      assertRuntimeEnabled(ctx);
      let command;
      let baseArgs;
      if (params.check === "git-diff-check") [command, baseArgs] = ["git", ["diff", "--check"]];
      else if (params.check === "git-status") [command, baseArgs] = ["git", ["status", "--short"]];
      else {
        if (!params.path) throw new Error(`${params.check} requires a project-relative path.`);
        const absolute = assertProjectPath(ctx.cwd, params.path);
        const projectRelative = relative(realpathSync(ctx.cwd), absolute);
        if (params.check === "node-check") {
          if (!/\.(?:cjs|mjs|js)$/iu.test(absolute)) throw new Error("node-check accepts only .js, .mjs, or .cjs files.");
          [command, baseArgs] = ["node", ["--check", absolute]];
        } else {
          if (!/\.json$/iu.test(absolute)) throw new Error("json-check accepts only .json files.");
          JSON.parse(readFileSync(absolute, "utf8"));
          return resultText(`${params.check}: valid`, router.getState(), { check: params.check, passed: true, path: projectRelative });
        }
      }
      const result = await pi.exec(command, baseArgs, { signal, cwd: ctx.cwd });
      const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
      return resultText(`${params.check}: exit=${result.code}\n${output}`.trim(), router.getState(), {
        check: params.check,
        exitCode: result.code,
        passed: result.code === 0,
      });
    },
  });

  pi.registerTool({
    name: "sol_luna_gate",
    label: "Sol-Luna Gate",
    description: "Start tasks, mark planning ready, and inspect runtime state. Validation outcomes must use sol_luna_record_result.",
    promptSnippet: "Start a Sol-Luna task or inspect its runtime state",
    promptGuidelines: [
      "Use sol_luna_gate with start_task before preparing the first worker, and use status when runtime state is uncertain.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start_task", "plan_ready", "status"]),
      task_label: Type.Optional(Type.String({ description: "Short label for a new task." })),
      task_id: Type.Optional(Type.String({ description: "Stable task identifier for a new task." })),
      objective: Type.Optional(Type.String({ description: "Task objective." })),
      task_type: Type.Optional(Type.String({ description: "Stable task category used for feedback and model ranking." })),
      acceptance: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria." })),
      constraints: Type.Optional(Type.Array(Type.String(), { description: "Task constraints." })),
      complexity: Type.Optional(StringEnum(["low", "medium", "high"])),
      reason: Type.Optional(Type.String({ description: "Evidence for a validation or recovery failure." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertRuntimeEnabled(ctx);
      const pendingPlannerCandidate = params.action === "start_task" ? pendingPlannerUsage.get(_toolCallId) : null;
      if (_toolCallId) pendingPlannerUsage.delete(_toolCallId);
      if (!["start_task", "plan_ready", "status"].includes(params.action)) {
        throw new Error("Validation pass/failure actions must be recorded with sol_luna_record_result.");
      }
      if (params.action === "status") {
        const state = router.getState();
        return resultText(formatState(state), state, { memory: router.getMemory() });
      }
      let reasoningProfile;
      if (params.action === "start_task") {
        managedDispatches.clear();
        workerDispatchByAgentId.clear();
      }
      if (params.action === "start_task" && ctx) {
        const { config } = effectiveModelRoutes(ctx, projectPaths(ctx.cwd));
        const plannerResolution = resolveProjectModels(ctx, config, { complexity: params.complexity ?? "medium" });
        reasoningProfile = {
          taskId: params.task_id,
          complexity: params.complexity ?? "medium",
          roles: {
            planner: { thinking: plannerResolution.roles.planner.thinking },
            luna: { thinking: plannerResolution.roles.luna.thinking },
            validator: {
              fast: { thinking: plannerResolution.roles.validator.thinking },
              deep: {
                thinking: clampThinking(
                  plannerResolution.selections.validator
                    ? ctx.modelRegistry?.find?.(
                        plannerResolution.selections.validator.provider,
                        plannerResolution.selections.validator.model,
                      )
                    : null,
                  deepValidatorThinking(plannerResolution.roles.validator.thinking),
                  ctx,
                ),
              },
            },
            sol: { thinking: plannerResolution.roles.sol.thinking },
          },
        };
        const planner = plannerResolution.selections.planner;
        if (planner && typeof pi.setModel === "function") {
          const model = ctx.modelRegistry?.find?.(planner.provider, planner.model);
          if (model && await pi.setModel(model) === false) throw new Error(`Planner model ${modelReference(planner)} has no configured authentication.`);
        }
        if (typeof pi.setThinkingLevel === "function") {
          pi.setThinkingLevel(planner?.thinking ?? plannerResolution.roles.planner.thinking);
        }
      }
      const update = router.gate(
        params.action,
        params.action === "start_task"
          ? {
              taskId: params.task_id,
              taskLabel: params.task_label,
              objective: params.objective,
              taskType: params.task_type,
              acceptance: params.acceptance,
              constraints: params.constraints,
              complexity: params.complexity,
              reasoningProfile,
            }
          : { reason: params.reason },
      );
      persistState(update.previousSnapshot);
      if (pendingPlannerCandidate && ctx && pendingPlannerCandidate.projectId === projectIdentity(ctx.cwd)) {
        eligiblePlannerMessages.add(pendingPlannerCandidate.key);
      }
      return resultText(`Gate updated: ${formatState(update.state)}`, update.state, { memory: router.getMemory() });
    },
  });

  pi.registerTool({
    name: "sol_luna_prepare_worker",
    label: "Prepare Sol-Luna Worker",
    description: "Create the role-scoped Context Envelope, token budget, Failure Snapshot reference, and cache-friendly prompt for the next managed Agent call.",
    promptSnippet: "Prepare the next Luna, Validator, or Sol worker request",
    promptGuidelines: [
      "Call sol_luna_prepare_worker immediately before every managed Agent call and pass rendered_prompt as the Agent task unchanged.",
    ],
    parameters: Type.Object({
      role: StringEnum(["luna", "validator", "sol"]),
      instruction: Type.String({ description: "Current task instruction for this worker." }),
      complexity: Type.Optional(StringEnum(["low", "medium", "high"])),
      validator_mode: Type.Optional(StringEnum(["fast", "deep"])),
      max_input_tokens: Type.Optional(Type.Integer({ minimum: 256 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertRuntimeEnabled(ctx);
      let routing;
      const effectiveComplexity = params.complexity ?? router.getReasoningProfile()?.complexity ?? "medium";
      if (ctx) {
        const { config } = effectiveModelRoutes(ctx, projectPaths(ctx.cwd));
        const resolution = resolveProjectModels(ctx, config, {
          complexity: effectiveComplexity,
          taskType: router.getMemory().task.taskType ?? effectiveComplexity,
          performanceStore: router.getModelPerformanceStore(),
        });
        routing = resolution.selections[params.role];
        if (!routing) throw new Error(`No available model route for ${params.role}.`);
      }
      const update = router.prepareWorkerRequest({
        role: params.role,
        instruction: params.instruction,
        complexity: params.complexity,
        validatorMode: params.validator_mode,
        maxInputTokens: params.max_input_tokens,
        routing,
      });
      if (!update.allowed) {
        return resultText(`Worker blocked: ${update.reason}`, update.state, { blocked: true, reason: update.reason });
      }
      persistState(update.previousSnapshot);
      return resultText(update.request.renderedPrompt, update.state, {
        request: update.request,
        request_id: update.request.requestId,
        context_id: update.request.contextId,
        snapshot_id: update.request.snapshotId,
        rendered_prompt: update.request.renderedPrompt,
      });
    },
  });

  pi.registerTool({
    name: "sol_luna_record_result",
    label: "Record Sol-Luna Result",
    description: "Record the exact structured worker or Validator JSON result into Task/Artifact/Failure Memory and advance validation or recovery state.",
    promptSnippet: "Record a Luna, Validator, or Sol structured result",
    promptGuidelines: [
      "Call sol_luna_record_result after every managed Agent result; do not summarize away failed test evidence or Failure Snapshot details.",
    ],
    parameters: Type.Object({
      role: StringEnum(["luna", "validator", "sol"]),
      report_json: Type.String({ description: "Exact JSON object returned by the worker." }),
      request_id: Type.Optional(Type.String({ description: "Request ID returned by sol_luna_prepare_worker." })),
      implementation_role: Type.Optional(StringEnum(["luna", "sol"], { description: "For Validator reports, which implementation is being validated." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertRuntimeEnabled(ctx ?? activeSession?.ctx);
      let report;
      try {
        report = JSON.parse(params.report_json);
        if (!isPlainObject(report)) throw new Error("report_json must contain one JSON object.");
        report = validateWorkerOutput(params.role, report);
      } catch (error) {
        const malformed = error instanceof Error ? error : new Error(String(error));
        const pending = router.getPendingRequest();
        if (pending?.role === params.role && pending.dispatched === true) {
          const currentState = router.getState();
          const failure = params.role === "validator" && pending.validatorMode === "fast"
            ? router.recordValidation({
                role: currentState.phase === "sol-recovery" ? "sol" : "luna",
                requestId: pending.requestId,
                report: {
                  passed: false,
                  reason: `Invalid Fast Validator structured output: ${malformed.message}`,
                  current_error: { type: "invalid_validator_output", message: malformed.message, log: malformed.stack ?? malformed.message },
                },
              })
            : router.gate(currentState.phase === "sol-recovery" ? "sol_failed" : "luna_failed", {
                reason: `Invalid ${params.role} structured output: ${malformed.message}`,
                errorLog: malformed.stack ?? malformed.message,
              });
          persistState(failure.previousSnapshot);
        }
        throw malformed;
      }

      const update = params.role === "validator"
        ? router.recordValidation({
            role: params.implementation_role ?? (router.getState().phase === "sol-recovery" ? "sol" : "luna"),
            report,
            requestId: params.request_id,
          })
        : router.recordWorkerReport({ role: params.role, report, requestId: params.request_id });
      persistState(update.previousSnapshot);
      return resultText(`Result recorded: ${formatState(update.state)}`, update.state, {
        memory: router.getMemory(),
        failure_snapshot: router.getFailureSnapshot(),
      });
    },
  });

  pi.registerTool({
    name: "sol_luna_record_usage",
    label: "Record Sol-Luna Usage",
    description: "Record bounded token, latency, success, and optional model-performance feedback for dynamic budgets and model ranking.",
    promptSnippet: "Record observed worker usage feedback",
    parameters: Type.Object({
      request_id: Type.String(),
      role: StringEnum(["luna", "validator", "sol"]),
      input_tokens: Type.Integer({ minimum: 0 }),
      output_tokens: Type.Integer({ minimum: 0 }),
      latency_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      success: Type.Boolean(),
      truncated: Type.Optional(Type.Boolean()),
      validator_mode: Type.Optional(StringEnum(["fast", "deep"])),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      task_type: Type.Optional(Type.String()),
      quality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      cost: Type.Optional(Type.Number({ minimum: 0 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      assertRuntimeEnabled(ctx ?? activeSession?.ctx);
      const previousSnapshot = router.snapshot();
      try {
        router.recordUsageFeedback({
          requestId: params.request_id,
          role: params.role,
          inputTokens: params.input_tokens,
          outputTokens: params.output_tokens,
          latencyMs: params.latency_ms,
          success: params.success,
          truncated: params.truncated,
          validatorMode: params.validator_mode,
          taskType: params.task_type,
        });
        if (params.provider && params.model) {
          router.recordModelFeedback({
            provider: params.provider,
            model: params.model,
            taskType: params.task_type ?? router.getMemory().task.taskType ?? "general",
            success: params.success,
            quality: params.quality ?? (params.success ? 1 : 0),
            cost: params.cost ?? 0,
            latencyMs: params.latency_ms ?? 0,
            samples: 1,
          });
        }
        persistState(previousSnapshot);
      } catch (error) {
        router.restore(previousSnapshot);
        throw error;
      }
      return resultText(`Usage recorded: ${formatState(router.getState())}`, router.getState(), {
        usage_feedback: router.getMemory().runtime.usageFeedback,
      });
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

  pi.registerCommand("sol-luna-disable", {
    description: "Pause Sol-Luna orchestration for the current project",
    handler: async (_args, ctx) => {
      if (!requireTrusted(ctx)) return;
      try {
        const paths = projectPaths(ctx.cwd);
        const current = readProjectRuntimeState(paths).state;
        if (current.paused) {
          notify(ctx, "Sol-Luna is already paused for this project.", "info");
          return;
        }
        writeProjectRuntimeState(paths, true);
        clearTransientCorrelations();
        if (activeSession?.projectId === projectIdentity(ctx.cwd)) activeSession = { ...activeSession, ctx, paused: true, runtimeInvalid: false };
        startTokenUiWatcher(ctx);
        applyTokenWidget(ctx);
        notify(ctx, "Sol-Luna paused for the current project. Managed files, routes, router state, token totals, and token UI preference were preserved.", "success");
      } catch (error) {
        notify(ctx, `Sol-Luna pause failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-enable", {
    description: "Resume Sol-Luna orchestration for the current project",
    handler: async (_args, ctx) => {
      if (!requireTrusted(ctx)) return;
      try {
        const paths = projectPaths(ctx.cwd);
        const current = readProjectRuntimeState(paths, { repairInvalid: true });
        writeProjectRuntimeState(paths, false);
        const projectId = projectIdentity(ctx.cwd);
        if (activeSession?.projectId === projectId) activeSession = { ...activeSession, ctx, paused: false, runtimeInvalid: false };
        refreshTokenUiState(ctx);
        startTokenUiWatcher(ctx);
        applyTokenWidget(ctx);
        notify(ctx, `Sol-Luna enabled for the current project${current.repaired ? " (repaired the malformed runtime state file)" : ""}. Router state, managed files, routes, token totals, and token UI preference were preserved.`, "success");
      } catch (error) {
        notify(ctx, `Sol-Luna resume failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-status", {
    description: "Show Sol-Luna dependency, files, version, pause, and circuit status",
    handler: async (_args, ctx) => {
      try {
        statusReport(pi, ctx, router.getState());
      } catch (error) {
        notify(ctx, `Sol-Luna status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-models", {
    description: "Interactively configure or automatically discover explicit Sol-Luna model routes",
    getArgumentCompletions(prefix) {
      const values = ["configure", "status", "auto", "auto --force", "reset", "reset --force", "set"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        const parsed = parseModelCommandArguments(args);
        if (parsed.action === "status") {
          if (Object.keys(parsed.options).length > 0) throw new Error("status does not accept options.");
          notify(ctx, modelConfigurationStatus(ctx), "info");
          return;
        }
        if (parsed.action === "configure" && Object.keys(parsed.options).some((key) => key !== "force")) {
          throw new Error("configure accepts only --force.");
        }
        if (!requireTrusted(ctx)) return;
        const paths = projectPaths(ctx.cwd);
        const routeFileExists = readText(paths.modelRoutes) !== undefined;
        let proposed;
        if (parsed.action === "configure") {
          proposed = await interactiveModelRoutes(ctx);
          if (!proposed) {
            notify(ctx, "Sol-Luna model configuration cancelled; no files were changed.", "info");
            return;
          }
        } else if (parsed.action === "set") {
          proposed = explicitModelRoutes(ctx, parsed.options);
        } else {
          if (Object.keys(parsed.options).some((key) => key !== "force")) {
            throw new Error(`${parsed.action} accepts only --force.`);
          }
          proposed = automaticModelRoutes(ctx);
        }

        if (routeFileExists && !parsed.options.force) {
          if (!ctx.hasUI) {
            notify(ctx, `An explicit ${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE} already exists. Re-run with --force to replace it.`, "warning");
            return;
          }
          const confirmed = await ctx.ui.confirm(
            "Replace Sol-Luna model routes?",
            `${routesSummary(proposed)}\n\nThis replaces ${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE} and re-renders managed workers.`,
          );
          if (!confirmed) {
            notify(ctx, "Sol-Luna model configuration cancelled; no files were changed.", "info");
            return;
          }
        } else if (ctx.hasUI && parsed.action === "configure") {
          const confirmed = await ctx.ui.confirm("Create Sol-Luna model routes?", routesSummary(proposed));
          if (!confirmed) {
            notify(ctx, "Sol-Luna model configuration cancelled; no files were changed.", "info");
            return;
          }
        }

        await syncProject(pi, ctx, parsed.options.force === true, "Sol-Luna model configuration", {
          modelRoutesOverride: proposed,
        });
      } catch (error) {
        notify(ctx, `Sol-Luna model configuration failed: ${error instanceof Error ? error.message : String(error)}\n\n${modelCommandUsage()}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-token-ui", {
    description: "Toggle or inspect current-project Sol-Luna token-share visualization",
    getArgumentCompletions(prefix) {
      const values = ["on", "off", "status", "reset"];
      const matches = values.filter((value) => value.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = tokenizeCommandArguments(args);
      if (tokens.length !== 1 || !["on", "off", "status", "reset"].includes(tokens[0])) {
        notify(ctx, "Usage: /sol-luna-token-ui on|off|status|reset", "error");
        return;
      }
      const action = tokens[0];
      const projectId = projectIdentity(ctx.cwd);
      const paths = projectPaths(projectId);
      if (action === "status") {
        try {
          const state = readProjectTokenState(paths).state;
          const percentages = projectTokenPercentages(state);
          notify(ctx, [
            `Sol-Luna token UI: ${state.visible ? "on" : "off"}`,
            `Scope: current project only (${projectId})`,
            `Tokens: P=${state.tokens.planner}, L=${state.tokens.luna}, V=${state.tokens.validator}, S=${state.tokens.sol}`,
            `Shares: P(${percentages.planner}%),L(${percentages.luna}%),V(${percentages.validator}%),S(${percentages.sol}%)`,
            `State file: ${paths.tokenUi}`,
            `Rendering: ${ctx.mode === "tui" ? "available in this TUI" : "TUI-only (not rendered in this mode)"}`,
          ].join("\n"), "info");
        } catch (error) {
          notify(ctx, `Sol-Luna token UI status failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (!requireTrusted(ctx)) return;
      try {
        const update = mutateProjectTokenState(projectId, (state) => (
          action === "reset"
            ? resetProjectTokenTotals(state)
            : setProjectTokenVisibility(state, action === "on")
        ), { repairInvalid: action === "reset" });
        if (!activeSession || activeSession.projectId === projectId) {
          let paused = false;
          let runtimeInvalid = false;
          try {
            paused = readProjectRuntimeState(paths).state.paused;
          } catch (runtimeError) {
            paused = true;
            runtimeInvalid = true;
            warnTokenUiOnce(ctx, runtimeError);
          }
          tokenUiState = update.state;
          activeSession = { ctx, projectId, paused, runtimeInvalid };
          startTokenUiWatcher(ctx);
          applyTokenWidget(ctx);
          requestTokenWidgetRender();
        }
        const message = action === "reset"
          ? `Reset Sol-Luna token totals for the current project only${update.repaired ? " and repaired the malformed project token file" : ""}; visibility remains ${update.state.visible ? "on" : "off"}. /sol-luna-reset still resets only the session circuit.`
          : `Sol-Luna token-share visualization ${action === "on" ? "enabled" : "disabled"} for the current project. Accounting remains project-local and continues while hidden.`;
        notify(ctx, message, "success");
      } catch (error) {
        notify(ctx, `Sol-Luna token UI update failed: ${error instanceof Error ? error.message : String(error)}`, "error");
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
        const markerAgentNames = Object.keys(marker.managedFiles)
          .map((relative) => relative.match(/^agents\/(.+)\.md$/u)?.[1])
          .filter(Boolean);
        const modified = [];
        for (const name of markerAgentNames) {
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
        for (const name of markerAgentNames) removeRegularFile(join(paths.agentsDir, `${name}.md`));
        removeRegularFile(paths.marker);
        notify(ctx, `Removed Sol-Luna-managed agents and marker; ${CONFIG_DIR_NAME}/${MODEL_ROUTES_FILE} and unrelated project configuration were preserved.`, "success");
        await ctx.reload();
      } catch (error) {
        notify(ctx, `Sol-Luna removal failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("sol-luna-reset", {
    description: "Reset the current session's Sol-Luna circuit state",
    handler: async (_args, ctx) => {
      managedDispatches.clear();
      const update = router.reset();
      persistState(update.previousSnapshot);
      notify(ctx, "Sol-Luna circuit reset for the current session only.", "info");
    },
  });
}

export default createPiAdapter;
