/**
 * Map tiles for the in-app location map, proxied so OpenStreetMap sees this
 * Worker instead of each user's IP. Only HaiNei pages may use it (Referer
 * origin; CORS image requests send Origin, with Referer kept as a fallback), zoom and tile
 * numbers are validated, and tiles are cached at the edge for 7 days in
 * line with the OSM tile usage policy. Coordinates are never logged.
 */
const TILE_PATH = /^\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/;
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;
const EDGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_TTL_SECONDS = 24 * 60 * 60;
const UPSTREAM = "https://tile.openstreetmap.org";
// The OSM tile policy requires an identifying User-Agent with contact info.
const USER_AGENT = "HaiNei/1.0 (private messaging app location map; +https://hainei-9iv.pages.dev; admin@hainei.app)";

const ALLOWED_ORIGIN = /^(https:\/\/([a-z0-9-]+\.)?hainei-9iv\.pages\.dev|https?:\/\/localhost(:\d+)?|http:\/\/127\.0\.0\.1(:\d+)?)$/;

export function isTilePath(path: string) {
  return path.startsWith("/tiles/");
}

export function parseTilePath(path: string): { z: number; x: number; y: number } | null {
  const match = TILE_PATH.exec(path);
  if (!match) return null;
  const [z, x, y] = match.slice(1).map(Number);
  if (z < MIN_ZOOM || z > MAX_ZOOM) return null;
  const size = 2 ** z;
  if (x >= size || y >= size) return null;
  return { z, x, y };
}

export function tileRequestAllowed(request: Request) {
  const origin = request.headers.get("Origin");
  if (origin) return ALLOWED_ORIGIN.test(origin);
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return ALLOWED_ORIGIN.test(new URL(referer).origin);
  } catch {
    return false;
  }
}

type TileDeps = {
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  cache?: Pick<Cache, "match" | "put">;
};

export async function handleTileRequest(request: Request, path: string, deps: TileDeps = {}) {
  const tile = parseTilePath(path);
  if (!tile) return new Response("not found", { status: 404 });
  if (!tileRequestAllowed(request)) return new Response("forbidden", { status: 403 });
  const cache = deps.cache ?? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  // One cache entry per tile, independent of the requesting page.
  const cacheKey = new Request(`${UPSTREAM}/${tile.z}/${tile.x}/${tile.y}.png`);
  const cached = await cache?.match(cacheKey);
  if (cached) return withClientHeaders(cached);
  const fetchUpstream = deps.fetchUpstream ?? ((url, init) => fetch(url, init));
  const upstream = await fetchUpstream(cacheKey.url, { headers: { "User-Agent": USER_AGENT, Accept: "image/png" } });
  if (!upstream.ok || !(upstream.headers.get("Content-Type") || "").startsWith("image/")) {
    return new Response("tile unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const response = new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": `public, max-age=${EDGE_TTL_SECONDS}` },
  });
  if (cache) await cache.put(cacheKey, response.clone());
  return withClientHeaders(response);
}

function withClientHeaders(response: Response) {
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": `private, max-age=${BROWSER_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
