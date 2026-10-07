import { describe, expect, it } from "vitest";
import type { SyncedMessageRecord } from "@/db/dexie";
import { DM_RECEIPT_TYPE } from "@/nostr/messaging/dmReceipts";
import {
  isFeedRenderableMessage,
  isHomeControl,
  syncedMessageRecordToInboxItem,
} from "@/nostr/messaging/messageViewModel";

function record(patch: Partial<SyncedMessageRecord> = {}): SyncedMessageRecord {
  return {
    accountPubkey: "a".repeat(64),
    id: "message-1",
    senderPubkey: "b".repeat(64),
    recipientPubkeys: ["a".repeat(64)],
    conversationId: "conversation-1",
    messageClass: "other",
    plaintext: "hello",
    createdAt: 123,
    protocol: "nip17",
    transportKind: 1059,
    transportEventIds: ["wrap-1", "wrap-2"],
    rumorId: "rumor-1",
    replyTo: "reply-1",
    rootId: "root-1",
    tags: [["p", "a".repeat(64)]],
    firstSeenAt: 1,
    lastSeenAt: 2,
    ...patch,
  };
}

describe("message view model", () => {
  it("maps durable records to one canonical InboxItem shape", () => {
    expect(syncedMessageRecordToInboxItem(record())).toEqual({
      id: "message-1",
      pubkey: "b".repeat(64),
      created_at: 123,
      content: "hello",
      protocol: "nip17",
      transportKind: 1059,
      transportEventId: "wrap-1",
      rumorId: "rumor-1",
      recipientPubkeys: ["a".repeat(64)],
      conversationId: "conversation-1",
      replyTo: "reply-1",
      rootId: "root-1",
      tags: [["p", "a".repeat(64)]],
    });
  });

  it("normalizes missing optional record fields without page-specific fallbacks", () => {
    const item = syncedMessageRecordToInboxItem(record({
      plaintext: undefined,
      transportEventIds: [],
      rumorId: undefined,
      replyTo: undefined,
      rootId: undefined,
      tags: undefined,
    }));
    expect(item.content).toBe("");
    expect(item.transportEventId).toBeUndefined();
    expect(item.tags).toEqual([]);
  });

  it("uses one feed predicate for normal posts, DMs, controls and receipts", () => {
    expect(isFeedRenderableMessage({ content: "post", tags: [] })).toBe(true);
    expect(isFeedRenderableMessage({ content: "dm", tags: [["t", "hainei-dm"]] })).toBe(false);
    expect(isFeedRenderableMessage({ content: "profile", tags: [["t", "hainei-profile"]] })).toBe(false);
    expect(isFeedRenderableMessage({ content: "receipt", tags: [["t", DM_RECEIPT_TYPE]] })).toBe(false);
    expect(isHomeControl([["l", "hainei-friendship"]], "")).toBe(true);
    expect(isHomeControl([["l", "hainei-interaction"]], "")).toBe(true);
    expect(isHomeControl([["t", "hainei-tombstone"]], "")).toBe(true);
  });
});
