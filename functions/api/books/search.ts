/** Public Gutenberg catalogue metadata proxy with bounded, shared edge caching. */
const GUTENDEX_ORIGIN = "https://gutendex.com";
const EDGE_TTL_SECONDS = 60 * 60;
const MAX_SEARCH_LENGTH = 120;

type GutenbergRawBook = {
  id?: number;
  title?: string;
  authors?: Array<{name:string}>;
  languages?: string[];
  copyright?: boolean | null;
  formats?: Record<string,string>;
  download_count?: number;
};
type GutenbergRawPage = { next?: string | null; results?: GutenbergRawBook[] };

type Context = { request: Request; waitUntil?: (promise: Promise<unknown>) => void };
function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
function safePage(value: string | null): number | null {
  const raw = value ?? "1";
  if (!/^[1-9]\d{0,2}$/.test(raw)) return null;
  const page = Number(raw);
  return page >= 1 && page <= 100 ? page : null;
}

export async function onRequestGet(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  const search = (url.searchParams.get("search") || "").trim().replace(/\s+/g, " ");
  const language = (url.searchParams.get("languages") || "").trim();
  const page = safePage(url.searchParams.get("page"));
  if (search.length > MAX_SEARCH_LENGTH || page === null || (language && !/^[a-z]{2}$/.test(language))) {
    return jsonError("Invalid catalogue search", 400);
  }
  const params = new URLSearchParams({ search, copyright: "false", page: String(page) });
  if (language) params.set("languages", language);
  const key = new Request(url.origin + url.pathname + "?" + params.toString());
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch { /* Cache API may be unavailable in local dev or previews. */ }
  }

  const upstream = new URL("/books/?" + params.toString(), GUTENDEX_ORIGIN);
  let source: Response;
  try {
    source = await fetch(upstream.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return jsonError(error instanceof Error && error.name === "TimeoutError"
      ? "Gutendex timed out" : "Gutendex unavailable",
      error instanceof Error && error.name === "TimeoutError" ? 504 : 502);
  }
  if (!source.ok) return jsonError("Gutendex HTTP " + source.status, 502);
  let body: GutenbergRawPage;
  try { body = await source.json() as GutenbergRawPage; }
  catch { return jsonError("Invalid Gutenberg response", 502); }
  if (!Array.isArray(body.results) || body.results.length > 32) return jsonError("Invalid Gutenberg catalogue", 502);

  // Strip summaries/subjects and other large unused fields. EPUB files are
  // *not* cached here; only the public search metadata is retained.
  const results = body.results.map(book => ({
    id: book.id,
    title: book.title,
    authors: book.authors,
    languages: book.languages,
    copyright: book.copyright,
    formats: {
      "application/epub+zip": book.formats?.["application/epub+zip"],
      "image/jpeg": book.formats?.["image/jpeg"],
    },
    download_count: book.download_count,
  }));
  const response = new Response(JSON.stringify({ next: body.next ? "more" : null, results }), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=" + EDGE_TTL_SECONDS,
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (cache) {
    const saved = cache.put(key, response.clone()).catch(() => {});
    if (context.waitUntil) context.waitUntil(saved);
    else await saved;
  }
  return response;
}
