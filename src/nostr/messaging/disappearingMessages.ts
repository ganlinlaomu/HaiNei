/**
 * HaiNei disappearing DM metadata. This is an opt-in extension within NIP-17,
 * not a new public event kind. NIP-40 controls *absolute* expiration only.
 */
export const DISAPPEARING_DM_TYPE = "hainei-dm-disappearing";
export const DISAPPEARING_DM_TTL_SECONDS = 48 * 60 * 60;
export const BURN_DURATIONS = [10, 30, 60] as const;
export type BurnDuration = typeof BURN_DURATIONS[number];

export type DisappearingMetadata = { expiresAt: number; burnAfterSeconds: BurnDuration };
export const hasDisappearingMarker = (tags?: string[][]): boolean =>
  tags?.some(tag => tag[0] === "t" && tag[1] === DISAPPEARING_DM_TYPE) === true;

export function expirationFromTags(tags?: string[][]): number | null {
  const matching = tags?.filter(tag => tag[0] === "expiration") || [];
  if (matching.length !== 1 || matching[0].length !== 2) return null;
  const raw = matching[0][1];
  if (!/^\d{1,12}$/.test(raw)) return null;
  const timestamp = Number(raw);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

export function disappearingMetadata(tags?: string[][]): DisappearingMetadata | null {
  if (!hasDisappearingMarker(tags)) return null;
  if (tags?.filter(tag => tag[0] === "t" && tag[1] === DISAPPEARING_DM_TYPE).length !== 1) return null;
  const expiry = expirationFromTags(tags);
  const timers = tags?.filter(tag => tag[0] === "burn-after") || [];
  if (expiry === null || timers.length !== 1 || timers[0].length !== 2) return null;
  const burnAfterSeconds = Number(timers[0][1]);
  if (!BURN_DURATIONS.includes(burnAfterSeconds as BurnDuration)) return null;
  return { expiresAt: expiry, burnAfterSeconds: burnAfterSeconds as BurnDuration };
}

export function isExpiredDisappearing(tags?: string[][], nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!hasDisappearingMarker(tags)) return false;
  const metadata = disappearingMetadata(tags);
  // Malformed temporary metadata must fail closed.
  return !metadata || metadata.expiresAt <= nowSeconds;
}
