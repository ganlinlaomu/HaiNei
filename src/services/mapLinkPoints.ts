import { haineiWorkerBaseUrl } from "@/services/workerUrl";
import { coordinatesFromMapUrl, isMapLink, type MapLinkPoint } from "@/utils/mapLinkLocation";

const MAX_CACHED = 200;
const pending = new Map<string, Promise<MapLinkPoint | null>>();

/**
 * Where a map link points: read from the URL when it carries coordinates,
 * otherwise asked of the HaiNei Worker (share links, address-only links).
 * Answers are kept for the session so scrolling back costs nothing.
 */
export function mapLinkPoint(url: string, fetchImpl: typeof fetch = fetch): Promise<MapLinkPoint | null> {
  const local = coordinatesFromMapUrl(url);
  if (local) return Promise.resolve(local);
  if (!isMapLink(url)) return Promise.resolve(null);
  const known = pending.get(url);
  if (known) return known;
  const request = fetchImpl(`${haineiWorkerBaseUrl()}/api/map-link?u=${encodeURIComponent(url)}`)
    .then(response => response.ok ? response.json() : null)
    .then((body: { lat?: unknown; lng?: unknown } | null) =>
      typeof body?.lat === "number" && typeof body?.lng === "number" ? { lat: body.lat, lng: body.lng } : null)
    .catch(() => {
      // Offline or the Worker lacks the route: try again next time.
      pending.delete(url);
      return null;
    });
  if (pending.size >= MAX_CACHED) pending.delete(pending.keys().next().value!);
  pending.set(url, request);
  return request;
}

export function clearMapLinkPoints() {
  pending.clear();
}
