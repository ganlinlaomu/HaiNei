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
 * 0.1.204 briefly sent "pinned on my profile" controls to friends. That
 * feature was replaced by personal Home pins; the tag stays recognised so
 * those messages are consumed as controls and never shown as posts.
 */
export const HAI_NEI_FEED_PIN_TYPE = "hainei-feed-pin";

export function isFeedPinMessage(message: Pick<CanonicalMessage, "tags">) {
  return message.tags.some(tag => tag[0] === "t" && tag[1] === HAI_NEI_FEED_PIN_TYPE);
}
