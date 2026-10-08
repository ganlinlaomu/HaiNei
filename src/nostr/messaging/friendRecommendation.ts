/** A friend recommendation travels inside a regular encrypted NIP-17 DM. */
export const FRIEND_RECOMMENDATION_TYPE = "hainei-friend-recommendation";

// Nickname/bio are explicitly forwarded snapshots, not identity attestations.
// They may be absent for older cards or friends without synced profiles.
export type FriendRecommendation = { pubkey: string; nickname?: string; bio?: string };
const PUBKEY_HEX = /^[0-9a-f]{64}$/i;

function validatedText(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (cleaned.length > maxLength) return null;
  return cleaned || undefined;
}

export function serializeFriendRecommendation(pubkey: string, profile?: { nickname?: string; bio?: string }): string {
  const normalized = pubkey.trim().toLowerCase();
  if (!PUBKEY_HEX.test(normalized)) throw new Error("无效的好友公钥");
  const nickname = validatedText(profile?.nickname, 100);
  const bio = validatedText(profile?.bio, 500);
  if (nickname === null || bio === null) throw new Error("昵称或简介过长");
  // Only owner-authored profile fields: never send local aliases, notes, groups or avatar URLs.
  return JSON.stringify({
    type: FRIEND_RECOMMENDATION_TYPE,
    pubkey: normalized,
    ...(nickname ? { nickname } : {}),
    ...(bio ? { bio } : {}),
  });
}

export function parseFriendRecommendation(content: string): FriendRecommendation | null {
  if (typeof content !== "string" || content.length > 2048 || !content.trim().startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    if (value.type !== FRIEND_RECOMMENDATION_TYPE
      || typeof value.pubkey !== "string"
      || !PUBKEY_HEX.test(value.pubkey)
      || Object.keys(value).some(key => !["type", "pubkey", "nickname", "bio"].includes(key))) return null;
    const nickname = validatedText(value.nickname, 100);
    const bio = validatedText(value.bio, 500);
    if (nickname === null || bio === null) return null;
    return {
      pubkey: value.pubkey.toLowerCase(),
      ...(nickname ? { nickname } : {}),
      ...(bio ? { bio } : {}),
    };
  } catch {
    return null;
  }
}
