/** A one-time location travels inside a regular encrypted NIP-17 DM. */
export const LOCATION_SHARE_TYPE = "hainei-location";

/** Coordinates in degrees, accuracy radius in metres, `at` in unix seconds. */
export type LocationShare = { lat: number; lng: number; accuracy?: number; at: number };

// 5 decimal places is about 1 m: finer digits carry no real precision from a
// phone and would only make the payload more identifying.
const round = (value: number) => Math.round(value * 1e5) / 1e5;
const MAX_ACCURACY_METRES = 100_000;

function validLocation(value: { lat: unknown; lng: unknown; accuracy?: unknown; at: unknown }): LocationShare | null {
  const { lat, lng, accuracy, at } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return null;
  if (accuracy !== undefined
    && (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_METRES)) return null;
  return {
    lat: round(lat),
    lng: round(lng),
    ...(accuracy === undefined ? {} : { accuracy: Math.round(accuracy) }),
    at,
  };
}

export function serializeLocationShare(location: LocationShare): string {
  const valid = validLocation(location);
  if (!valid) throw new Error("无效的位置");
  return JSON.stringify({ type: LOCATION_SHARE_TYPE, ...valid });
}

/**
 * Unknown extra fields are ignored rather than rejected, so a later live
 * share (which adds fields) still shows as a location card on this version.
 */
export function parseLocationShare(content: string): LocationShare | null {
  if (typeof content !== "string" || content.length > 1024 || !content.trim().startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    if (value.type !== LOCATION_SHARE_TYPE) return null;
    return validLocation({ lat: value.lat, lng: value.lng, accuracy: value.accuracy, at: value.at });
  } catch {
    return null;
  }
}

/** "31.23041, 121.4737" style, for display and copying. */
export function formatCoordinates(location: Pick<LocationShare, "lat" | "lng">) {
  return `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
}

/**
 * Opens the location in the system maps app. Only on an explicit tap: a map
 * provider learns the coordinates, so the chat never loads map tiles itself.
 */
export function mapsUrl(location: Pick<LocationShare, "lat" | "lng">, userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent) {
  const coordinates = `${location.lat},${location.lng}`;
  return /Android/i.test(userAgent)
    ? `geo:${coordinates}?q=${coordinates}`
    : `https://maps.apple.com/?ll=${coordinates}&q=${encodeURIComponent("位置")}`;
}
