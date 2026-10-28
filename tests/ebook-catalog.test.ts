import { describe, expect, it, vi, afterEach } from "vitest";
import { mapGutenbergBook, searchGutenberg, validGutenbergEpubUrl } from "@/services/ebookCatalog";

afterEach(() => vi.unstubAllGlobals());

describe("Gutenberg search adapter", () => {
  const epub = "https://www.gutenberg.org/ebooks/1342.epub3.images";
  it("only allows HTTPS Gutenberg ebook paths", () => {
    expect(validGutenbergEpubUrl(epub)).toBe(true);
    expect(validGutenbergEpubUrl("http://www.gutenberg.org/ebooks/1342.epub")).toBe(false);
    expect(validGutenbergEpubUrl("https://www.gutenberg.org.evil.test/ebooks/1342.epub")).toBe(false);
    expect(validGutenbergEpubUrl("https://www.gutenberg.org/@admin/ebooks/1342.epub")).toBe(false);
  });
  it("filters books without an explicit public-domain flag and an EPUB", () => {
    const source = { id:1342,title:"Pride and Prejudice",copyright:false,authors:[{name:"Austen, Jane"}],formats:{"application/epub+zip":epub} };
    expect(mapGutenbergBook(source)?.id).toBe("gutenberg:1342");
    expect(mapGutenbergBook({...source,copyright:true})).toBeNull();
    expect(mapGutenbergBook({...source,copyright:undefined})).toBeNull();
    expect(mapGutenbergBook({...source,formats:{"application/epub+zip":"https://evil.test/1342.epub"}})).toBeNull();
  });
  it("shows a readable offline error instead of Safari Load failed", async () => {
    const mock = vi.fn(async () => { throw new TypeError("Load failed"); });
    vi.stubGlobal("fetch", mock);
    await expect(searchGutenberg("Austen")).rejects.toThrow("无法连接在线书库");
  });
  it("preserves AbortError when an in-flight search is cancelled", async () => {
    const controller = new AbortController();
    const mock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    });
    vi.stubGlobal("fetch", mock);
    await expect(searchGutenberg("Austen", 1, "", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("reuses a previously retrieved search without a second network call", async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ next:null,results:[
      {id:1342,title:"Pride and Prejudice",copyright:false,formats:{"application/epub+zip":epub},authors:[],languages:["en"]},
    ]}), {status:200}));
    vi.stubGlobal("fetch", mock);
    const first = await searchGutenberg("Unique cached Austen test", 1, "en");
    const second = await searchGutenberg("Unique cached Austen test", 1, "en");
    expect(first.books).toHaveLength(1);
    expect(second.books).toEqual(first.books);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(String(mock.mock.calls[0][0])).toMatch(/^\/api\/books\/search\?/);
  });
  it("queries Gutendex without credentials and maps results", async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ next:null,results:[
      {id:1342,title:"Pride and Prejudice",copyright:false,formats:{"application/epub+zip":epub},authors:[],languages:["en"]},
    ]}), {status:200}));
    vi.stubGlobal("fetch",mock);
    const result = await searchGutenberg("Austen",1,"en");
    expect(result.books).toHaveLength(1);
    expect(result.books[0].title).toBe("Pride and Prejudice");
    expect(result.hasNext).toBe(false);
    expect(String(mock.mock.calls[0][0])).toContain("languages=en");
  });
});