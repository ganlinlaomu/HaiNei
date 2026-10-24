import { describe, expect, it, vi } from "vitest";
import { selectedTabPill, createTabPillObserver } from "@/utils/tabPillGeometry";

describe("private-space sliding tab indicator", () => {
  const initial = [
    { key: "saved", offsetLeft: 14, offsetWidth: 90 },
    { key: "note", offsetLeft: 110, offsetWidth: 90 },
    { key: "todo", offsetLeft: 206, offsetWidth: 90 },
  ];
  it("slides to the chosen measured tab, instead of assuming equal fixed widths", () => {
    expect(selectedTabPill(initial, "saved")).toEqual({ translateX: 14, width: 90 });
    expect(selectedTabPill(initial, "todo")).toEqual({ translateX: 206, width: 90 });
    expect(selectedTabPill(initial, "note")).toEqual({ translateX: 110, width: 90 });
  });
  it("recomputes for rotated layouts and increased text size", () => {
    const resized = [
      { key: "saved", offsetLeft: 22, offsetWidth: 124 },
      { key: "note", offsetLeft: 152, offsetWidth: 111 },
      { key: "todo", offsetLeft: 269, offsetWidth: 146 },
    ];
    expect(selectedTabPill(resized, "todo")).toEqual({ translateX: 269, width: 146 });
    expect(selectedTabPill(resized, "note")).toEqual({ translateX: 152, width: 111 });
  });
  it("hides for nonprimary filters or before measurement, without invalid geometry", () => {
    expect(selectedTabPill(initial, "archived")).toBeNull();
    expect(selectedTabPill([{ key: "saved", offsetLeft: 0, offsetWidth: 0 }], "saved")).toBeNull();
    expect(selectedTabPill([{ key: "saved", offsetLeft: Number.NaN, offsetWidth: 90 }], "saved")).toBeNull();
  });
});

describe("tab pill observer lifetime", () => {
  it("rebinds to a new tab bar after editing, detaches old nodes and immediately remeasures", () => {
    const observers: Array<{
      targets: HTMLElement[];
      disconnected: boolean;
      change: () => void;
    }> = [];
    class FakeResizeObserver {
      private state: (typeof observers)[number];
      constructor(callback: () => void) {
        this.state = { targets: [], disconnected: false, change: callback };
        observers.push(this.state);
      }
      observe(node: HTMLElement) { this.state.targets.push(node); }
      disconnect() { this.state.disconnected = true; }
    }
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    try {
      let measured = 0;
      const manager = createTabPillObserver(() => { measured++; });
      const firstButtons = [{}, {}, {}] as HTMLElement[];
      const firstBar = { querySelectorAll: () => firstButtons } as unknown as HTMLElement;
      manager.attach(firstBar);
      expect(measured).toBe(1);
      expect(observers[0].targets).toEqual([firstBar, ...firstButtons]);
      observers[0].change(); // orientation/font resize fires observer callback
      expect(measured).toBe(2);
      manager.attach(null); // editor opened: v-if destroyed the list
      expect(observers[0].disconnected).toBe(true);
      expect(measured).toBe(2);
      const nextButtons = [{}, {}, {}] as HTMLElement[];
      const nextBar = { querySelectorAll: () => nextButtons } as unknown as HTMLElement;
      manager.attach(nextBar); // editor closed, same selected filter
      expect(measured).toBe(3);
      expect(observers[1].targets).toEqual([nextBar, ...nextButtons]);
      manager.disconnect();
      expect(observers[1].disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("still remeasures when ResizeObserver is unsupported", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    try {
      let measured = 0;
      const manager = createTabPillObserver(() => { measured++; });
      manager.attach({ querySelectorAll: () => [] } as unknown as HTMLElement);
      manager.attach(null);
      manager.attach({ querySelectorAll: () => [] } as unknown as HTMLElement);
      expect(measured).toBe(2);
      manager.disconnect();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
