import { DM_RECEIPT_TYPE, isDmReceiptPayload } from "./dmReceipts";
import { DM_BURN_CONTROL_TYPE, isBurnControlPayload } from "./dmBurnControl";

// Until 2026-10-10 18:30 JST, an unmarked NIP-17 rumor was a HaiNei Feed
// post. Afterwards, newly authored posts have an explicit encrypted tag.
// Old tagless posts and third-party DMs cannot be distinguished cryptographically.
export const FEED_POST_TYPE = "hainei-post";
export const DIRECT_MESSAGE_TYPE = "hainei-dm";
export const LEGACY_FEED_CUTOFF_SECONDS = 1791624600;

export type RoutableMessage = {
  tags?: string[][];
  content?: string;
  plaintext?: string;
  created_at?: number;
  createdAt?: number;
  protocol?: string;
  transportKind?: number;
};

export function hasMessageType(tags: string[][] | undefined, type: string) {
  return !!tags?.some(tag => tag[0] === "t" && tag[1] === type);
}

export function isDirectMessageTags(tags: string[][] | undefined) {
  return hasMessageType(tags, DIRECT_MESSAGE_TYPE);
}

export function isFeedPostTags(tags: string[][] | undefined) {
  return hasMessageType(tags, FEED_POST_TYPE);
}

export function isHomeControl(tags: string[][] | undefined, content?: string) {
  const values = new Set((tags || []).map(tag => `${tag[0]}:${tag[1]}`));
  return values.has("l:hainei-friendship")
    || values.has("l:hainei-interaction")
    || values.has("t:hainei-profile")
    || values.has("t:hainei-profile-request")
    || values.has("t:hainei-tombstone")
    || values.has(`t:${DM_RECEIPT_TYPE}`)
    || values.has(`t:${DM_BURN_CONTROL_TYPE}`)
    || isDmReceiptPayload(content)
    || isBurnControlPayload(content);
}

export type MessageRoute = "feed" | "direct" | "control" | "unsupported";

export function classifyPrivateMessage(message: RoutableMessage): MessageRoute {
  if (message.protocol !== undefined && message.protocol !== "nip17") return "unsupported";
  if (message.transportKind !== undefined && message.transportKind !== 1059) return "unsupported";
  if (isHomeControl(message.tags, message.plaintext ?? message.content)) return "control";
  const feed = isFeedPostTags(message.tags);
  const direct = isDirectMessageTags(message.tags);
  if (feed && direct) return "unsupported";
  if (feed) return "feed";
  if (direct) return "direct";
  const createdAt = message.createdAt ?? message.created_at;
  return typeof createdAt === "number" && Number.isFinite(createdAt)
    && createdAt > 0 && createdAt < LEGACY_FEED_CUTOFF_SECONDS
    ? "feed" : "direct";
}

export function isConversationMessage(message: RoutableMessage) {
  return classifyPrivateMessage(message) === "direct";
}
