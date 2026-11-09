/**
 * Where a Google or Apple Maps link points, read from the URL alone. Shared by
 * the app (long links need no network) and the Worker (which follows short
 * links and looks up Japanese addresses).
 */
export type MapLinkPoint = { lat: number; lng: number };

const NUMBER = String.raw`-?\d{1,3}(?:\.\d+)?`;
const PAIR = new RegExp(`^\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*$`);

function point(lat: number, lng: number): MapLinkPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

function pair(value: string | null) {
  const match = value ? PAIR.exec(value) : null;
  return match ? point(Number(match[1]), Number(match[2])) : null;
}

function parse(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

const host = (parsed: URL) => parsed.hostname.toLowerCase().replace(/^www\./, "");

/** Google Maps on any Google country domain, or maps.google.*. */
export function isGoogleMapsUrl(parsed: URL) {
  const name = host(parsed);
  return /^(?:maps\.)?google\.[a-z.]+$/.test(name) && (name.startsWith("maps.") || parsed.pathname.startsWith("/maps"));
}

export function isAppleMapsUrl(parsed: URL) {
  return host(parsed) === "maps.apple.com";
}

/** Share links that only redirect to the real Google Maps URL. */
export function isMapShortLink(url: string) {
  const parsed = parse(url);
  if (!parsed || parsed.protocol !== "https:") return false;
  const name = host(parsed);
  return name === "maps.app.goo.gl" || (name === "goo.gl" && parsed.pathname.startsWith("/maps/"));
}

export function isMapLink(url: string) {
  const parsed = parse(url);
  return !!parsed && (isGoogleMapsUrl(parsed) || isAppleMapsUrl(parsed) || isMapShortLink(url));
}

/** Coordinates written in a map URL, or null when it names a place without them. */
export function coordinatesFromMapUrl(url: string): MapLinkPoint | null {
  const parsed = parse(url);
  if (!parsed) return null;
  if (isGoogleMapsUrl(parsed)) {
    // A place page: !3d<lat>!4d<lng> is the place itself, @lat,lng the view.
    const place = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(parsed.pathname + parsed.search);
    if (place) return point(Number(place[1]), Number(place[2]));
    const view = /\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(parsed.pathname);
    if (view) return point(Number(view[1]), Number(view[2]));
    for (const key of ["q", "query", "ll", "center", "destination", "daddr"]) {
      const found = pair(parsed.searchParams.get(key));
      if (found) return found;
    }
    return null;
  }
  if (isAppleMapsUrl(parsed)) {
    for (const key of ["ll", "coordinate", "q", "sll", "daddr"]) {
      const found = pair(parsed.searchParams.get(key));
      if (found) return found;
    }
  }
  return null;
}

const FULL_WIDTH = /[０-９－−‐―]/g;
const PREFECTURE = /(?:東京都|北海道|(?:京都|大阪)府|[^\s、,]{2,3}県)/;

/**
 * A Japanese street address in a map URL's search text, cleaned for an
 * address lookup: no postcode or country, ASCII digits, and the shop name
 * after the address dropped. Null when the text is not a Japanese address.
 */
export function japaneseAddressFromMapUrl(url: string): string | null {
  const parsed = parse(url);
  if (!parsed || !(isGoogleMapsUrl(parsed) || isAppleMapsUrl(parsed))) return null;
  const text = ["q", "query", "address", "daddr"].map(key => parsed.searchParams.get(key)).find(Boolean);
  if (!text) return null;
  const normalized = text
    .replace(FULL_WIDTH, char => "０１２３４５６７８９".includes(char) ? String("０１２３４５６７８９".indexOf(char)) : "-")
    .replace(/^\s*(?:日本[、,\s]*)?(?:〒?\s*\d{3}-\d{4}\s*)?/, "");
  const start = normalized.search(PREFECTURE);
  if (start < 0) return null;
  // The address ends at the first space or comma; what follows is the shop name.
  const address = normalized.slice(start).split(/[\s、,]/)[0];
  return /\d/.test(address) ? address : null;
}

/** The prefecture an address starts with, to check a lookup landed in it. */
export function prefectureOf(address: string) {
  return PREFECTURE.exec(address)?.[0] ?? null;
}

/**
 * Phones sharing in English write the address romanized, e.g. "〒151-0051
 * Tokyo, Shibuya, Sendagaya, 3 Chome−30−1 Shop". The postcode names the
 * town in Japanese elsewhere; this returns it with the block number.
 */
export function romanizedJapaneseAddressParts(url: string): { postcode: string; block: string } | null {
  const parsed = parse(url);
  if (!parsed || !(isGoogleMapsUrl(parsed) || isAppleMapsUrl(parsed))) return null;
  const text = ["q", "query", "address", "daddr"].map(key => parsed.searchParams.get(key)).find(Boolean);
  if (!text) return null;
  const normalized = text.replace(FULL_WIDTH, char => "０１２３４５６７８９".includes(char) ? String("０１２３４５６７８９".indexOf(char)) : "-");
  const postcode = /(?:〒\s*)?\b(\d{3})-(\d{4})\b/.exec(normalized);
  if (!postcode) return null;
  const rest = normalized.replace(postcode[0], " ");
  const chome = /\b(\d{1,2})\s*Chome\s*-?\s*(\d{1,4})(?:\s*-\s*(\d{1,4}))?/i.exec(rest);
  const numbers = chome ?? /\b(\d{1,4})-(\d{1,4})(?:-(\d{1,4}))?\b/.exec(rest);
  if (!numbers) return null;
  return { postcode: postcode[1] + postcode[2], block: numbers.slice(1).filter(Boolean).join("-") };
}
