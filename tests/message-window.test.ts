import { describe, expect, it } from "vitest";
import {
  focusBoundedMessageWindow,
  initialBoundedMessageWindow,
  initialMessageWindowStart,
  mergeBoundedMessageIndexes,
  prependMessageWindowStart,
  scrollTopAfterAnchorShift,
  scrollTopAfterNewMessages,
  scrollTopAfterPrepend,
  shiftBoundedMessageWindow,
} from "../src/utils/messageWindow";

describe("DM message window", () => {
  it("starts with only the newest 60 messages", () => {
    expect(initialMessageWindowStart(140)).toBe(80);
    expect(initialMessageWindowStart(45)).toBe(0);
  });

  it("prepends older messages in batches of 40", () => {
    expect(prependMessageWindowStart(80)).toBe(40);
    expect(prependMessageWindowStart(25)).toBe(0);
  });

  it("preserves the scroll anchor by the exact prepended height", () => {
    expect(scrollTopAfterPrepend(36, 2_000, 5_250)).toBe(3_286);
  });

  it("follows new messages only when already near the bottom", () => {
    expect(scrollTopAfterNewMessages({ scrollTop: 1_360, scrollHeight: 2_000, clientHeight: 600 }, 2_120)).toBe(2_120);
    expect(scrollTopAfterNewMessages({ scrollTop: 700, scrollHeight: 2_000, clientHeight: 600 }, 2_120)).toBe(700);
  });

  it("keeps both ends of a long variable-height conversation bounded while paging", () => {
    let range = initialBoundedMessageWindow(1_000, 60);
    expect(range).toEqual({ start: 940, end: 1_000 });

    range = shiftBoundedMessageWindow(range, 1_000, "older", 40, 100);
    expect(range).toEqual({ start: 900, end: 1_000 });

    range = shiftBoundedMessageWindow(range, 1_000, "older", 40, 100);
    expect(range).toEqual({ start: 860, end: 960 });
    expect(range.end - range.start).toBe(100);

    range = shiftBoundedMessageWindow(range, 1_000, "newer", 40, 100);
    expect(range).toEqual({ start: 900, end: 1_000 });
  });

  it("preserves the visual scroll anchor using measured row offsets", () => {
    expect(scrollTopAfterAnchorShift(240, 38, 72)).toBe(274);
    expect(scrollTopAfterAnchorShift(12, 50, 10)).toBe(0);
  });

  it("keeps distant retained nodes without expanding the continuous 100-message window", () => {
    const range = shiftBoundedMessageWindow({ start: 100, end: 200 }, 1_000, "newer", 40, 100);
    expect(range).toEqual({ start: 140, end: 240 });

    const indexes = mergeBoundedMessageIndexes(range, 1_000, [10, 180, 900]);
    expect(indexes.filter(index => index >= 140 && index < 240)).toHaveLength(100);
    expect(indexes).toContain(10);
    expect(indexes).toContain(180);
    expect(indexes).toContain(900);
    expect(indexes).not.toContain(11);
    expect(indexes).not.toContain(899);
    expect(indexes).toHaveLength(102);
  });

  it("centers historical focus with context without exceeding the normal cap", () => {
    expect(focusBoundedMessageWindow(1_000, 120, 40, 100)).toEqual({ start: 80, end: 180 });
  });
});
