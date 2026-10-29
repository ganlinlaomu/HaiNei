/** Public-domain Gutenberg catalogue adapter. No API token or account required. */
export type CatalogBook = {
  id: string;
  title: string;
  authors: string[];
  language: string;
  coverUrl?: string;
  epubUrl: string;
  sourceUrl: string;
  /** Verified Aozora ZIP-text mirror, generated from public official metadata. */
  textUrl?: string;
  downloads: number;
};

type GutenbergBook = {
  id: number;
  title: string;
  authors?: Array<{ name: string }>;
  languages?: string[];
  copyright?: boolean | null;
  formats?: Record<string, string>;
  download_count?: number;
};
type GutenbergPage = { next: string | null; results: GutenbergBook[] };

/** A short-lived local cache makes revisiting the catalogue instant. */
const LOCAL_TTL_MS = 15 * 60 * 1000;
const LOCAL_MAX_ENTRIES = 24;
const LOCAL_PREFIX = "hainei_gutenberg_catalog_v1:";
export type CatalogPage = { books: CatalogBook[]; hasNext: boolean };
type CatalogCacheEntry = { expiresAt: number; page: CatalogPage };
const memoryCache = new Map<string, CatalogCacheEntry>();

function searchParams(query: string, page: number, language: string): URLSearchParams {
  const params = new URLSearchParams({ search: query.trim().replace(/\s+/g, " "), page: String(Math.max(1, Math.floor(page))) });
  if (language) params.set("languages", language);
  return params;
}

function cacheKey(query: string, page: number, language: string): string {
  return LOCAL_PREFIX + searchParams(query, page, language).toString();
}

export function getCachedGutenbergSearch(query: string, page = 1, language = ""): CatalogPage | null {
  const key = cacheKey(query, page, language);
  let entry = memoryCache.get(key);
  if (!entry) {
    try {
      const saved = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(key) : null;
      if (saved) entry = JSON.parse(saved) as CatalogCacheEntry;
    } catch { /* Browsers can deny sessionStorage access. */ }
  }
  if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= Date.now() ||
      !Array.isArray(entry.page?.books) || typeof entry.page.hasNext !== "boolean") return null;
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.page;
}

function cacheGutenbergSearch(query: string, page: number, language: string, result: CatalogPage): void {
  const key = cacheKey(query, page, language);
  const entry: CatalogCacheEntry = { expiresAt: Date.now() + LOCAL_TTL_MS, page: result };
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  if (memoryCache.size > LOCAL_MAX_ENTRIES) {
    memoryCache.delete(memoryCache.keys().next().value as string);
  }
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(key, JSON.stringify(entry));
  } catch { /* Quota exceeded or storage denied: memory cache is enough. */ }
}

const GUTENBERG_HOSTS = new Set(["www.gutenberg.org", "gutenberg.org"]);

export function validGutenbergEpubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && GUTENBERG_HOSTS.has(url.hostname) &&
      url.username === "" && url.password === "" && url.port === "" &&
      (url.pathname.startsWith("/ebooks/") || url.pathname.startsWith("/cache/epub/")) &&
      /(?:\.epub(?:3)?(?:\.|$)|\.epub$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function mapGutenbergBook(book: GutenbergBook): CatalogBook | null {
  // A missing copyright flag is not a reliable statement of rights.
  if (!Number.isSafeInteger(book.id) || book.id <= 0 || book.copyright !== false) return null;
  const url = book.formats?.["application/epub+zip"];
  if (!url || !validGutenbergEpubUrl(url)) return null;
  const cover = book.formats?.["image/jpeg"];
  return {
    id: "gutenberg:" + book.id,
    title: book.title?.trim() || "未命名作品",
    authors: (book.authors ?? []).map(person => person.name).filter(Boolean),
    language: book.languages?.[0] || "",
    coverUrl: cover && /^https:\/\/(?:www\.)?gutenberg\.org\//i.test(cover) ? cover : undefined,
    epubUrl: url,
    sourceUrl: "https://www.gutenberg.org/ebooks/" + book.id,
    downloads: book.download_count || 0,
  };
}

export async function searchGutenberg(query: string, page = 1, language = "", signal?: AbortSignal): Promise<CatalogPage> {
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  const cached = getCachedGutenbergSearch(query, page, language);
  if (cached) return cached;
  const params = searchParams(query, page, language);
  let response: Response;
  try {
    // Same-origin Cloudflare Pages Function caches public metadata at the edge
    // and returns only the fields the reader uses, instead of a large raw API response.
    response = await fetch("/api/books/search?" + params.toString(), { signal, cache: "no-store" });
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw new Error("无法连接在线书库。请检查网络；已下载的书籍仍可离线阅读。");
  }
  if (!response.ok) throw new Error(response.status === 504
    ? "书库响应较慢，请稍后重试。"
    : "书库暂时无法访问（HTTP " + response.status + "）");
  let data: GutenbergPage;
  try { data = await response.json() as GutenbergPage; }
  catch { throw new Error("书库返回的数据格式异常"); }
  if (!Array.isArray(data.results)) throw new Error("书库数据格式异常");
  const result: CatalogPage = {
    books: data.results.map(mapGutenbergBook).filter((book): book is CatalogBook => !!book),
    hasNext: !!data.next,
  };
  if (!signal?.aborted) cacheGutenbergSearch(query, page, language, result);
  return result;
}
