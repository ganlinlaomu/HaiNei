import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { useDebugLogsStore } from "@/stores/debugLogs";
import { startupMark } from "@/utils/debugLog";

describe("startup timing marks", () => {
  it("records milliseconds since page load and the step details", () => {
    setActivePinia(createPinia());
    startupMark("push_hint_event", { from: "relay", fetchMs: 812 });
    const entry = useDebugLogsStore().entries.find(item => item.event === "startup_push_hint_event")!;
    expect(entry.category).toBe("system");
    expect(entry.data).toMatchObject({ from: "relay", fetchMs: 812 });
    expect(typeof entry.data?.ms).toBe("number");
  });

  it("keeps launch milestones even when a flood of other entries fills the log", () => {
    setActivePinia(createPinia());
    startupMark("session_restored", { loggedIn: true });
    const logs = useDebugLogsStore();
    for (let index = 0; index < 1500; index++) logs.add({ category: "nip17", event: "wrap_received", level: "debug" });
    expect(logs.entries.some(item => item.event === "startup_session_restored")).toBe(false);
    expect(logs.startupMarks().map(item => item.event)).toEqual(["startup_session_restored"]);
    expect(readFileSync("src/views/Debug.vue", "utf8")).toContain("startup: logs.startupMarks()");
  });

  it("marks every step between opening HaiNei and the first stored message", () => {
    const sources = ["src/main.ts", "src/stores/keys.ts", "src/services/relaySession.ts", "src/services/appResumeCoordinator.ts",
      "src/nostr/messaging/sync/MessageSyncManager.ts", "src/nostr/messaging/sync/ingestion.ts"].map(path => readFileSync(path, "utf8")).join("\n");
    for (const step of ["mounted", "session_restored", "critical_state_restored", "relay_token", "app_resumed", "push_inbox_read",
      "push_hint_event", "history_gate_waiting", "history_gate_released", "relay_catchup_live", "first_message_stored"]) {
      expect(sources).toContain(`startupMark("${step}"`);
    }
  });
});
