import type { CanonicalMessage } from "@/nostr/messaging/protocol";

export const HAI_NEI_TOMBSTONE_TYPE = "hainei-tombstone";
export const HAI_NEI_TOMBSTONE_TAGS = [["t", HAI_NEI_TOMBSTONE_TYPE]];

export function encodeTombstone(messageId: string) {
  return JSON.stringify({ type: HAI_NEI_TOMBSTONE_TYPE, version: 1, messageId });
}

export function decodeTombstone(message: CanonicalMessage) {
  if (!message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_TOMBSTONE_TYPE)) return null;
  try {
    const value = JSON.parse(message.plaintext || "");
    return value?.type === HAI_NEI_TOMBSTONE_TYPE && value.version === 1 && typeof value.messageId === "string"
      ? { messageId: value.messageId }
      : null;
  } catch {
    return null;
  }
}

export function isTombstoneMessage(message: CanonicalMessage) {
  return message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_TOMBSTONE_TYPE);
}

/**
 * A pinned post on the author's profile. The latest pin (by pinnedAt) from an
 * author wins; messageId null unpins. Only that author's own post is honoured.
 */
export const HAI_NEI_FEED_PIN_TYPE = "hainei-feed-pin";
export const HAI_NEI_FEED_PIN_TAGS = [["t", HAI_NEI_FEED_PIN_TYPE]];

export type FeedPin = { messageId: string | null; pinnedAt: number };

export function encodeFeedPin(pin: FeedPin) {
  return JSON.stringify({ type: HAI_NEI_FEED_PIN_TYPE, version: 1, messageId: pin.messageId, pinnedAt: pin.pinnedAt });
}

export function isFeedPinMessage(message: Pick<CanonicalMessage, "tags">) {
  return message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_FEED_PIN_TYPE);
}

export function decodeFeedPin(message: Pick<CanonicalMessage, "tags" | "plaintext">): FeedPin | null {
  if (!isFeedPinMessage(message)) return null;
  try {
    const value = JSON.parse(message.plaintext || "");
    const messageId = value?.messageId;
    if (value?.type !== HAI_NEI_FEED_PIN_TYPE || value.version !== 1) return null;
    if (messageId !== null && (typeof messageId !== "string" || !/^[0-9a-f]{64}$/.test(messageId))) return null;
    if (!Number.isSafeInteger(value.pinnedAt) || value.pinnedAt <= 0) return null;
    return { messageId, pinnedAt: value.pinnedAt };
  } catch {
    return null;
  }
}
