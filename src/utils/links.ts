/**
 * Links in post, comment and DM text: where they are, and which site they
 * point to. Everything here is derived from the URL alone; nothing fetches the
 * page, so showing a link reveals nothing to the linked site until it is opened.
 */

export type LinkSegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; url: string };

export type LinkKind =
  | "youtube" | "vimeo" | "x" | "instagram" | "tiktok" | "niconico" | "maps"
  | "amazon" | "github" | "wikipedia" | "spotify" | "line" | "image" | "web";

export type LinkInfo = {
  kind: LinkKind;
  url: string;
  /** Site name shown on the card. */
  site: string;
  /** Host without "www.", e.g. "youtu.be". */
  display: string;
  /** Present for videos that can be played inline after a tap. */
  embedUrl?: string;
  /** HaiNei Worker path of the video's thumbnail (proxied, see worker/src/videoThumbs.ts). */
  thumbPath?: string;
};

// Stops at whitespace, angle brackets, quotes and full-width CJK punctuation,
// so "看这个https://a.jp/x。" ends before "。".
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`　-〿！-／：-＠［-｀｛-･]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;

function trimUrl(raw: string) {
  let url = raw.replace(TRAILING_PUNCTUATION, "");
  // Keep a closing bracket only when the URL opened one, e.g. a Wikipedia
  // title "Foo_(bar)" versus "(see https://a.jp/x)".
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]] as const) {
    while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
      url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, "");
    }
  }
  return url;
}

/** A safe absolute http(s) URL for `raw`, or null. */
export function normalizeLinkUrl(raw: string): string | null {
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname.includes(".") || parsed.username || parsed.password) return null;
  return parsed.href;
}

/** Split text into plain runs and links, in order. */
export function splitLinks(text: string): LinkSegment[] {
  if (!text || !/https?:\/\/|www\./i.test(text)) return [{ type: "text", text }];
  const segments: LinkSegment[] = [];
  let plainStart = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = trimUrl(match[0]);
    const url = raw && normalizeLinkUrl(raw);
    if (!url) continue;
    if (start > plainStart) segments.push({ type: "text", text: text.slice(plainStart, start) });
    segments.push({ type: "link", text: raw, url });
    plainStart = start + raw.length;
  }
  if (plainStart < text.length) segments.push({ type: "text", text: text.slice(plainStart) });
  return segments.length ? segments : [{ type: "text", text }];
}

/** The host a link points to, without "www.", e.g. "tenki.jp". */
export function linkHost(url: string) {
  return new URL(url).hostname.replace(/^www\./, "");
}

/**
 * `text` without the given links, for text shown above their cards: the
 * spaces a link leaves behind are tidied so "看 https://… ，好" reads "看，好".
 */
export function stripLinks(text: string, urls: ReadonlySet<string>) {
  if (!urls.size) return text;
  return splitLinks(text)
    .map(segment => segment.type === "link" && urls.has(segment.url) ? " " : segment.text)
    .join("")
    .replace(/[ \t]+(?=[\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const hostIs = (host: string, ...domains: string[]) =>
  domains.some(domain => host === domain || host.endsWith(`.${domain}`));

function youtubeId(parsed: URL, host: string) {
  let id: string | null = null;
  if (host === "youtu.be") id = parsed.pathname.slice(1).split("/")[0];
  else if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
  else id = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1] ?? null;
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Which site a link points to, from its URL alone. */
export function classifyLink(url: string): LinkInfo {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const display = linkHost(url);
  const info = (kind: LinkKind, site: string, embedUrl?: string, thumbPath?: string): LinkInfo =>
    ({ kind, url, site, display, embedUrl, thumbPath });

  if (hostIs(host, "youtube.com", "youtu.be", "youtube-nocookie.com")) {
    const id = youtubeId(parsed, host);
    return id
      ? info("youtube", "YouTube", `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1`, `/api/video-thumb/youtube/${id}.jpg`)
      : info("youtube", "YouTube");
  }
  if (hostIs(host, "vimeo.com")) {
    const id = parsed.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
    return id
      ? info("vimeo", "Vimeo", `https://player.vimeo.com/video/${id}?autoplay=1`, `/api/video-thumb/vimeo/${id}.jpg`)
      : info("vimeo", "Vimeo");
  }
  if (hostIs(host, "x.com", "twitter.com")) return info("x", "X");
  if (hostIs(host, "instagram.com")) return info("instagram", "Instagram");
  if (hostIs(host, "tiktok.com")) return info("tiktok", "TikTok");
  if (hostIs(host, "nicovideo.jp", "nico.ms")) return info("niconico", "ニコニコ");
  if (hostIs(host, "maps.apple.com")) return info("maps", "Apple 地图");
  if (host === "maps.app.goo.gl" || (host === "goo.gl" && parsed.pathname.startsWith("/maps"))
    || (/^(?:maps\.)?google\.[a-z.]+$/.test(host) && (host.startsWith("maps.") || parsed.pathname.startsWith("/maps")))) {
    return info("maps", "Google 地图");
  }
  if (/^amazon\.[a-z.]+$/.test(host) || hostIs(host, "amzn.asia", "amzn.to")) return info("amazon", "Amazon");
  if (hostIs(host, "github.com")) return info("github", "GitHub");
  if (hostIs(host, "wikipedia.org")) return info("wikipedia", "维基百科");
  if (hostIs(host, "spotify.com")) return info("spotify", "Spotify");
  if (hostIs(host, "line.me")) return info("line", "LINE");
  if (/\.(?:png|jpe?g|gif|webp|avif)$/i.test(parsed.pathname)) return info("image", "图片");
  return info("web", host);
}

/**
 * Recognized links in `text` worth a card, first `max` distinct ones.
 * Plain web pages stay inline links only.
 */
export function linkCardsFor(text: string, max = 3): LinkInfo[] {
  const seen = new Set<string>();
  const cards: LinkInfo[] = [];
  for (const segment of splitLinks(text)) {
    if (segment.type !== "link" || seen.has(segment.url)) continue;
    seen.add(segment.url);
    const info = classifyLink(segment.url);
    if (info.kind === "web") continue;
    cards.push(info);
    if (cards.length >= max) break;
  }
  return cards;
}
