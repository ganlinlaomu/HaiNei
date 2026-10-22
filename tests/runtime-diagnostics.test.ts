// A blank-but-alive screen and a hot phone left no trace; the launch log now
// records main-thread stalls, script errors, Vue warnings and a heartbeat.
import { readFileSync } from "node:fs";
import { createApp } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("runtime diagnostics", () => {
  it("reports a visible main-thread stall and captures Vue warnings", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, Array<(event: any) => void>> = {};
    vi.stubGlobal("window", { addEventListener: (type: string, fn: any) => { (listeners[type] ||= []).push(fn); } });
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true, addEventListener: () => undefined });
    setActivePinia(createPinia());
    const debug = await import("@/utils/debugLog");
    const spy = vi.spyOn(debug, "debugLog");
    const { installRuntimeDiagnostics } = await import("@/services/runtimeDiagnostics");
    const app = createApp({});
    installRuntimeDiagnostics(app);

    vi.advanceTimersByTime(1_000);
    // Simulate a busy loop: the next tick fires four seconds late.
    vi.setSystemTime(Date.now() + 3_000);
    vi.advanceTimersByTime(1_000);
    expect(spy).toHaveBeenCalledWith("system", "main_thread_stall", { ms: expect.any(Number) }, "warn");
    expect((spy.mock.calls.find(call => call[1] === "main_thread_stall")![2] as any).ms).toBeGreaterThan(2_500);

    app.config.warnHandler!("Maximum recursive updates exceeded", null, "at <Home>");
    expect(spy).toHaveBeenCalledWith("ui", "vue_warning", expect.objectContaining({ message: "Maximum recursive updates exceeded" }), "warn");
    listeners.error?.[0]({ error: new TypeError("boom"), filename: "https://x/assets/index.js", lineno: 3 });
    expect(spy).toHaveBeenCalledWith("system", "js_error", expect.objectContaining({ message: "TypeError: boom", source: "index.js" }), "error");
  });

  it("is installed at boot and Home records an empty viewport", () => {
    expect(readFileSync("src/main.ts", "utf8")).toContain("installRuntimeDiagnostics(app);");
    const home = readFileSync("src/views/Home.vue", "utf8");
    expect(home).toContain('"home_viewport_empty"');
    expect(home).toContain('scheduleBlankCheck("resume")');
    expect(readFileSync("src/stores/debugLogs.ts", "utf8")).toContain("lastAliveAt, startup: startupBuffer");
  });
});
