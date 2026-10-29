import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pageCountForWidth, pageForPercent, percentForPage } from "@/services/ebookPagination";

describe("responsive ebook pagination", () => {
  it("counts CSS columns and ignores floating-point rounding", () => {
    expect(pageCountForWidth(1170, 390)).toBe(3);
    expect(pageCountForWidth(1169.9, 390)).toBe(3);
    expect(pageCountForWidth(390, 390)).toBe(1);
    expect(pageCountForWidth(0, 390)).toBe(1);
    expect(pageCountForWidth(3000, 0)).toBe(1);
  });

  it("restores chapter progress after a font/viewport reflow", () => {
    expect(pageForPercent(0, 8)).toBe(0);
    expect(pageForPercent(0.5, 9)).toBe(4);
    expect(pageForPercent(1, 8)).toBe(7);
    expect(pageForPercent(-10, 8)).toBe(0);
    expect(pageForPercent(99, 8)).toBe(7);
    expect(percentForPage(4, 9)).toBe(0.5);
    expect(percentForPage(0, 1)).toBe(1);
  });

  it("flips a real page over its fully rendered destination like nostr-book", () => {
    const source = readFileSync("src/views/EbookReader.vue", "utf8");
    expect(source).toContain('class="chapter-sheet chapter-preview"');
    expect(source).toContain('class="sheet-sheen"');
    expect(source).toContain("perspective:1800px");
    expect(source).toContain("transform-origin:left center");
    expect(source).toContain("rotateY(-104deg)");
    expect(source).toContain("@animationend=\"turnAnimationEnd\"");
    expect(source).toContain('sandbox="allow-same-origin"');
    expect(source).not.toContain('sandbox="allow-scripts');
    expect(source).toContain("preview.page * width");
    expect(source).toContain("moveToPage(preview.page)");
    expect(source).toContain("if (readingMode.value !== \"paged\"");
    expect(source).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)")');
  });

  it("preserves sandboxed iframe, offline selection, and reduced-motion support", () => {
    const source = readFileSync("src/views/EbookReader.vue", "utf8");
    expect(source).toContain('sandbox="allow-same-origin"');
    expect(source).not.toContain('sandbox="allow-scripts');
    expect(source).toContain('class="chapter-tap-layer" aria-hidden="true" @click="lookupTappedWord"');
    expect(source).toContain('wordAtPoint(doc, event.clientX - rect.left, event.clientY - rect.top)');
    expect(source).toContain('(prefers-reduced-motion: reduce)');
    expect(source).toContain('pageSwipe');
    expect(source).toContain('readingMode: readingMode.value');
  });
});
