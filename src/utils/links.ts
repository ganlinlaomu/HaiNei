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
  /** Host and path without scheme or "www.", shortened for display. */
  display: string;
  /** Present for videos that can be played inline after a tap. */
  embedUrl?: string;
};

// Stops at whitespace, angle brackets, quotes and full-width CJK punctuation,
// so "看这个https://a.jp/x。" ends before "。".
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`　-〿！-／：-＠［-｀｛-･]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"*_~]+$/;
const DISPLAY_LENGTH = 42;

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

function shortDisplay(parsed: URL) {
  const host = parsed.hostname.replace(/^www\./, "");
  const path = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  let display = host + path;
  try {
    display = decodeURI(display);
  } catch {
    // Keep the encoded form when it is not valid UTF-8.
  }
  return Array.from(display).length > DISPLAY_LENGTH
    ? `${Array.from(display).slice(0, DISPLAY_LENGTH - 1).join("")}…`
    : display;
}

/** Short form of a link for running text: no scheme or "www.", truncated. */
export function shortLinkText(url: string) {
  return shortDisplay(new URL(url));
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
  const display = shortDisplay(parsed);
  const info = (kind: LinkKind, site: string, embedUrl?: string): LinkInfo => ({ kind, url, site, display, embedUrl });

  if (hostIs(host, "youtube.com", "youtu.be", "youtube-nocookie.com")) {
    const id = youtubeId(parsed, host);
    return info("youtube", "YouTube", id ? `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1` : undefined);
  }
  if (hostIs(host, "vimeo.com")) {
    const id = parsed.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
    return info("vimeo", "Vimeo", id ? `https://player.vimeo.com/video/${id}?autoplay=1` : undefined);
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
