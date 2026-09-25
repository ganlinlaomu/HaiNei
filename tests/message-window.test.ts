import { describe, expect, it } from "vitest";
import {
  initialMessageWindowStart,
  prependMessageWindowStart,
  scrollTopAfterNewMessages,
  scrollTopAfterPrepend,
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
});
