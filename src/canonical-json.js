// Shared by prompt serialization and content-addressed failure snapshots.
// Keep this module independent of task memory to avoid circular imports.
const KEY_ORDER = Object.freeze([
  "version", "projection", "runtime", "goal", "state", "artifact", "failure", "semantic", "decision",
  "task_id", "context_id", "snapshot_id", "request_id", "role", "stage", "status", "attempt", "events",
  "objective", "acceptance", "constraints", "completed", "pending", "blocked",
  "changed_files", "diff_summary", "tests", "worker_reports", "validation_reports",
  "current_snapshot_id", "snapshot", "snapshots", "attempt_history", "current_error",
  "source_role", "current_progress", "modified_files", "validation", "memory_revision",
  "type", "message", "log",
]);
const KEY_RANK = new Map(KEY_ORDER.map((key, index) => [key, index]));

function compareKeys(left, right) {
  const leftRank = KEY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = KEY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
  return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
}

function canonicalize(value, seen) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") throw new TypeError("canonicalStringify cannot serialize BigInt values.");
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    return value;
  }
  if (seen.has(value)) throw new TypeError("canonicalStringify cannot serialize circular structures.");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => entry === undefined || typeof entry === "function" || typeof entry === "symbol"
      ? null
      : canonicalize(entry, seen));
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort(compareKeys)) {
      const entry = value[key];
      if (entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol") {
        result[key] = canonicalize(entry, seen);
      }
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalStringify(value, space = 0) {
  return JSON.stringify(canonicalize(value, new Set()), null, space);
}
