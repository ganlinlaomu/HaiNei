/** Public-domain Gutenberg catalogue adapter. No API token or account required. */
export type CatalogBook = {
  id: string;
  title: string;
  authors: string[];
  language: string;
  coverUrl?: string;
  epubUrl: string;
  sourceUrl: string;
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

const CATALOG_ORIGIN = "https://gutendex.com";
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

export async function searchGutenberg(query: string, page = 1, language = "", signal?: AbortSignal): Promise<{
  books: CatalogBook[];
  hasNext: boolean;
}> {
  const params = new URLSearchParams({ search: query.trim(), copyright: "false", page: String(Math.max(1, Math.floor(page))) });
  if (language) params.set("languages", language);
  const response = await fetch(CATALOG_ORIGIN + "/books/?" + params.toString(), { signal, cache: "no-store" });
  if (!response.ok) throw new Error("书库暂时无法访问（HTTP " + response.status + "）");
  const data = await response.json() as GutenbergPage;
  if (!Array.isArray(data.results)) throw new Error("书库数据格式异常");
  return { books: data.results.map(mapGutenbergBook).filter((book): book is CatalogBook => !!book), hasNext: !!data.next };
}
