import { describe, expect, it } from "vitest";
import {
  focusBoundedMessageWindow,
  initialBoundedMessageWindow,
  initialMessageWindowStart,
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

  it("keeps a pinned playback or interaction row mounted even outside the normal window", () => {
    const range = shiftBoundedMessageWindow({ start: 100, end: 200 }, 1_000, "newer", 40, 100, [120]);
    expect(range).toEqual({ start: 120, end: 240 });
    expect(range.start).toBeLessThanOrEqual(120);
    expect(range.end).toBeGreaterThan(120);
  });

  it("centers historical focus with context without exceeding the normal cap", () => {
    expect(focusBoundedMessageWindow(1_000, 120, 40, 100)).toEqual({ start: 80, end: 180 });
  });
});
