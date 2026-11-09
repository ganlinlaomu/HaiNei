/**
 * Coordinates for a map link in a post or chat, so the app can draw a map
 * thumbnail. Share links (maps.app.goo.gl) are followed here because the
 * browser cannot read cross-origin redirects; links that only carry a
 * Japanese address are looked up with GSI (国土地理院), a romanized one by
 * first naming its town from the postcode (zipcloud). Like /tiles/, only
 * HaiNei pages may call it, results are cached at the edge, and URLs and
 * coordinates are never logged.
 */
import {
  coordinatesFromMapUrl, isMapLink, isMapShortLink, japaneseAddressFromMapUrl, prefectureOf,
  romanizedJapaneseAddressParts, type MapLinkPoint,
} from "../../src/utils/mapLinkLocation";
import { tileRequestAllowed } from "./tiles";

export const MAP_LINK_PATH = "/api/map-link";
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;
const FOUND_TTL_SECONDS = 30 * 24 * 60 * 60;
const MISSING_TTL_SECONDS = 24 * 60 * 60;
const GSI_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const POSTCODE_SEARCH = "https://zipcloud.ibsnet.co.jp/api/search";
const USER_AGENT = "HaiNei/1.0 (private messaging app map link preview; +https://hainei-9iv.pages.dev; admin@hainei.app)";

type MapLinkDeps = {
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  cache?: Pick<Cache, "match" | "put">;
};

function reply(value: MapLinkPoint | null, maxAge: number) {
  return new Response(JSON.stringify(value ? { lat: value.lat, lng: value.lng } : {}), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${maxAge}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** Follow a share link through Google's redirects, staying on map URLs. */
async function expandShortLink(url: string, fetchUpstream: NonNullable<MapLinkDeps["fetchUpstream"]>) {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const response = await fetchUpstream(current, { redirect: "manual", headers: { "User-Agent": USER_AGENT } });
    const location = response.headers.get("Location");
    if (response.status < 300 || response.status >= 400 || !location) return current;
    const next = new URL(location, current).href;
    if (!next.startsWith("https://") || !isMapLink(next)) return current;
    current = next;
    if (coordinatesFromMapUrl(current)) return current;
  }
  return current;
}

async function lookUpAddress(address: string, fetchUpstream: NonNullable<MapLinkDeps["fetchUpstream"]>) {
  const response = await fetchUpstream(`${GSI_SEARCH}?q=${encodeURIComponent(address)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) return null;
  const results = await response.json().catch(() => null) as
    Array<{ geometry?: { coordinates?: [number, number] }; properties?: { title?: string } }> | null;
  const first = Array.isArray(results) ? results[0] : undefined;
  const [lng, lat] = first?.geometry?.coordinates ?? [];
  // GSI returns its best guess even for a bad query; accept it only in the
  // address's own prefecture.
  const prefecture = prefectureOf(address);
  if (!prefecture || !first?.properties?.title?.startsWith(prefecture)) return null;
  return typeof lat === "number" && typeof lng === "number" ? { lat, lng } : null;
}

/** "東京都渋谷区千駄ヶ谷" for 1510051, via the postcode's single town. */
async function townForPostcode(postcode: string, fetchUpstream: NonNullable<MapLinkDeps["fetchUpstream"]>) {
  const response = await fetchUpstream(`${POSTCODE_SEARCH}?zipcode=${postcode}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as
    { results?: Array<{ address1?: string; address2?: string; address3?: string }> | null } | null;
  const towns = body?.results ?? [];
  const first = towns[0];
  // A postcode shared by several towns, or one standing for "the rest of the
  // ward", does not say which street the block number belongs to.
  if (!first?.address1 || !first.address2 || !first.address3 || towns.length > 1) return null;
  if (/以下に掲載がない場合|[（(]/.test(first.address3)) return null;
  return `${first.address1}${first.address2}${first.address3}`;
}

export async function resolveMapLink(url: string, deps: MapLinkDeps = {}): Promise<MapLinkPoint | null> {
  const fetchUpstream = deps.fetchUpstream ?? ((target, init) => fetch(target, init));
  const expanded = isMapShortLink(url) ? await expandShortLink(url, fetchUpstream) : url;
  const direct = coordinatesFromMapUrl(expanded);
  if (direct) return direct;
  const address = japaneseAddressFromMapUrl(expanded);
  if (address) return lookUpAddress(address, fetchUpstream);
  const romanized = romanizedJapaneseAddressParts(expanded);
  if (!romanized) return null;
  const town = await townForPostcode(romanized.postcode, fetchUpstream);
  return town ? lookUpAddress(`${town}${romanized.block}`, fetchUpstream) : null;
}

export async function handleMapLinkRequest(request: Request, deps: MapLinkDeps = {}) {
  if (!tileRequestAllowed(request)) return new Response("forbidden", { status: 403 });
  const url = new URL(request.url).searchParams.get("u") || "";
  if (!url || url.length > MAX_URL_LENGTH || !url.startsWith("https://") || !isMapLink(url)) {
    return new Response("bad request", { status: 400 });
  }
  const cache = deps.cache ?? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(`https://map-link.hainei.invalid/?u=${encodeURIComponent(url)}`);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;
  let found: MapLinkPoint | null = null;
  try {
    found = await resolveMapLink(url, deps);
  } catch {
    // Upstream failure: answer "no coordinates" without caching it for long.
    return reply(null, 60);
  }
  const response = reply(found, found ? FOUND_TTL_SECONDS : MISSING_TTL_SECONDS);
  if (cache) await cache.put(cacheKey, response.clone());
  return response;
}
