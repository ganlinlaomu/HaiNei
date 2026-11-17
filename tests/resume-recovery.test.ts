// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resetAppResumeCoordinatorForTests } from "@/services/appResumeCoordinator";
import {
  decideResumeAction, installResumeRecovery, RELOAD_AFTER_HIDDEN_MS, REPAINT_AFTER_HIDDEN_MS, STUCK_HIDDEN_MS,
} from "@/services/resumeRecovery";

let visibility: DocumentVisibilityState = "visible";
let clock = 1_000_000;
let uninstall: () => void = () => undefined;

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  clock = 1_000_000;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  resetAppResumeCoordinatorForTests();
});
afterEach(() => {
  uninstall();
  resetAppResumeCoordinatorForTests();
});

function install(busy = false) {
  const reload = vi.fn(() => true);
  uninstall = installResumeRecovery({ isBusy: () => busy, reload, now: () => clock });
  return reload;
}

describe("resume recovery", () => {
  it("repaints after a minute away and reloads after half an hour unless busy", () => {
    expect(decideResumeAction(REPAINT_AFTER_HIDDEN_MS - 1, false)).toBe("none");
    expect(decideResumeAction(REPAINT_AFTER_HIDDEN_MS, false)).toBe("repaint");
    expect(decideResumeAction(RELOAD_AFTER_HIDDEN_MS, false)).toBe("reload");
    expect(decideResumeAction(RELOAD_AFTER_HIDDEN_MS, true)).toBe("repaint");
  });

  it("reloads on returning from a long background", () => {
    const reload = install();
    setVisibility("hidden");
    clock += RELOAD_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    expect(reload).toHaveBeenCalledWith("long_background");
  });

  it("does not reload during a call or an open post editor", () => {
    const reload = install(true);
    setVisibility("hidden");
    clock += RELOAD_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a page that is touched while it still believes it is hidden", () => {
    const reload = install();
    setVisibility("hidden");
    clock += STUCK_HIDDEN_MS - 1;
    document.dispatchEvent(new Event("touchstart"));
    expect(reload).not.toHaveBeenCalled();
    clock += 2;
    document.dispatchEvent(new Event("touchstart"));
    expect(reload).toHaveBeenCalledWith("touch_while_hidden");
  });

  it("ignores ordinary touches on a visible page", () => {
    const reload = install();
    document.dispatchEvent(new Event("touchstart"));
    document.dispatchEvent(new Event("pointerdown"));
    expect(reload).not.toHaveBeenCalled();
  });

  it("is installed at startup with the call and post editor as busy guards", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain('isBusy: () => useCallStore().phase !== "idle" || useUIStore().showPostEditor');
  });
});
