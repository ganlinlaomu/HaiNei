import { describe, expect, it } from "vitest";
import {
  buildHeightPrefix,
  lowerBoundHeight,
  resolveVirtualRange,
  updateHeightPrefix,
} from "../src/utils/virtualFeed";

describe("Home virtual feed height index", () => {
  it("builds cumulative heights and updates only the affected suffix", () => {
    const prefix = buildHeightPrefix([100, 200, 300, 400]);
    expect(prefix).toEqual([0, 100, 300, 600, 1000]);
    expect(updateHeightPrefix(prefix, 1, 50)).toEqual([0, 100, 350, 650, 1050]);
    expect(prefix).toEqual([0, 100, 300, 600, 1000]);
  });

  it("finds cumulative boundaries with binary search", () => {
    const prefix = [0, 100, 300, 600, 1000];
    expect(lowerBoundHeight(prefix, 0)).toBe(0);
    expect(lowerBoundHeight(prefix, 300)).toBe(2);
    expect(lowerBoundHeight(prefix, 301)).toBe(3);
    expect(lowerBoundHeight(prefix, 1200)).toBe(prefix.length);
  });

  it("resolves the visible range with overscan and exact-boundary semantics", () => {
    const prefix = buildHeightPrefix([100, 200, 300, 400, 500]);
    expect(resolveVirtualRange(prefix, 350, 250, 100)).toEqual({ start: 1, end: 4 });
    expect(resolveVirtualRange(prefix, 0, 80, 0)).toEqual({ start: 0, end: 1 });
    expect(resolveVirtualRange(prefix, 1400, 200, 0)).toEqual({ start: 4, end: 5 });
    expect(resolveVirtualRange([0], 0, 500, 100)).toEqual({ start: 0, end: 0 });
  });
});
