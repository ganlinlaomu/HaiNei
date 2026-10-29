import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { wordAtTextOffset, wordAtPoint } from "@/services/ebookWordSelection";

describe("EPUB iPhone tap-to-lookup", () => {
  it("recognizes words at a tap or caret offset including contractions", () => {
    expect(wordAtTextOffset("universally acknowledged", 17)).toEqual({
      word: "acknowledged", start: 12, end: 24,
    });
    expect(wordAtTextOffset("don't stop", 2)?.word).toBe("don't");
    expect(wordAtTextOffset("well-known writer", 6)?.word).toBe("well-known");
    expect(wordAtTextOffset("hello, world", -1)).toBeNull();
    expect(wordAtTextOffset("中文的诗", 2)).toBeNull();
    expect(wordAtTextOffset("a b", 999)).toBeNull();
  });

  it("resolves a word under the tap using WebKit's caretRangeFromPoint", () => {
    const node = { nodeType:3, textContent:"hello acknowledged reader" } as unknown as Node;
    const range = {
      startContainer: node, startOffset: 8,
      setStart: vi.fn(), setEnd: vi.fn(),
      getClientRects: () => [{ left:20, top:80, right:140, bottom:104 }],
    };
    const doc = {
      caretRangeFromPoint: () => range,
      createRange: () => range,
    } as unknown as Document;
    expect(wordAtPoint(doc, 55, 91)).toBe("acknowledged");
    expect(range.setStart).toHaveBeenCalledWith(node, 6);
    expect(range.setEnd).toHaveBeenCalledWith(node, 18);
    expect(wordAtPoint(doc, 2, 4)).toBeNull(); // margins do not pick random words
  });

  it("supports the standard caretPositionFromPoint without Safari fallback", () => {
    const node = { nodeType:3, textContent:"walking home" } as unknown as Node;
    const doc = {
      caretPositionFromPoint: () => ({ offsetNode:node, offset:2 }),
      createRange: () => ({
        setStart: () => {}, setEnd: () => {},
        getClientRects: () => [{ left:0, top:0, right:80, bottom:22 }],
      }),
    } as unknown as Document;
    expect(wordAtPoint(doc, 20, 12)).toBe("walking");
  });

  it("keeps EPUB scripts disabled and handles taps on a parent-owned layer", () => {
    const source = readFileSync("src/views/EbookReader.vue", "utf8");
    expect(source).toContain('sandbox="allow-same-origin"');
    expect(source).not.toContain('sandbox="allow-scripts');
    // WebKit drops parent listeners attached inside the script-disabled iframe.
    expect(source).not.toMatch(/doc\.addEventListener\(/);
    expect(source).toContain('class="chapter-tap-layer" aria-hidden="true" @click="lookupTappedWord"');
    expect(source).toContain("wordAtPoint(doc, event.clientX - rect.left, event.clientY - rect.top)");
  });
});
