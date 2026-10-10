import { describe, expect, it } from "vitest";
import { quotedMessageExcerpt } from "@/utils/quotedMessageExcerpt";

describe("quoted DM display preview", () => {
  it("retains short text and does not modify the source", () => {
    const original = "简短消息 😀";
    expect(quotedMessageExcerpt(original)).toBe(original);
    expect(original).toBe("简短消息 😀");
  });

  it("clips long CJK, URLs, and unbroken text to 160 code points", () => {
    const longUrl = "https://example.com/" + "a".repeat(900);
    const result = quotedMessageExcerpt(longUrl);
    expect(Array.from(result).length).toBe(161);
    expect(result).toBe(Array.from(longUrl).slice(0, 160).join("") + "…");
    expect(quotedMessageExcerpt("内容".repeat(300))).toHaveLength(161);
  });

  it("does not split emoji surrogate pairs or truncate exactly 160 emoji", () => {
    const emojis = "😀".repeat(200);
    const clipped = quotedMessageExcerpt(emojis);
    expect(clipped).toBe("😀".repeat(160) + "…");
    expect(quotedMessageExcerpt("😀".repeat(160))).toBe("😀".repeat(160));
  });
});
