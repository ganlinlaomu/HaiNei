import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    expect(zh).toContain("Songti SC");
    expect(zh).toContain("Noto Serif SC");
    const book = chapterStyles("sepia", 18, "cjk", true, "serif", "paged");
    expect(book).toContain("column-fill:auto");
    expect(book).toContain("column-gap:48px");
    expect(book).toContain("overflow-x:hidden");
    const sans = chapterStyles("light", 18, "cjk", false, "sans");
    expect(sans).toContain("PingFang SC");
    expect(sans).not.toContain("Songti SC");
    const ja = chapterStyles("dark", 18, "japanese", false);
    expect(ja).not.toContain("text-indent:2em");
    expect(ja).toContain("Hiragino Mincho ProN");
    expect(ja).toContain("#20252b");
    const en = chapterStyles("sepia", 40, "latin", false);
    expect(en).toContain("text-align:left;hyphens:auto");
    expect(en).toContain("font-size:28px"); // clamped
  });

  it("allows a narrowly scoped Noto Serif SC stylesheet and safe offline fallback", () => {
    const renderer = readFileSync("src/services/ebookEpub.ts", "utf8");
    const headers = readFileSync("public/_headers", "utf8");
    expect(renderer).toContain('fonts.googleapis.com/css2?family=Noto+Serif+SC');
    expect(renderer).toContain("font-src https://fonts.gstatic.com");
    expect(renderer).toContain('readerFont === "serif" && script === "cjk"');
    expect(renderer).toContain("script-src 'none'");
    expect(headers).toContain("https://fonts.googleapis.com");
    expect(headers).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(chapterStyles("light", 18, "cjk", true, "sans")).not.toContain('"Noto Serif SC"');
  });
});
