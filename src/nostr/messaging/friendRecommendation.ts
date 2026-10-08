/** A friend recommendation travels inside a regular encrypted NIP-17 DM. */
export const FRIEND_RECOMMENDATION_TYPE = "hainei-friend-recommendation";

export type FriendRecommendation = { pubkey: string };
const PUBKEY_HEX = /^[0-9a-f]{64}$/i;

export function serializeFriendRecommendation(pubkey: string): string {
  const normalized = pubkey.trim().toLowerCase();
  if (!PUBKEY_HEX.test(normalized)) throw new Error("无效的好友公钥");
  // Do not transmit the sender's local remark, grouping or private profile.
  return JSON.stringify({ type: FRIEND_RECOMMENDATION_TYPE, pubkey: normalized });
}

export function parseFriendRecommendation(content: string): FriendRecommendation | null {
  if (typeof content !== "string" || content.length > 256 || !content.trim().startsWith("{")) return null;
  try {
    const data: unknown = JSON.parse(content);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data as Record<string, unknown>;
    if (value.type !== FRIEND_RECOMMENDATION_TYPE
      || typeof value.pubkey !== "string"
      || !PUBKEY_HEX.test(value.pubkey)
      || Object.keys(value).some(key => key !== "type" && key !== "pubkey")) return null;
    return { pubkey: value.pubkey.toLowerCase() };
  } catch {
    return null;
  }
}
