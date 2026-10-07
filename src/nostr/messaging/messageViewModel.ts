import type { SyncedMessageRecord } from "@/db/dexie";
import { DM_RECEIPT_TYPE, isDmReceiptMessage, isDmReceiptPayload } from "@/nostr/messaging/dmReceipts";
import { isDirectMessageTags } from "@/nostr/messaging/directMessages";

export type InboxItem = {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  protocol?: "nip17";
  transportKind?: number;
  transportEventId?: string;
  rumorId?: string;
  recipientPubkeys?: string[];
  conversationId?: string;
  replyTo?: string;
  rootId?: string;
  tags?: string[][];
  outgoing?: {
    localId: string;
    state: "uploading" | "sending" | "sent" | "upload_failed" | "send_failed";
    imagePreviewUrl?: string;
    audioPreviewUrl?: string;
    audioMime?: string;
    audioDuration?: number;
    audioSize?: number;
    hasImage: boolean;
    hasAudio?: boolean;
    lastError?: string;
  };
  _localMeta?: {
    groupCount: number;
    groups: Array<{ name: string; count: number }>;
  };
};

export function syncedMessageRecordToInboxItem(record: SyncedMessageRecord): InboxItem {
  return {
    id: record.id,
    pubkey: record.senderPubkey,
    created_at: record.createdAt,
    content: record.plaintext || "",
    protocol: "nip17",
    transportKind: record.transportKind,
    transportEventId: record.transportEventIds[0],
    rumorId: record.rumorId,
    recipientPubkeys: record.recipientPubkeys,
    conversationId: record.conversationId,
    replyTo: record.replyTo,
    rootId: record.rootId,
    tags: record.tags || [],
  };
}

export function isHomeControl(tags: string[][] | undefined, content?: string) {
  const values = new Set((tags || []).map(tag => `${tag[0]}:${tag[1]}`));
  return values.has("l:hainei-friendship")
    || values.has("l:hainei-interaction")
    || values.has("t:hainei-profile")
    || values.has("t:hainei-profile-request")
    || values.has("t:hainei-tombstone")
    || values.has(`t:${DM_RECEIPT_TYPE}`)
    || isDmReceiptPayload(content);
}

export function isFeedRenderableMessage(message: Pick<InboxItem, "tags" | "content">) {
  return !isHomeControl(message.tags, message.content)
    && !isDirectMessageTags(message.tags)
    && !isDmReceiptMessage({ tags: message.tags })
    && !isDmReceiptPayload(message.content);
}
