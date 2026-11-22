/**
 * Video thumbnails for YouTube/Vimeo link cards, proxied like /tiles/ so the
 * video site sees this Worker instead of each reader's IP. Only HaiNei pages
 * may use it, ids are validated, images are cached at the edge, and nothing
 * about the request is logged.
 */
import { tileRequestAllowed } from "./tiles";

const THUMB_PATH = /^\/api\/video-thumb\/(youtube|vimeo)\/([A-Za-z0-9_-]{1,20})\.jpg$/;
const EDGE_TTL_SECONDS = 7 * 24 * 60 * 60;
const BROWSER_TTL_SECONDS = 24 * 60 * 60;
const MAX_BYTES = 2 * 1024 * 1024;
// Raster types only: an upstream SVG would run as a document on this origin.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function imageType(value: string | null) {
  const type = (value || "").split(";")[0].trim().toLowerCase();
  return IMAGE_TYPES.has(type) ? type : "";
}

/** The body, or null once it exceeds `limit` (Content-Length may be absent or wrong). */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
const USER_AGENT = "HaiNei/1.0 (private messaging app video preview; +https://hainei-9iv.pages.dev; admin@hainei.app)";

type ThumbDeps = {
  fetchUpstream?: (url: string, init: RequestInit) => Promise<Response>;
  cache?: Pick<Cache, "match" | "put">;
};

export function isVideoThumbPath(path: string) {
  return path.startsWith("/api/video-thumb/");
}

export function parseVideoThumbPath(path: string): { provider: "youtube" | "vimeo"; id: string } | null {
  const match = THUMB_PATH.exec(path);
  if (!match) return null;
  const [, provider, id] = match;
  if (provider === "youtube" && !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  if (provider === "vimeo" && !/^\d{1,12}$/.test(id)) return null;
  return { provider: provider as "youtube" | "vimeo", id };
}

/** Where the thumbnail lives: fixed for YouTube, asked of oEmbed for Vimeo. */
async function upstreamImageUrl(provider: "youtube" | "vimeo", id: string, fetchUpstream: NonNullable<ThumbDeps["fetchUpstream"]>) {
  if (provider === "youtube") return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  const oembed = await fetchUpstream(
    `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}&width=640`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } },
  );
  if (!oembed.ok) return null;
  const body = await oembed.json().catch(() => null) as { thumbnail_url?: unknown } | null;
  const url = typeof body?.thumbnail_url === "string" ? body.thumbnail_url : "";
  // Only Vimeo's own image CDN, whatever the oEmbed answer says.
  return /^https:\/\/i\.vimeocdn\.com\//.test(url) ? url : null;
}

export async function handleVideoThumbRequest(request: Request, path: string, deps: ThumbDeps = {}) {
  const thumb = parseVideoThumbPath(path);
  if (!thumb) return new Response("not found", { status: 404 });
  if (!tileRequestAllowed(request)) return new Response("forbidden", { status: 403 });
  const cache = deps.cache ?? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(`https://video-thumb.hainei.invalid/${thumb.provider}/${thumb.id}.jpg`);
  const cached = await cache?.match(cacheKey);
  if (cached) return withClientHeaders(cached);
  const fetchUpstream = deps.fetchUpstream ?? ((url, init) => fetch(url, init));
  const missing = () => new Response("thumbnail unavailable", { status: 404, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  try {
    const imageUrl = await upstreamImageUrl(thumb.provider, thumb.id, fetchUpstream);
    if (!imageUrl) return missing();
    const upstream = await fetchUpstream(imageUrl, { headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/*" } });
    const type = imageType(upstream.headers.get("Content-Type"));
    const length = Number(upstream.headers.get("Content-Length") || 0);
    if (!upstream.ok || !type || length > MAX_BYTES) return missing();
    const bytes = await readLimited(upstream.body, MAX_BYTES);
    if (!bytes) return missing();
    const response = new Response(bytes, {
      status: 200,
      headers: { "Content-Type": type, "Cache-Control": `public, max-age=${EDGE_TTL_SECONDS}` },
    });
    if (cache) await cache.put(cacheKey, response.clone());
    return withClientHeaders(response);
  } catch {
    return missing();
  }
}

function withClientHeaders(response: Response) {
  return new Response(response.body, {
    status: 200,
    headers: {
      // Edge entries cached before the type check may carry any type.
      "Content-Type": imageType(response.headers.get("Content-Type")) || "image/jpeg",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": `private, max-age=${BROWSER_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}
