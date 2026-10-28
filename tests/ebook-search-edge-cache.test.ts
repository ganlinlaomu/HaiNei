import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestGet } from "../functions/api/books/search";

afterEach(() => vi.unstubAllGlobals());

function request(query: string): Request {
  return new Request("https://pwa.lostr.space/api/books/search?" + query);
}

describe("Gutenberg catalogue edge cache", () => {
  const response = () => new Response(JSON.stringify({
    next:"https://gutendex.com/books/?page=2",
    results:[{ id:1342,title:"Pride and Prejudice",copyright:false,
      authors:[{name:"Austen, Jane"}],languages:["en"],
      download_count:100,
      summaries:["large unused summary"],subjects:["big unused metadata"],
      formats:{"application/epub+zip":"https://www.gutenberg.org/ebooks/1342.epub3.images",
        "image/jpeg":"https://www.gutenberg.org/cache/epub/1342/pg1342.cover.medium.jpg" } }],
  }), { status:200, headers:{"Content-Type":"application/json"} });

  it("filters response metadata and reuses edge cache for repeated requests", async () => {
    const store = new Map<string, Response>();
    const match = vi.fn(async (req: Request) => store.get(req.url)?.clone());
    const put = vi.fn(async (req: Request, res: Response) => { store.set(req.url, res.clone()); });
    vi.stubGlobal("caches", { default: { match, put } });
    const upstream = vi.fn(async () => response());
    vi.stubGlobal("fetch", upstream);
    const pending: Promise<unknown>[] = [];
    const context = { request: request("search=Jane%20Austen&languages=en&page=1"),
      waitUntil: (task: Promise<unknown>) => { pending.push(task); } };
    const first = await onRequestGet(context);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toContain("s-maxage=3600");
    const page = await first.json() as { next: string; results: Array<Record<string, unknown>> };
    expect(page.next).toBe("more");
    expect(page.results[0].title).toBe("Pride and Prejudice");
    expect(page.results[0]).not.toHaveProperty("summaries");
    expect(page.results[0]).not.toHaveProperty("subjects");
    await Promise.all(pending);
    const second = await onRequestGet(context);
    expect(second.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(match).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
    expect(String(upstream.mock.calls[0][0])).toContain("copyright=false");
  });

  it("rejects oversized or invalid queries without upstream fetch", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    expect((await onRequestGet({request:request("search="+"a".repeat(121))})).status).toBe(400);
    expect((await onRequestGet({request:request("page=0")})).status).toBe(400);
    expect((await onRequestGet({request:request("languages=untrusted")})).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns a non-cacheable error when Gutendex is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Connection refused"); }));
    const result = await onRequestGet({request:request("search=Austen")});
    expect(result.status).toBe(502);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
  });
});
