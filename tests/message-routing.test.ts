import { describe, expect, it } from "vitest";
import {
  classifyPrivateMessage, isConversationMessage, isDirectMessageTags, isFeedPostTags,
  LEGACY_FEED_CUTOFF_SECONDS,
} from "@/nostr/messaging/messageRouting";

const before = LEGACY_FEED_CUTOFF_SECONDS - 1;
const after = LEGACY_FEED_CUTOFF_SECONDS + 1;

describe("NIP-17 Feed vs interoperable DM routing", () => {
  it("routes explicitly marked HaiNei posts to Feed before and after cutover", () => {
    for (const time of [before, after]) {
      const post = { protocol: "nip17", transportKind: 1059, createdAt: time, tags: [["t", "hainei-post"]] };
      expect(isFeedPostTags(post.tags)).toBe(true);
      expect(classifyPrivateMessage(post)).toBe("feed");
      expect(isConversationMessage(post)).toBe(false);
    }
  });
  it("keeps explicit HaiNei direct messages in DM", () => {
    for (const time of [before, after]) {
      const dm = { protocol: "nip17", transportKind: 1059, createdAt: time, tags: [["t", "hainei-dm"]] };
      expect(isDirectMessageTags(dm.tags)).toBe(true);
      expect(classifyPrivateMessage(dm)).toBe("direct");
    }
  });
  it("recognizes standard untagged NIP-17 chat from another client", () => {
    const standard = { protocol: "nip17", transportKind: 1059, createdAt: after, tags: [["p", "b".repeat(64)]], plaintext: "Hello" };
    expect(classifyPrivateMessage(standard)).toBe("direct");
    expect(isConversationMessage(standard)).toBe(true);
  });
  it("keeps old HaiNei untagged Feed history but not new untagged messages", () => {
    expect(classifyPrivateMessage({ created_at: before, tags: [], content: "old Feed" })).toBe("feed");
    expect(classifyPrivateMessage({ createdAt: LEGACY_FEED_CUTOFF_SECONDS, tags: [] })).toBe("direct");
  });
  it("keeps controls and conflicting types out of both timelines", () => {
    expect(classifyPrivateMessage({ createdAt: after, tags: [["t", "hainei-post"], ["t", "hainei-dm"]] })).toBe("unsupported");
    expect(classifyPrivateMessage({ protocol: "nip17", transportKind: 14, tags: [["t", "hainei-post"]] })).toBe("unsupported");
    for (const tags of [
      [["l", "hainei-friendship"]],
      [["l", "hainei-interaction"]],
      [["t", "hainei-profile"]],
      [["t", "hainei-tombstone"]],
      [["t", "hainei-dm-receipt"]],
      [["t", "hainei-dm-burn"]],
    ]) expect(classifyPrivateMessage({ createdAt: after, tags })).toBe("control");
    expect(classifyPrivateMessage({ createdAt: after, tags: [], content: JSON.stringify({
      type: "hainei-dm-receipt", status: "read", upTo: { createdAt: 1, messageId: "b".repeat(64) },
    }) })).toBe("control");
  });
});
