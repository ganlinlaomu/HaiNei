import type { CatalogBook, CatalogPage } from "@/services/ebookCatalog";

const INDEX_URL = "/ebook-catalog/aozora-index-v1.json";
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
let indexPromise: Promise<CatalogBook[]> | null = null;

/** Only loaded if the reader searches Aozora; never fetched on app startup. */
export async function loadAozoraIndex(signal?: AbortSignal): Promise<CatalogBook[]> {
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  if (!indexPromise) {
    indexPromise = (async () => {
      const response = await fetch(INDEX_URL);
      if (!response.ok) throw new Error("青空文库书目尚未就绪，请稍后重试。");
      const announced = Number(response.headers.get("Content-Length") || 0);
      if (announced > MAX_INDEX_BYTES) throw new Error("青空文库书目数据超出上限");
      const text = await response.text();
      if (text.length > MAX_INDEX_BYTES) throw new Error("青空文库书目数据超出上限");
      const data = JSON.parse(text) as { version?: number; books?: CatalogBook[] };
      if (data.version !== 1 || !Array.isArray(data.books) || data.books.length < 1000 ||
          data.books.length > 30000) throw new Error("青空文库书目数据格式异常");
      return data.books.filter(book =>
        typeof book.id === "string" && /^aozora:[1-9]\d*$/.test(book.id) &&
        typeof book.title === "string" && Array.isArray(book.authors) &&
        book.authors.every(author => typeof author === "string") &&
        typeof book.sourceUrl === "string" && book.sourceUrl.startsWith("https://www.aozora.gr.jp/cards/") &&
        typeof book.epubUrl === "string" && book.epubUrl.startsWith("https://www.aozora.gr.jp/cards/")
      );
    })().catch(error => { indexPromise = null; throw error; });
  }
  const items = await indexPromise;
  if (signal?.aborted) throw new DOMException("搜索已取消", "AbortError");
  return items;
}

export async function searchAozoraIndex(query: string, page: number, signal?: AbortSignal): Promise<CatalogPage> {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error("无效的青空文库页码");
  const items = await loadAozoraIndex(signal);
  const q = query.trim().toLocaleLowerCase();
  const matches = items.filter(book =>
    (book.title + " " + book.authors.join(" ")).toLocaleLowerCase().includes(q));
  const start = (page - 1) * 20;
  return { books: matches.slice(start, start + 20), hasNext: start + 20 < matches.length };
}

/** For isolated tests; normal PWA sessions keep the index in memory. */
export function clearAozoraCatalogMemoryCache(): void { indexPromise = null; }
