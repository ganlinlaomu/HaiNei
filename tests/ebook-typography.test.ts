import { describe, expect, it } from "vitest";
import { chapterScript, chapterStyles } from "@/services/ebookEpub";

describe("ebook chapter typography", () => {
  it("detects the dominant script of a chapter", () => {
    expect(chapterScript("竊謂蘭陵笑笑生作《金瓶梅傳》，寄意於時俗，蓋有謂也。")).toBe("cjk");
    expect(chapterScript("私はその人を常に先生と呼んでいた。だからここでもただ先生と書くだけで")).toBe("japanese");
    expect(chapterScript("It is a truth universally acknowledged, that a single man 第一")).toBe("latin");
    expect(chapterScript("")).toBe("latin");
  });

  it("indents and justifies CJK, keeps Latin ragged-right with hyphenation", () => {
    const zh = chapterStyles("light", 18, "cjk", true);
    expect(zh).toContain("p{text-indent:2em}");
    expect(zh).toContain("text-align:justify");
    expect(zh).toContain("PingFang SC");
    const ja = chapterStyles("dark", 18, "japanese", false);
    expect(ja).not.toContain("text-indent:2em");
    expect(ja).toContain("Hiragino Mincho ProN");
    expect(ja).toContain("#20252b");
    const en = chapterStyles("sepia", 40, "latin", false);
    expect(en).toContain("text-align:left;hyphens:auto");
    expect(en).toContain("font-size:28px"); // clamped
  });
});
