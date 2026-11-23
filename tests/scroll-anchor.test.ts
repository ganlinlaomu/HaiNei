// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installManualScrollAnchoring } from "@/utils/scrollAnchor";

let resizeCallback: ((entries: Array<{ target: Element }>) => void) | null = null;
class FakeResizeObserver {
  constructor(callback: (entries: Array<{ target: Element }>) => void) { resizeCallback = callback; }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function rectOf(element: Element, top: number, height: number) {
  (element as any).getBoundingClientRect = () => ({ top, bottom: top + height, height });
}

describe("manual scroll anchoring (iOS Safari)", () => {
  let list: HTMLElement;
  let above: HTMLElement;
  let visible: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    list = document.createElement("section");
    above = document.createElement("div");
    visible = document.createElement("div");
    for (const row of [above, visible]) { row.className = "message-line"; row.dataset.messageId = row === above ? "a" : "b"; list.appendChild(row); }
    document.body.appendChild(list);
    rectOf(list, 100, 600);
    list.scrollTop = 500;
  });
  afterEach(() => { vi.unstubAllGlobals(); list.remove(); });

  function install(enabled = () => true) {
    return installManualScrollAnchoring(list, { rowSelector: ".message-line[data-message-id]", enabled, native: false });
  }

  it("keeps the reading position when a row above the viewport grows", () => {
    const stop = install();
    rectOf(above, -200, 80); rectOf(visible, 300, 80);
    resizeCallback!([{ target: above }, { target: visible }]);
    rectOf(above, -200, 260);
    resizeCallback!([{ target: above }]);
    expect(list.scrollTop).toBe(680);
    stop();
  });

  it("leaves the scroll alone for rows in view, or while the caller restores its own anchor", () => {
    let enabled = true;
    const stop = install(() => enabled);
    rectOf(above, -200, 80); rectOf(visible, 300, 80);
    resizeCallback!([{ target: above }, { target: visible }]);
    rectOf(visible, 300, 200);
    resizeCallback!([{ target: visible }]);
    expect(list.scrollTop).toBe(500);
    enabled = false;
    rectOf(above, -200, 200);
    resizeCallback!([{ target: above }]);
    expect(list.scrollTop).toBe(500);
    stop();
  });

  it("does nothing where the browser anchors natively", () => {
    resizeCallback = null;
    const stop = installManualScrollAnchoring(list, { rowSelector: ".message-line", enabled: () => true, native: true });
    expect(resizeCallback).toBeNull();
    stop();
  });

  it("chat wires it in and fixes the width of image-only bubbles", () => {
    expect(readFileSync("src/composables/useChatMessageWindow.ts", "utf8")).toContain("installManualScrollAnchoring(list, { rowSelector: \".message-line[data-message-id]\", enabled: () => !windowMutationInProgress, reversed })");
    const chat = readFileSync("src/views/Messages.vue", "utf8");
    expect(chat).toContain("'image-bubble': !isDisappearing(message) && !isMediaCaption(message) && hasMessageImage(message)");
    expect(chat).toContain(".image-bubble{box-sizing:border-box;width:min(260px,65vw)}");
  });
});
