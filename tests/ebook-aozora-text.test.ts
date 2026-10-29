import { describe, expect, it } from "vitest";
import { aozoraBlocks } from "@/services/ebookAozora";

type Fake = { nodeType: number; textContent?: string; tagName?: string; childNodes: Fake[] };
const text = (value: string): Fake => ({ nodeType: 3, textContent: value, childNodes: [] });
const el = (tag: string, ...children: Array<Fake | string>): Fake => {
  const childNodes = children.map(child => typeof child === "string" ? text(child) : child);
  return { nodeType: 1, tagName: tag.toUpperCase(), childNodes, textContent: "" };
};

describe("Aozora main_text extraction", () => {
  it("keeps text written straight into main_text between <br> lines, with ruby and midashi", () => {
    // The shape of real Aozora XHTML (e.g. こころ): no <p>, text nodes and
    // inline ruby directly in div.main_text, headings inside jisage divs.
    const main = el("div",
      el("br"),
      el("div", el("h3", el("a", "上　先生と私"))),
      el("div", el("h4", el("a", "一"))),
      "　私", el("ruby", el("rb", "私"), el("rp", "（"), el("rt", "わたくし"), el("rp", "）")), "はその人を常に先生と呼んでいた。", el("br"),
      "　二行目の文章。", el("br"),
      el("script", "alert(1)"),
      el("br"),
    );
    const blocks = aozoraBlocks(main as unknown as Element);
    expect(blocks.map(block => block.html)).toEqual([
      "<h2>上　先生と私</h2>",
      "<h3>一</h3>",
      "<p>　私<ruby>私<rp>（</rp><rt>わたくし</rt><rp>）</rp></ruby>はその人を常に先生と呼んでいた。</p>",
      "<p>　二行目の文章。</p>",
    ]);
    expect(blocks.filter(block => block.heading)).toHaveLength(2);
  });

  it("escapes text and drops empty lines", () => {
    const blocks = aozoraBlocks(el("div", "a < b & c", el("br"), "   ", el("br")) as unknown as Element);
    expect(blocks.map(block => block.html)).toEqual(["<p>a &lt; b &amp; c</p>"]);
  });
});
