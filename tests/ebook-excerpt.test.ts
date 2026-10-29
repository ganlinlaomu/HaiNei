import { describe, expect, it } from "vitest";
import {
  MAX_EXCERPT_CHARS, excerptText, extendSpan, formatExcerptPost, growBySentence,
  sentenceBounds, snapToWord,
} from "@/services/ebookExcerpt";

const slice = (text: string, span: { start: number; end: number }) => text.slice(span.start, span.end);

describe("ebook excerpt sentence selection", () => {
  it("selects the long-pressed Chinese sentence including closing quotes", () => {
    const text = "他说：「天亮了。」我们出发吧！路还很长。";
    expect(slice(text, sentenceBounds(text, 3))).toBe("他说：「天亮了。」");
    expect(slice(text, sentenceBounds(text, 11))).toBe("我们出发吧！");
    expect(slice(text, sentenceBounds(text, text.length - 2))).toBe("路还很长。");
  });

  it("selects English sentences and keeps stacked terminators together", () => {
    const text = "It is a truth universally acknowledged. Really?! \"Yes.\" Done";
    expect(slice(text, sentenceBounds(text, 10))).toBe("It is a truth universally acknowledged.");
    expect(slice(text, sentenceBounds(text, 42))).toBe("Really?!");
    expect(slice(text, sentenceBounds(text, 51))).toBe("\"Yes.\"");
    expect(slice(text, sentenceBounds(text, text.length))).toBe("Done");
  });

  it("does not split at decimals and never crosses a paragraph", () => {
    const text = "价格是 3.5 元，很便宜\n下一段。";
    expect(slice(text, sentenceBounds(text, 2))).toBe("价格是 3.5 元，很便宜");
    expect(slice(text, sentenceBounds(text, text.length - 1))).toBe("下一段。");
  });

  it("extends a drag from the anchor sentence in either direction, snapping Latin words", () => {
    const text = "First one. Second sentence here. Third.";
    const anchor = sentenceBounds(text, 14); // "Second sentence here."
    expect(slice(text, extendSpan(text, anchor, text.indexOf("Third") + 2))).toBe("Second sentence here. Third");
    expect(slice(text, extendSpan(text, anchor, 2))).toBe("First one. Second sentence here.");
    expect(extendSpan(text, anchor, 20)).toEqual(anchor);
    expect(snapToWord("acknowledged", 5, true)).toBe(12);
    expect(snapToWord("acknowledged", 5, false)).toBe(0);
  });

  it("grows by whole sentences", () => {
    const text = "一。二。三。";
    const middle = sentenceBounds(text, 2);
    expect(slice(text, middle)).toBe("二。");
    const grown = growBySentence(text, growBySentence(text, middle, "before"), "after");
    expect(slice(text, grown)).toBe("一。二。三。");
    expect(growBySentence(text, grown, "after")).toEqual(grown);
  });

  it("keeps paragraphs, collapses spacing, and formats the composer text", () => {
    expect(excerptText("  a   b \n\n c ", { start: 0, end: 13 })).toBe("a b\nc");
    expect(formatExcerptPost("天亮了。", { title: "边城", authors: ["沈从文"], chapter: "第一章" }))
      .toBe("「天亮了。」\n—— 《边城》 · 沈从文 · 第一章\n\n");
    expect(formatExcerptPost("x", {})).toBe("「x」\n\n");
    const long = formatExcerptPost("字".repeat(MAX_EXCERPT_CHARS + 20), { title: "书" });
    expect(Array.from(long.split("」")[0]).length).toBe(MAX_EXCERPT_CHARS + 2); // 「 + chars + …
  });
});

describe("ebook reader excerpt wiring", () => {
  it("handles long presses on the parent tap layer and opens the composer with the excerpt", async () => {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync("src/views/EbookReader.vue", "utf8");
    expect(view).toContain('sandbox="allow-same-origin"');
    expect(view).toContain('@pointerdown="excerptPointerDown"');
    expect(view).toContain('@touchmove="excerptTouchMove"');
    expect(view).toContain("ui.openPostEditor(undefined, prefill)");
    const editor = readFileSync("src/components/PostEditorModal.vue", "utf8");
    expect(editor).toContain("ui.postEditorPrefill = null");
  });
});
