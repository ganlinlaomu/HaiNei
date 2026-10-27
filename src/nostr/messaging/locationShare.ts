/** A one-time location travels inside a regular encrypted NIP-17 DM. */
export const LOCATION_SHARE_TYPE = "hainei-location";

/** Live sharing marker on the opening card: share id and when it ends. */
export type LiveLocationInfo = { id: string; expiresAt: number };
/** Coordinates in degrees, accuracy radius in metres, `at` in unix seconds. */
export type LocationShare = { lat: number; lng: number; accuracy?: number; at: number; live?: LiveLocationInfo };

/** Live sharing durations offered to the user, in seconds. */
export const LIVE_LOCATION_DURATIONS = [15 * 60, 60 * 60] as const;
const MAX_LIVE_SECONDS = 60 * 60;
const LIVE_ID = /^[0-9a-f]{32}$/;

// 5 decimal places is about 1 m: finer digits carry no real precision from a
// phone and would only make the payload more identifying.
const round = (value: number) => Math.round(value * 1e5) / 1e5;
const MAX_ACCURACY_METRES = 100_000;

function validLive(value: unknown, at: number): LiveLocationInfo | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, expiresAt } = value as Record<string, unknown>;
  if (typeof id !== "string" || !LIVE_ID.test(id)) return null;
  // Bounded to the longest offered share (plus clock slack), so a card can
  // never promise an open-ended live location.
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)
    || expiresAt <= at || expiresAt > at + MAX_LIVE_SECONDS + 60) return null;
  return { id, expiresAt };
}

function validLocation(value: { lat: unknown; lng: unknown; accuracy?: unknown; at: unknown; live?: unknown }): LocationShare | null {
  const { lat, lng, accuracy, at } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) return null;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) return null;
  if (accuracy !== undefined
    && (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_METRES)) return null;
  const live = validLive(value.live, at);
  if (live === null) return null;
  return {
    lat: round(lat),
    lng: round(lng),
    ...(accuracy === undefined ? {} : { accuracy: Math.round(accuracy) }),
    at,
    ...(live ? { live } : {}),
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
    return validLocation({ lat: value.lat, lng: value.lng, accuracy: value.accuracy, at: value.at, live: value.live });
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

/** A new random live share id (128 bits, hex). */
export function newLiveLocationId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/*
 * Live updates and the stop signal are ephemeral controls, not chat messages:
 * tagged so routing never stores them, sent without the durable queue, and
 * wrapped with a NIP-40 expiration so relays drop them. Each carries the
 * share's expiry, so it stands alone even if the opening card is late.
 */
export const LIVE_LOCATION_CONTROL_TYPE = "hainei-location-live";

export type LiveLocationControl =
  | { kind: "update"; id: string; expiresAt: number; seq: number; location: LocationShare }
  | { kind: "stop"; id: string; at: number };

export function liveLocationControlTags(): string[][] {
  return [["t", LIVE_LOCATION_CONTROL_TYPE]];
}

export function isLiveLocationControlTags(tags: string[][] | undefined) {
  return !!tags?.some(tag => tag[0] === "t" && tag[1] === LIVE_LOCATION_CONTROL_TYPE);
}

export function serializeLiveLocationControl(control: LiveLocationControl): string {
  if (!LIVE_ID.test(control.id)) throw new Error("无效的位置共享");
  if (control.kind === "stop") {
    if (!Number.isSafeInteger(control.at) || control.at <= 0) throw new Error("无效的位置共享");
    return JSON.stringify({ type: LIVE_LOCATION_CONTROL_TYPE, id: control.id, stop: true, at: control.at });
  }
  if (!Number.isSafeInteger(control.seq) || control.seq < 0) throw new Error("无效的位置共享");
  const location = validLocation({ ...control.location, live: { id: control.id, expiresAt: control.expiresAt } });
  if (!location) throw new Error("无效的位置");
  return JSON.stringify({
    type: LIVE_LOCATION_CONTROL_TYPE, id: control.id, expiresAt: control.expiresAt, seq: control.seq,
    lat: location.lat, lng: location.lng, ...(location.accuracy === undefined ? {} : { accuracy: location.accuracy }), at: location.at,
  });
}

/** Decodes a tagged live location control. Untagged JSON is never a control. */
export function decodeLiveLocationControl(message: { tags?: string[][]; plaintext?: string }): LiveLocationControl | null {
  if (!isLiveLocationControlTags(message.tags) || typeof message.plaintext !== "string" || message.plaintext.length > 1024) return null;
  try {
    const value = JSON.parse(message.plaintext) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || value.type !== LIVE_LOCATION_CONTROL_TYPE
      || typeof value.id !== "string" || !LIVE_ID.test(value.id)) return null;
    if (value.stop === true) {
      return typeof value.at === "number" && Number.isSafeInteger(value.at) && value.at > 0
        ? { kind: "stop", id: value.id, at: value.at } : null;
    }
    if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
    const location = validLocation({ lat: value.lat, lng: value.lng, accuracy: value.accuracy, at: value.at, live: { id: value.id, expiresAt: value.expiresAt } });
    if (!location?.live) return null;
    return { kind: "update", id: value.id, expiresAt: location.live.expiresAt, seq: value.seq, location };
  } catch {
    return null;
  }
}
