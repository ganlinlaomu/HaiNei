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
  | "media"
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
/** Launch milestones are kept apart: a startup history catch-up alone can
 * log a thousand lines within seconds and push them out of the main buffer. */
const MAX_STARTUP_MARKS = 200;
// Trim in chunks so the buffer is not shifted on every append.
const TRIM_SLACK = 200;
// Launch milestones and warnings are also saved on the device, so a launch
// that froze or was killed can still be read from the next launch's export.
const LAUNCH_LOG_KEY = "hainei_launch_log";
const MAX_SAVED_NOTABLE = 100;
const SAVE_DELAY_MS = 200;
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
  let startupBuffer: DebugLogEntry[] = [];
  let notableBuffer: DebugLogEntry[] = [];
  const revision = ref(0);
  const launchStartedAt = Date.now();
  let previousLaunch: unknown = null;
  let previousLoaded: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAliveAt = 0;

  async function saveLaunch() {
    try {
      const { getDeviceValue, putDeviceValue } = await import("@/services/deviceStorage");
      previousLoaded ??= getDeviceValue(LAUNCH_LOG_KEY).then(raw => {
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && saved.startedAt !== launchStartedAt) previousLaunch = saved;
      }).catch(() => undefined);
      await previousLoaded;
      await putDeviceValue(LAUNCH_LOG_KEY, JSON.stringify({ startedAt: launchStartedAt, lastAliveAt, startup: startupBuffer, notable: notableBuffer }));
    } catch {
      // Diagnostics only; never disturb the app.
    }
  }

  function scheduleSave() {
    if (saveTimer || import.meta.env.MODE === "test" || typeof indexedDB === "undefined") return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveLaunch();
    }, SAVE_DELAY_MS);
  }

  const entries = computed<DebugLogEntry[]>(() => {
    void revision.value;
    return buffer.length > MAX_LOGS ? buffer.slice(-MAX_LOGS) : buffer.slice();
  });

  function append(entry: NewDebugLogEntry, data: Record<string, unknown> | undefined) {
    const ts = entry.ts ?? Date.now();
    const record: DebugLogEntry = {
      id: entry.id ?? nextId(ts),
      ts,
      level: entry.level,
      category: entry.category,
      event: entry.event,
      ...(data ? { data } : {})
    };
    buffer.push(record);
    if (record.event.startsWith("startup_")) {
      startupBuffer.push(record);
      if (startupBuffer.length > MAX_STARTUP_MARKS) startupBuffer = startupBuffer.slice(-MAX_STARTUP_MARKS);
      scheduleSave();
    } else if (record.level === "warn" || record.level === "error") {
      notableBuffer.push(record);
      if (notableBuffer.length > MAX_SAVED_NOTABLE) notableBuffer = notableBuffer.slice(-MAX_SAVED_NOTABLE);
      scheduleSave();
    }
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

  /** Launch milestones, newest last; survives floods of other entries. */
  function startupMarks() {
    return startupBuffer.slice();
  }

  /** Periodic "page still responsive" stamp, saved with the launch log. */
  function noteAlive() {
    lastAliveAt = Date.now();
    scheduleSave();
  }

  /** The previous launch's saved milestones and warnings, if any. */
  async function previousLaunchLog() {
    previousLoaded ??= import("@/services/deviceStorage")
      .then(({ getDeviceValue }) => getDeviceValue(LAUNCH_LOG_KEY))
      .then(raw => {
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && saved.startedAt !== launchStartedAt) previousLaunch = saved;
      }).catch(() => undefined);
    await previousLoaded;
    return previousLaunch;
  }

  function clear() {
    buffer = [];
    startupBuffer = [];
    notableBuffer = [];
    revision.value++;
  }

  function exportJson() {
    return JSON.stringify(entries.value, null, 2);
  }

  return { entries, add, addSanitized, clear, exportJson, startupMarks, previousLaunchLog, noteAlive };
});
