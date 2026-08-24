const DEFAULT_MAX_RECORDS = 100;

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

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finite(value, fallback));
}

function unitInterval(value, fallback = 0) {
  return Math.min(1, nonNegative(value, fallback));
}

function positiveInteger(value, fallback = 1) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function maxRecords(options) {
  const sources = [options, isObject(options?.limits) ? options.limits : null];
  for (const source of sources) {
    if (!source) continue;
    for (const key of ["maxRecords", "records", "modelRecords", "limit"]) {
      if (Number.isInteger(source[key]) && source[key] >= 0) return source[key];
    }
  }
  return DEFAULT_MAX_RECORDS;
}

function normalizeSuccess(source, samples) {
  if (source.successRate !== undefined) {
    return Math.min(1, nonNegative(source.successRate)) * samples;
  }
  if (source.success === true) return samples;
  if (source.success === false) return 0;
  return Math.min(samples, nonNegative(source.success));
}

function normalizeRecord(value) {
  const source = isObject(value) ? value : {};
  const samples = positiveInteger(source.samples);
  return {
    provider: text(source.provider),
    model: text(source.model),
    taskType: text(source.taskType),
    success: normalizeSuccess(source, samples),
    quality: unitInterval(source.quality),
    cost: nonNegative(source.cost),
    latencyMs: nonNegative(source.latencyMs),
    samples,
  };
}

function keyOf(value) {
  return `${value.provider}\u0000${value.model}\u0000${value.taskType}`;
}

function mergeRecords(left, right) {
  const samples = left.samples + right.samples;
  const weighted = (field) => (
    (left[field] * left.samples + right[field] * right.samples) / samples
  );
  return {
    provider: left.provider,
    model: left.model,
    taskType: left.taskType,
    success: left.success + right.success,
    quality: weighted("quality"),
    cost: weighted("cost"),
    latencyMs: weighted("latencyMs"),
    samples,
  };
}

export function normalizeModelPerformanceStore(value = {}, options = {}) {
  const sourceRecords = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.records)
      ? value.records
      : isObject(value) && Array.isArray(value.entries)
        ? value.entries
        : [];
  const records = [];
  const positions = new Map();
  for (const source of sourceRecords) {
    const record = normalizeRecord(source);
    if (!record.provider || !record.model) continue;
    const key = keyOf(record);
    if (positions.has(key)) {
      const oldPosition = positions.get(key);
      const merged = mergeRecords(records[oldPosition], record);
      records.splice(oldPosition, 1);
      for (const [knownKey, position] of positions) {
        if (position > oldPosition) positions.set(knownKey, position - 1);
      }
      positions.delete(key);
      records.push(merged);
      positions.set(key, records.length - 1);
    } else {
      records.push(record);
      positions.set(key, records.length - 1);
    }
  }
  const limit = maxRecords(options);
  return { records: records.slice(Math.max(0, records.length - limit)) };
}

export function recordModelPerformance(store, performance, options = {}) {
  if (!isObject(performance)) throw new TypeError("recordModelPerformance requires a performance object.");
  const clean = normalizeRecord(performance);
  if (!clean.provider || !clean.model) {
    throw new Error("recordModelPerformance requires non-empty provider and model fields.");
  }
  const normalized = normalizeModelPerformanceStore(store, options);
  return normalizeModelPerformanceStore({
    records: [...normalized.records, clean],
  }, options);
}

function normalizedPenalty(value, minimum, maximum) {
  if (maximum <= minimum) return 0;
  return (value - minimum) / (maximum - minimum);
}

function defaultScore(performance, ranges) {
  const successRate = performance.samples > 0 ? performance.success / performance.samples : 0;
  return successRate * 0.5
    + performance.quality * 0.3
    - normalizedPenalty(performance.cost, ranges.minCost, ranges.maxCost) * 0.1
    - normalizedPenalty(performance.latencyMs, ranges.minLatency, ranges.maxLatency) * 0.1;
}

function customScore(scorer, candidate, metrics, fallback, taskType) {
  if (typeof scorer !== "function") return fallback;
  try {
    const result = scorer.length >= 2
      ? scorer(clone(candidate), clone(metrics), fallback)
      : scorer({
          candidate: clone(candidate),
          performance: clone(metrics),
          metrics: clone(metrics),
          taskType,
          defaultScore: fallback,
        });
    return typeof result === "number" && Number.isFinite(result) ? result : fallback;
  } catch {
    return fallback;
  }
}

function candidateKey(candidate, taskType) {
  return keyOf({
    provider: text(candidate?.provider),
    model: text(candidate?.model),
    taskType,
  });
}

export function rankModelCandidates(storeOrCandidates, candidatesOrStore, options = {}) {
  if (typeof options === "string") options = { taskType: options };
  const candidatesFirst = Array.isArray(storeOrCandidates);
  const candidates = candidatesFirst ? storeOrCandidates : candidatesOrStore;
  const store = candidatesFirst ? candidatesOrStore : storeOrCandidates;
  if (!Array.isArray(candidates)) throw new TypeError("rankModelCandidates requires a candidates array.");

  const normalized = normalizeModelPerformanceStore(store, options);
  const taskType = text(options.taskType);
  const records = new Map(normalized.records.map((record) => [keyOf(record), record]));
  const isAvailable = typeof options.isAvailable === "function"
    ? options.isAvailable
    : (candidate) => candidate?.available !== false;
  const availablePositions = [];
  const ranked = candidates.map((candidate, index) => {
    const copy = clone(candidate);
    let available = false;
    try {
      available = isAvailable(copy) === true;
    } catch {
      available = false;
    }
    if (available) availablePositions.push(index);
    const resolvedTaskType = taskType || text(candidate?.taskType);
    return {
      candidate: copy,
      index,
      available,
      taskType: resolvedTaskType,
      performance: records.get(candidateKey(candidate, resolvedTaskType)) ?? null,
    };
  });

  const withHistory = ranked.filter((item) => item.available && item.performance);
  const costs = withHistory.map((item) => item.performance.cost);
  const latencies = withHistory.map((item) => item.performance.latencyMs);
  const ranges = {
    minCost: costs.length ? Math.min(...costs) : 0,
    maxCost: costs.length ? Math.max(...costs) : 0,
    minLatency: latencies.length ? Math.min(...latencies) : 0,
    maxLatency: latencies.length ? Math.max(...latencies) : 0,
  };

  const available = ranked
    .filter((item) => item.available)
    .map((item) => {
      if (!item.performance) return { ...item, hasHistory: false, score: 0 };
      const metrics = {
        ...item.performance,
        successRate: item.performance.samples > 0 ? item.performance.success / item.performance.samples : 0,
        normalizedCost: normalizedPenalty(item.performance.cost, ranges.minCost, ranges.maxCost),
        normalizedLatency: normalizedPenalty(item.performance.latencyMs, ranges.minLatency, ranges.maxLatency),
      };
      const fallback = defaultScore(item.performance, ranges);
      return {
        ...item,
        hasHistory: true,
        score: customScore(options.scorer, item.candidate, metrics, fallback, item.taskType),
      };
    })
    .sort((left, right) => (
      Number(right.hasHistory) - Number(left.hasHistory)
      || right.score - left.score
      || left.index - right.index
    ));

  const result = ranked.map((item) => item.candidate);
  for (let index = 0; index < availablePositions.length; index += 1) {
    result[availablePositions[index]] = available[index].candidate;
  }
  return result;
}
