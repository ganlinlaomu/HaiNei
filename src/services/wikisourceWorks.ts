/**
 * Turn Chinese Wikisource search hits into downloadable works.
 *
 * Shared by the Pages Function (functions/api/books/wikisource) and the
 * browser's direct CORS fallback, so it must not use the "@/" alias.
 *
 * Plain search hits are often not exportable books:
 * - 版本页 (pageprops.disambiguation, e.g. 水滸傳, 道德經) only list editions;
 *   WS Export turns them into a 3 KB EPUB of links. Show the editions instead.
 * - Redirects (聊齋誌異 → 聊齋志異): WS Export looks for chapters under the
 *   redirect's own title and finds none. Use the target title.
 * - Subpages (水滸傳 (70回本)/讀法) are single chapters. Use the root work.
 */
import type { CatalogBook, CatalogPage } from "./ebookCatalog";

/** Calls the MediaWiki action API with these parameters and returns its JSON. */
export type WikiApi = (params: Record<string, string>) => Promise<any>;

type WikiPage = { pageid?: number; ns?: number; title?: string; index?: number; missing?: boolean; pageprops?: Record<string, string>; links?: Array<{ ns?: number; title?: string }> };

const MAX_VERSION_PAGES = 3;
const EDITIONS_PER_VERSION_PAGE = 8;
const MAX_LOOKUP_TITLES = 50;

export function validWorkTitle(title: unknown): title is string {
  return typeof title === "string" && title.length > 0 && title.length <= 180 && !title.includes(":") && !/[\x00-\x1f\x7f]/.test(title);
}

export function wikisourceBook(pageid: number, title: string): CatalogBook {
  return {
    id: "wikisource:" + pageid, title, authors: [], language: "zh",
    sourceUrl: "https://zh.wikisource.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")),
    epubUrl: "https://ws-export-app.wmcloud.org/?" + new URLSearchParams({ lang: "zh", page: title, format: "epub-3", credits: "false" }),
    downloads: 0,
  };
}

function pagesOf(data: any): WikiPage[] {
  const pages = data?.query?.pages;
  return Array.isArray(pages) ? pages : [];
}

/** Map of requested title → final title, following normalization and redirects. */
function finalTitles(data: any): Map<string, string> {
  const map = new Map<string, string>();
  for (const step of [...(data?.query?.normalized || []), ...(data?.query?.redirects || [])]) {
    if (typeof step?.from === "string" && typeof step?.to === "string") map.set(step.from, step.to);
  }
  return map;
}

function follow(map: Map<string, string>, title: string) {
  let current = title;
  for (let hop = 0; hop < 4 && map.has(current); hop++) current = map.get(current)!;
  return current;
}

/** Editions listed on a 版本页, those named like the work first. */
export function pickEditions(versionTitle: string, links: Array<{ ns?: number; title?: string }>): string[] {
  const titles = links.filter(link => link.ns === 0 && validWorkTitle(link.title) && link.title !== versionTitle)
    .map(link => link.title!);
  const named = titles.filter(title => title.startsWith(versionTitle));
  const others = titles.filter(title => !title.startsWith(versionTitle));
  return [...named, ...others].slice(0, EDITIONS_PER_VERSION_PAGE);
}

export async function searchWikisourceWorks(query: string, page: number, api: WikiApi): Promise<CatalogPage> {
  const data = await api({
    action: "query", generator: "search", gsrsearch: query, gsrnamespace: "0", gsrlimit: "20",
    gsroffset: String((page - 1) * 20), gsrprop: "", prop: "pageprops", ppprop: "disambiguation",
    redirects: "1", format: "json", formatversion: "2",
  });
  if (data?.query !== undefined && !Array.isArray(data.query.pages)) throw new Error("中文维基文库返回的数据格式异常");
  const hits = pagesOf(data)
    .filter(hit => hit.ns === 0 && Number.isSafeInteger(hit.pageid) && (hit.pageid || 0) > 0 && validWorkTitle(hit.title))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const hasNext = Number.isInteger(data?.continue?.gsroffset);

  // Each hit becomes the titles to offer, in order. Known pages are final.
  const known = new Map<string, { pageid: number; versions: boolean }>();
  for (const hit of hits) known.set(hit.title!, { pageid: hit.pageid!, versions: hit.pageprops?.disambiguation !== undefined });
  const versionPages = hits.filter(hit => known.get(hit.title!)!.versions).slice(0, MAX_VERSION_PAGES).map(hit => hit.title!);
  const editions = new Map<string, string[]>();
  if (versionPages.length) {
    const linked = await api({
      action: "query", titles: versionPages.join("|"), prop: "links", plnamespace: "0", pllimit: "max",
      format: "json", formatversion: "2",
    }).catch(() => null);
    for (const item of pagesOf(linked)) {
      if (item.title && Array.isArray(item.links)) editions.set(item.title, pickEditions(item.title, item.links));
    }
  }
  const wanted = hits.map(hit => {
    const title = hit.title!;
    if (title.includes("/")) return [title.split("/")[0]];
    if (known.get(title)!.versions) return editions.get(title) || [];
    return [title];
  });

  const unknown = [...new Set(wanted.flat().filter(title => !known.has(title)))].slice(0, MAX_LOOKUP_TITLES);
  let redirects = new Map<string, string>();
  if (unknown.length) {
    const looked = await api({
      action: "query", titles: unknown.join("|"), prop: "pageprops", ppprop: "disambiguation", redirects: "1",
      format: "json", formatversion: "2",
    }).catch(() => null);
    redirects = finalTitles(looked);
    for (const item of pagesOf(looked)) {
      if (!item.missing && item.ns === 0 && Number.isSafeInteger(item.pageid) && validWorkTitle(item.title)) {
        known.set(item.title!, { pageid: item.pageid!, versions: item.pageprops?.disambiguation !== undefined });
      }
    }
  }

  const books: CatalogBook[] = [];
  const seen = new Set<number>();
  for (const titles of wanted) {
    for (const requested of titles) {
      const title = follow(redirects, requested);
      const work = known.get(title);
      if (!work || work.versions || seen.has(work.pageid)) continue;
      seen.add(work.pageid);
      books.push(wikisourceBook(work.pageid, title));
    }
  }
  return { books, hasNext };
}

export type ResolvedWork = { kind: "work"; title: string } | { kind: "versions"; editions: string[] } | { kind: "missing" };

/** The page WS Export should get for `title`: redirects followed, 版本页 refused. */
export async function resolveWikisourceWork(title: string, api: WikiApi): Promise<ResolvedWork> {
  const data = await api({
    action: "query", titles: title, prop: "pageprops|links", ppprop: "disambiguation", plnamespace: "0", pllimit: "max",
    redirects: "1", format: "json", formatversion: "2",
  });
  const item = pagesOf(data)[0];
  if (!item || item.missing || item.ns !== 0 || !validWorkTitle(item.title)) return { kind: "missing" };
  if (item.pageprops?.disambiguation !== undefined) return { kind: "versions", editions: pickEditions(item.title, item.links || []) };
  return { kind: "work", title: item.title };
}
