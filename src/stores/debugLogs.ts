import { defineStore } from "pinia";
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
let sequence = 0;

function nextId(ts: number) {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${ts.toString(36)}-${sequence.toString(36)}`;
}

export const useDebugLogsStore = defineStore("debugLogs", {
  state: () => ({
    entries: [] as DebugLogEntry[]
  }),
  actions: {
    add(entry: NewDebugLogEntry) {
      const ts = entry.ts ?? Date.now();
      this.entries.push({
        id: entry.id ?? nextId(ts),
        ts,
        level: entry.level,
        category: entry.category,
        event: entry.event,
        ...(entry.data ? { data: sanitizeDebugData(entry.data) } : {})
      });
      if (this.entries.length > MAX_LOGS) {
        this.entries.splice(0, this.entries.length - MAX_LOGS);
      }
    },
    clear() {
      this.entries.splice(0);
    },
    exportJson() {
      return JSON.stringify(this.entries, null, 2);
    }
  }
});
