const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_TOP_K = 5;

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

function nonNegativeInteger(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function optionInteger(options, names, fallback) {
  const sources = [options, isObject(options?.limits) ? options.limits : null];
  for (const source of sources) {
    if (!source) continue;
    for (const name of names) {
      if (Number.isInteger(source[name]) && source[name] >= 0) return source[name];
    }
  }
  return fallback;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const tag = text(item);
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

function stableHash(value) {
  const source = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeEntry(value, fallbackRevision = 0, fallbackIndex = 0) {
  const source = isObject(value) ? value : {};
  const base = {
    taskType: text(source.taskType),
    summary: text(source.summary),
    problem: text(source.problem),
    resolution: text(source.resolution),
    tags: normalizeTags(source.tags),
    success: source.success === true,
    createdAtRevision: nonNegativeInteger(source.createdAtRevision, fallbackRevision),
  };
  return {
    id: text(source.id) || `semantic-${stableHash({ ...base, fallbackIndex })}`,
    ...base,
  };
}

function deduplicateNewest(entries) {
  const seen = new Set();
  const result = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!seen.has(entries[index].id)) {
      seen.add(entries[index].id);
      result.push(entries[index]);
    }
  }
  return result.reverse();
}

export function normalizeSemanticMemory(value = {}, options = {}) {
  const sourceEntries = Array.isArray(value)
    ? value
    : isObject(value) && Array.isArray(value.entries)
      ? value.entries
      : [];
  const maxEntries = optionInteger(options, ["maxEntries", "entries", "semanticEntries", "limit"], DEFAULT_MAX_ENTRIES);
  const normalized = sourceEntries.map((entry, index) => normalizeEntry(entry, 0, index));
  const unique = deduplicateNewest(normalized);
  return { entries: unique.slice(Math.max(0, unique.length - maxEntries)) };
}

export function addSemanticEntry(memory, entry, options = {}) {
  if (!isObject(entry)) throw new TypeError("addSemanticEntry requires an entry object.");
  const normalized = normalizeSemanticMemory(memory, options);
  const nextRevision = normalized.entries.reduce(
    (maximum, item) => Math.max(maximum, item.createdAtRevision),
    0,
  ) + 1;
  const clean = normalizeEntry(
    entry,
    nonNegativeInteger(options.revision, nextRevision),
    normalized.entries.length,
  );
  return normalizeSemanticMemory({
    entries: [...normalized.entries.filter((item) => item.id !== clean.id), clean],
  }, options);
}

function tokenize(value) {
  const source = typeof value === "string"
    ? value
    : isObject(value)
      ? Object.keys(value).sort().map((key) => value[key]).flat(Infinity).join(" ")
      : String(value ?? "");
  return source
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
}

function defaultLexicalScore(queryTokens, entry) {
  const wanted = new Set(queryTokens);
  if (wanted.size === 0) return 0;
  const entryTokens = new Set(tokenize([
    entry.taskType,
    entry.summary,
    entry.problem,
    entry.resolution,
    ...entry.tags,
  ]));
  let matches = 0;
  for (const token of wanted) if (entryTokens.has(token)) matches += 1;
  return matches / wanted.size;
}

function pluginScore(scorer, query, entry, queryTokens, fallback) {
  if (typeof scorer !== "function") return fallback;
  try {
    const value = scorer.length >= 2
      ? scorer(query, clone(entry), fallback)
      : scorer({ query: clone(query), entry: clone(entry), queryTokens: [...queryTokens], defaultScore: fallback });
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function retrieveSemanticMemory(memory, query, options = {}) {
  const normalized = normalizeSemanticMemory(memory, options);
  const queryTokens = tokenize(query);
  const topK = optionInteger(options, ["topK"], DEFAULT_TOP_K);
  const minScore = typeof options.minScore === "number" && Number.isFinite(options.minScore)
    ? options.minScore
    : 0.1;

  return normalized.entries
    .map((entry, index) => {
      const fallback = defaultLexicalScore(queryTokens, entry);
      return {
        entry,
        index,
        score: pluginScore(options.scorer, query, entry, queryTokens, fallback),
      };
    })
    .filter(({ score }) => score >= minScore)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, topK)
    .map(({ entry }) => clone(entry));
}
