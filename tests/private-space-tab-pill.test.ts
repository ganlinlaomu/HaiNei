import { describe, expect, it } from "vitest";
import { selectedTabPill } from "@/utils/tabPillGeometry";

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
