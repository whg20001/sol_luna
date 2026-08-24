export const RUNTIME_EVENT_TYPES = Object.freeze([
  "task_started",
  "reasoning_profile_frozen",
  "agent_selected",
  "context_projected",
  "context_compressed",
  "worker_dispatched",
  "worker_failed",
  "validation_started",
  "validation_completed",
  "snapshot_created",
  "recovery_started",
  "usage_recorded",
  "task_completed",
  "task_escalated",
]);

const EVENT_TYPE_SET = new Set(RUNTIME_EVENT_TYPES);
const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_LOG_CHARACTERS = 4_000;
const DEFAULT_METADATA_CHARACTERS = 8_000;
const DEFAULT_METADATA_ENTRIES = 50;
const DEFAULT_METADATA_DEPTH = 5;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value) {
  return text(value) || null;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function limit(options, names, fallback) {
  const sources = [options, isObject(options?.limits) ? options.limits : null];
  for (const source of sources) {
    if (!source) continue;
    for (const name of names) {
      if (Number.isInteger(source[name]) && source[name] >= 0) return source[name];
    }
  }
  return fallback;
}

function truncate(value, maximum) {
  const source = typeof value === "string" ? value : value == null ? "" : String(value);
  if (source.length <= maximum) return source;
  if (maximum <= 1) return source.slice(0, maximum);
  return `${source.slice(0, maximum - 1)}…`;
}

function sanitizeMetadata(value, options) {
  const maxCharacters = limit(options, ["maxMetadataCharacters", "metadataCharacters"], DEFAULT_METADATA_CHARACTERS);
  const maxEntries = limit(options, ["maxMetadataEntries", "metadataEntries"], DEFAULT_METADATA_ENTRIES);
  const maxDepth = limit(options, ["maxMetadataDepth", "metadataDepth"], DEFAULT_METADATA_DEPTH);
  let remaining = maxCharacters;
  let entries = 0;
  const seen = new WeakSet();

  function visit(item, depth) {
    if (remaining <= 0 || entries >= maxEntries) return undefined;
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      if (typeof item === "number" && !Number.isFinite(item)) return null;
      const size = JSON.stringify(item).length;
      if (size > remaining) return undefined;
      remaining -= size;
      entries += 1;
      return item;
    }
    if (typeof item === "string") {
      const clean = truncate(item, Math.max(0, remaining - 2));
      remaining -= Math.min(remaining, JSON.stringify(clean).length);
      entries += 1;
      return clean;
    }
    if (typeof item === "bigint") return visit(String(item), depth);
    if (typeof item !== "object" || item === undefined) return undefined;
    if (depth >= maxDepth || seen.has(item)) return "[bounded]";
    seen.add(item);
    if (Array.isArray(item)) {
      const result = [];
      for (const child of item) {
        const clean = visit(child, depth + 1);
        if (clean !== undefined) result.push(clean);
        if (remaining <= 0 || entries >= maxEntries) break;
      }
      return result;
    }
    const result = {};
    for (const key of Object.keys(item).sort()) {
      if (remaining <= 0 || entries >= maxEntries) break;
      const clean = visit(item[key], depth + 1);
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  }

  const result = isObject(value) ? visit(value, 0) ?? {} : {};
  while (JSON.stringify(result).length > Math.max(2, maxCharacters)) {
    const keys = Object.keys(result).sort();
    if (keys.length === 0) break;
    delete result[keys.at(-1)];
  }
  return result;
}

function timestamp(value, options) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const supplied = value instanceof Date || typeof value === "number"
    ? value
    : typeof options.now === "function"
      ? options.now()
      : options.now;
  const date = supplied instanceof Date ? supplied : supplied == null ? new Date() : new Date(supplied);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function createRuntimeEvent(typeOrInput, inputOrOptions = {}, maybeOptions = {}) {
  const objectForm = isObject(typeOrInput);
  const source = objectForm ? typeOrInput : isObject(inputOrOptions) ? inputOrOptions : {};
  const options = objectForm ? inputOrOptions : maybeOptions;
  const type = objectForm ? text(source.type) : text(typeOrInput);
  if (!EVENT_TYPE_SET.has(type)) {
    throw new Error(`Unknown runtime event type: ${type || "(empty)"}.`);
  }
  const logCharacters = limit(options, ["maxLogCharacters", "logCharacters"], DEFAULT_LOG_CHARACTERS);
  return {
    type,
    taskId: optionalText(source.taskId ?? source.task_id),
    contextId: optionalText(source.contextId ?? source.context_id),
    role: optionalText(source.role),
    attempt: nonNegativeInteger(source.attempt),
    revision: nonNegativeInteger(source.revision),
    timestamp: timestamp(source.timestamp ?? source.createdAt, options),
    message: text(source.message ?? source.reason ?? source.summary),
    log: truncate(source.log ?? source.output ?? source.errorLog, logCharacters),
    metadata: sanitizeMetadata(source.metadata ?? source.details ?? source.data, options),
  };
}

function eventLimit(options) {
  return limit(options, ["maxEvents", "runtimeEvents", "events"], DEFAULT_MAX_EVENTS);
}

function append(events, event, options) {
  const values = Array.isArray(events) ? events.map((item) => clone(item)) : [];
  values.push(event);
  const maximum = eventLimit(options);
  return values.slice(Math.max(0, values.length - maximum));
}

export function appendRuntimeLifecycleEvent(lifecycle, eventOrType, detailsOrOptions = {}, maybeOptions = {}) {
  const stringForm = typeof eventOrType === "string";
  const options = stringForm ? maybeOptions : detailsOrOptions;
  const clean = stringForm
    ? createRuntimeEvent(eventOrType, detailsOrOptions, options)
    : createRuntimeEvent(eventOrType, options);
  if (Array.isArray(lifecycle)) return append(lifecycle, clean, options);

  const source = isObject(lifecycle) ? clone(lifecycle) : {};
  if (isObject(source.runtime)) {
    source.runtime = { ...source.runtime, events: append(source.runtime.events, clean, options) };
    return source;
  }
  source.events = append(source.events, clean, options);
  return source;
}

function diagnostic(error) {
  return {
    type: "event_sink_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function emitRuntimeEvent(eventOrSink, sinkOrEvent, detailsOrOptions = {}, maybeOptions = {}) {
  const sinkFirst = typeof eventOrSink === "function";
  const optionSink = !sinkFirst && isObject(sinkOrEvent) && typeof sinkOrEvent.eventSink === "function";
  const eventSink = sinkFirst ? eventOrSink : optionSink ? sinkOrEvent.eventSink : sinkOrEvent;
  const eventInput = sinkFirst ? sinkOrEvent : eventOrSink;
  const stringForm = typeof eventInput === "string";
  const options = optionSink ? sinkOrEvent : stringForm ? maybeOptions : detailsOrOptions;
  const details = optionSink && stringForm ? detailsOrOptions : detailsOrOptions;
  const event = stringForm
    ? createRuntimeEvent(eventInput, details, options)
    : createRuntimeEvent(eventInput, options);
  const success = () => ({ event: clone(event), emitted: true, diagnostic: null });
  const failure = (error) => ({ event: clone(event), emitted: false, diagnostic: diagnostic(error) });

  if (typeof eventSink !== "function") {
    return { event: clone(event), emitted: false, diagnostic: null };
  }
  try {
    const result = eventSink(clone(event));
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then(success, failure);
    }
    return success();
  } catch (error) {
    return failure(error);
  }
}
