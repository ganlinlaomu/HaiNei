import { describe, expect, it } from "vitest";
import type { SyncedMessageRecord } from "@/db/dexie";
import { DM_RECEIPT_TYPE } from "@/nostr/messaging/dmReceipts";
import { DM_BURN_CONTROL_TYPE, isBurnControlPayload, parseBurnControl, serializeBurnControl } from "@/nostr/messaging/dmBurnControl";
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

  it("excludes tagged burn notices and previously stored untagged burn JSON from Home/Profile", () => {
    const payload = serializeBurnControl("d833991ad5b314c30fd6038e1ce0da43958ddba6fb59e35ff319678e21aa0e47");
    const tag = [["t", DM_BURN_CONTROL_TYPE]];
    expect(isHomeControl(tag, payload)).toBe(true);
    expect(isFeedRenderableMessage({ tags: tag, content: payload })).toBe(false);
    expect(isHomeControl([], payload)).toBe(true);
    expect(isFeedRenderableMessage({ tags: [], content: payload })).toBe(false);
    // Old IndexedDB records with lost tags must not reappear when converted for Home history.
    const restored = syncedMessageRecordToInboxItem(record({ tags: [], plaintext: payload }));
    expect(isFeedRenderableMessage(restored)).toBe(false);
  });

  it("does not hide ordinary messages or treat untagged JSON as deletion commands", () => {
    const id = "d833991ad5b314c30fd6038e1ce0da43958ddba6fb59e35ff319678e21aa0e47";
    const valid = serializeBurnControl(id);
    expect(isBurnControlPayload(valid)).toBe(true);
    expect(parseBurnControl({ tags: [], plaintext: valid })).toBeNull();
    expect(parseBurnControl({ tags: [["t", DM_BURN_CONTROL_TYPE]], plaintext: valid })).toBe(id);
    const unrelated = JSON.stringify({ type: "user-note", messageId: id });
    const malformed = JSON.stringify({ type: DM_BURN_CONTROL_TYPE, messageId: "not-an-event-id" });
    for (const content of [unrelated, malformed, '{"type":"hainei-dm-burn"', "regular post"]) {
      expect(isBurnControlPayload(content)).toBe(false);
      expect(isFeedRenderableMessage({ tags: [], content })).toBe(true);
    }
    // A missing/invalid payload with a burn-control tag remains a control, never a post.
    expect(isFeedRenderableMessage({ tags: [["t", DM_BURN_CONTROL_TYPE]], content: malformed })).toBe(false);
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
