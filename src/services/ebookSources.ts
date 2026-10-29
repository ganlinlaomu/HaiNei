import type { CatalogBook, CatalogPage } from "@/services/ebookCatalog";
import { searchAozoraIndex } from "@/services/ebookAozoraCatalog";

export type BookSource = "gutenberg" | "wikisource" | "aozora";
export const BOOK_SOURCE_LABELS: Record<BookSource, string> = {
  gutenberg: "Project Gutenberg", wikisource: "中文维基文库", aozora: "青空文庫",
};
export function sourceForBook(book: Pick<CatalogBook, "id">): BookSource {
  if (book.id.startsWith("wikisource:")) return "wikisource";
  if (book.id.startsWith("aozora:")) return "aozora";
  return "gutenberg";
}

type WikiHit = { ns?: number; pageid?: number; title?: string };
type WikiSearchPage = { query?: { search?: WikiHit[] }; continue?: { sroffset?: number } };
const WIKI_UA = "HaiNei-BookReader/1.0 (https://github.com/ganlinlaomu/HaiNei)";

function wikiBooks(data: WikiSearchPage): CatalogPage {
  if (!Array.isArray(data.query?.search)) throw new Error("中文维基文库返回的数据格式异常");
  const books: CatalogBook[] = data.query.search.filter(x =>
    x.ns === 0 && Number.isSafeInteger(x.pageid) && (x.pageid || 0) > 0 &&
    typeof x.title === "string" && x.title.length > 0 && x.title.length <= 180 &&
    !x.title.includes(":")
  ).map(x => ({
    id: "wikisource:" + x.pageid, title: x.title!, authors: [], language: "zh",
    sourceUrl: "https://zh.wikisource.org/wiki/" + encodeURIComponent(x.title!.replace(/ /g, "_")),
    epubUrl: "https://ws-export-app.wmcloud.org/?" + new URLSearchParams({
      lang: "zh", page: x.title!, format: "epub-3", credits: "false",
    }),
    downloads: 0,
  }));
  return { books, hasNext: Number.isInteger(data.continue?.sroffset) };
}

/**
 * The usual same-origin Pages Function is preferred. Wikimedia also supports
 * CORS (origin=*); it gives a safe fallback if a cloud edge egress is blocked.
 */
async function directWikisourceSearch(query: string, page: number, signal?: AbortSignal): Promise<CatalogPage> {
  const params = new URLSearchParams({
    action: "query", list: "search", srsearch: query, srnamespace: "0",
    srlimit: "20", sroffset: String((page - 1) * 20), srprop: "",
    format: "json", formatversion: "2", origin: "*",
  });
  const response = await fetch("https://zh.wikisource.org/w/api.php?" + params, {
    signal, headers: { Accept: "application/json", "Api-User-Agent": WIKI_UA },
  });
  if (!response.ok) throw new Error("中文维基文库目前无法访问（HTTP " + response.status + "）");
  return wikiBooks(await response.json() as WikiSearchPage);
}

export async function searchOtherLibrary(
  source: "wikisource" | "aozora", query: string, page: number, signal?: AbortSignal,
): Promise<CatalogPage> {
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (!trimmed) return { books: [], hasNext: false };
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error("无效的书库页码");
  if (source === "aozora") return searchAozoraIndex(trimmed, page, signal);
  const url = "/api/books/wikisource/search?" + new URLSearchParams({ q: trimmed, page: String(page) });
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: "no-store" });
    if (response.ok) {
      const data = await response.json() as CatalogPage;
      if (!Array.isArray(data.books) || typeof data.hasNext !== "boolean") {
        throw new Error("中文维基文库返回的数据格式异常");
      }
      return { books: data.books.filter(book =>
        typeof book.id === "string" && book.id.startsWith("wikisource:") &&
        typeof book.title === "string" && Array.isArray(book.authors) &&
        typeof book.sourceUrl === "string" && typeof book.epubUrl === "string"),
        hasNext: data.hasNext };
    }
    if (![502, 503, 504].includes(response.status)) {
      throw new Error("中文维基文库暂时无法搜索（HTTP " + response.status + "）");
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Retry directly only when server fetch failed or its upstream was down.
  }
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  try {
    return await directWikisourceSearch(trimmed, page, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("中文维基文库无法连接。已尝试备用线路，请稍后重试。");
  }
}
