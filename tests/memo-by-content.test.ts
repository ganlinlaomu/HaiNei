import { describe, expect, it, vi } from "vitest";
import { memoByContent } from "@/utils/memoByContent";
import { directMessagePreview } from "@/nostr/messaging/directMessages";

describe("memoByContent", () => {
  it("runs the parser once per content string", () => {
    const parse = vi.fn((content: string) => ({ length: content.length }));
    const cached = memoByContent(parse);
    const first = cached("你好");
    expect(cached("你好")).toBe(first);
    expect(cached("再见")).toEqual({ length: 2 });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("caches null results too, and drops the oldest entry past capacity", () => {
    const parse = vi.fn((content: string) => content === "x" ? null : content);
    const cached = memoByContent(parse, 2);
    expect(cached("x")).toBeNull();
    expect(cached("x")).toBeNull();
    expect(parse).toHaveBeenCalledTimes(1);
    cached("a"); cached("b"); // "x" is evicted
    cached("x");
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("leaves directMessagePreview's output unchanged", () => {
    expect(directMessagePreview("  你好   世界 ")).toBe("你好 世界");
    expect(directMessagePreview("![图](blossom+aesgcm:abc)")).toBe("[图片]");
    expect(directMessagePreview("![图](blossom+aesgcm:abc)")).toBe("[图片]");
  });
});

describe("chat time formatting with shared Intl formatters", () => {
  it("matches toLocaleTimeString / toLocaleString output", () => {
    const bubble = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const full = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    for (const seconds of [0, 1_700_000_000, 1_795_181_920, 1_800_000_123]) {
      const date = new Date(seconds * 1000);
      expect(bubble.format(date)).toBe(date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      expect(full.format(date)).toBe(date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }));
    }
  });
});
