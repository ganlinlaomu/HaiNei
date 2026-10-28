import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FEATURED_BOOKS, featuredNote } from "@/services/ebookFeatured";
import { validGutenbergEpubUrl } from "@/services/ebookCatalog";

describe("fixed ebook recommendations", () => {
  it("offers eight unique classics with valid Gutenberg EPUB links", () => {
    expect(FEATURED_BOOKS).toHaveLength(8);
    expect(new Set(FEATURED_BOOKS.map(book => book.id)).size).toBe(8);
    for (const book of FEATURED_BOOKS) {
      expect(book.language).toBe("en");
      expect(book.authors).toHaveLength(1);
      expect(featuredNote(book.id)).not.toBe("");
      expect(validGutenbergEpubUrl(book.epubUrl)).toBe(true);
      expect(book.sourceUrl).toBe("https://www.gutenberg.org/ebooks/" + book.id.split(":")[1]);
    }
  });
  it("does not automatically search on component mount or on reconnect in featured mode", () => {
    const view = readFileSync("src/views/Books.vue", "utf8");
    expect(view).toContain("featuredMode = ref(true)");
    expect(view).toContain("FEATURED_BOOKS");
    expect(view).toContain("if (!query.value.trim())");
    expect(view).toContain("!featuredMode.value && query.value.trim()");
    const mounted = view.split("onMounted(() => {")[1]?.split("});")[0] || "";
    expect(mounted).not.toContain("startSearch()");
    expect(mounted).not.toContain("searchGutenberg");
  });
  it("preserves explicit searching, downloaded book actions, and offline bookshelf", () => {
    const view = readFileSync("src/views/Books.vue", "utf8");
    expect(view).toContain("void search(false)");
    expect(view).toContain("downloadGutenbergBook");
    expect(view).toContain("refreshLibrary");
    expect(view).toContain("exportLibraryBook");
  });
});
