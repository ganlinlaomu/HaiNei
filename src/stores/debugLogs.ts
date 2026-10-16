import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { sanitizeDebugData } from "@/utils/debugSanitizer";

export type DebugLogLevel = "debug" | "info" | "warn" | "error";
export type DebugLogCategory =
  | "relay"
  | "publish"
  | "subscription"
  | "nip17"
  | "sync"
  | "storage"
  | "ui"
  | "account"
  | "system";

export interface DebugLogEntry {
  id: string;
  ts: number;
  level: DebugLogLevel;
  category: DebugLogCategory;
  event: string;
  data?: Record<string, unknown>;
}

export type NewDebugLogEntry = Omit<DebugLogEntry, "id" | "ts"> &
  Partial<Pick<DebugLogEntry, "id" | "ts">>;

const MAX_LOGS = 1000;
// Trim in chunks so the buffer is not shifted on every append.
const TRIM_SLACK = 200;
let sequence = 0;

function nextId(ts: number) {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${ts.toString(36)}-${sequence.toString(36)}`;
}

// Diagnostics are written on hot paths (every relay frame). Entries live in a
// plain buffer outside Vue's deep reactivity; only a revision counter is
// reactive, and the snapshot is built when something (Debug.vue) reads it.
export const useDebugLogsStore = defineStore("debugLogs", () => {
  let buffer: DebugLogEntry[] = [];
  const revision = ref(0);

  const entries = computed<DebugLogEntry[]>(() => {
    void revision.value;
    return buffer.length > MAX_LOGS ? buffer.slice(-MAX_LOGS) : buffer.slice();
  });

  function append(entry: NewDebugLogEntry, data: Record<string, unknown> | undefined) {
    const ts = entry.ts ?? Date.now();
    buffer.push({
      id: entry.id ?? nextId(ts),
      ts,
      level: entry.level,
      category: entry.category,
      event: entry.event,
      ...(data ? { data } : {})
    });
    if (buffer.length > MAX_LOGS + TRIM_SLACK) buffer = buffer.slice(-MAX_LOGS);
    revision.value++;
  }

  function add(entry: NewDebugLogEntry) {
    append(entry, entry.data ? sanitizeDebugData(entry.data) : undefined);
  }

  /** For debugLog(), which has already sanitized the data for the console. */
  function addSanitized(entry: NewDebugLogEntry) {
    append(entry, entry.data);
  }

  function clear() {
    buffer = [];
    revision.value++;
  }

  function exportJson() {
    return JSON.stringify(entries.value, null, 2);
  }

  return { entries, add, addSanitized, clear, exportJson };
});
