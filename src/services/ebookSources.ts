import type { CatalogBook, CatalogPage } from "@/services/ebookCatalog";
import { searchAozoraIndex } from "@/services/ebookAozoraCatalog";
import { searchWikisourceWorks } from "@/services/wikisourceWorks";

export type BookSource = "gutenberg" | "wikisource" | "aozora";
export const BOOK_SOURCE_LABELS: Record<BookSource, string> = {
  gutenberg: "Project Gutenberg", wikisource: "中文维基文库", aozora: "青空文庫",
};
export function sourceForBook(book: Pick<CatalogBook, "id">): BookSource {
  if (book.id.startsWith("wikisource:")) return "wikisource";
  if (book.id.startsWith("aozora:")) return "aozora";
  return "gutenberg";
}

const WIKI_UA = "HaiNei-BookReader/1.0 (https://github.com/ganlinlaomu/HaiNei)";

/**
 * The usual same-origin Pages Function is preferred. Wikimedia also supports
 * CORS (origin=*); it gives a safe fallback if a cloud edge egress is blocked.
 */
async function directWikisourceSearch(query: string, page: number, signal?: AbortSignal): Promise<CatalogPage> {
  return searchWikisourceWorks(query, page, async params => {
    const response = await fetch("https://zh.wikisource.org/w/api.php?" + new URLSearchParams({ ...params, origin: "*" }), {
      signal, headers: { Accept: "application/json", "Api-User-Agent": WIKI_UA },
    });
    if (!response.ok) throw new Error("中文维基文库目前无法访问（HTTP " + response.status + "）");
    return response.json();
  });
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
