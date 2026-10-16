import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function installBrowser() {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const replaceState = vi.fn();
  const listeners: Record<string, (event: any) => void> = {};
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { reload },
      history: { state: null, replaceState },
      addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback; },
    },
  });
  return { reload, replaceState, listeners };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("stale chunk recovery", () => {
  it("recognises dynamic import failures from Chromium, WebKit and Firefox", async () => {
    const { isChunkLoadError } = await import("@/utils/chunkLoadRecovery");
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("network timeout"))).toBe(false);
  });

  it("reloads into the target route at most once per guard window", async () => {
    vi.useFakeTimers();
    const browser = installBrowser();
    const { reloadForStaleChunk } = await import("@/utils/chunkLoadRecovery");

    expect(reloadForStaleChunk("#/profile/abc")).toBe(true);
    expect(browser.replaceState).toHaveBeenCalledWith(null, "", "#/profile/abc");
    expect(reloadForStaleChunk()).toBe(false);
    expect(browser.reload).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(reloadForStaleChunk()).toBe(true);
    expect(browser.reload).toHaveBeenCalledTimes(2);
  });

  it("handles router chunk errors and Vite preload errors", async () => {
    const browser = installBrowser();
    const { installChunkLoadRecovery } = await import("@/utils/chunkLoadRecovery");
    let onError: (error: unknown, to: unknown) => void = () => {};
    const router = { onError: (handler: typeof onError) => { onError = handler; }, resolve: () => ({ href: "#/saved" }) };
    installChunkLoadRecovery(router as any);

    onError(new Error("unrelated"), {});
    expect(browser.reload).not.toHaveBeenCalled();
    onError(new TypeError("Failed to fetch dynamically imported module"), {});
    expect(browser.replaceState).toHaveBeenCalledWith(null, "", "#/saved");
    expect(browser.reload).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    browser.listeners["vite:preloadError"]({ preventDefault });
    // Still inside the guard window: no second reload, and Vite rethrows.
    expect(browser.reload).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("version update", () => {
  it("persists the new version marker before continuing", async () => {
    const flushDeviceWrites = vi.fn(async () => {});
    const setItem = vi.fn();
    vi.doMock("@/services/deviceStorage", () => ({ deviceStorage: { getItem: () => null, setItem }, flushDeviceWrites }));
    vi.doMock("@/db/dexie", () => ({ APP_VERSION: "9.9.9" }));
    const { handleVersionUpdate } = await import("@/utils/versionManager");
    await handleVersionUpdate();
    expect(setItem).toHaveBeenCalledWith("app_version", "9.9.9");
    expect(flushDeviceWrites).toHaveBeenCalled();
    vi.doUnmock("@/services/deviceStorage");
    vi.doUnmock("@/db/dexie");
  });

  it("does not reload the page after a version change", () => {
    const main = readFileSync(join(process.cwd(), "src/main.ts"), "utf8");
    const versionBlock = main.slice(main.indexOf("if (versionChanged)"), main.indexOf("// Normal app initialization"));
    expect(versionBlock).toContain("await handleVersionUpdate()");
    expect(versionBlock).not.toContain("location.reload");
    expect(main).toContain("installChunkLoadRecovery(router)");
  });
});
