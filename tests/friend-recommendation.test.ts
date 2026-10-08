import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { parseFriendRecommendation, serializeFriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { isFeedRenderableMessage } from "@/nostr/messaging/messageViewModel";

const FRIEND = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("encrypted friend recommendation", () => {
  it("round trips a canonical pubkey without leaking private friend details", () => {
    const content = serializeFriendRecommendation(FRIEND.toUpperCase());
    expect(JSON.parse(content)).toEqual({ type: "hainei-friend-recommendation", pubkey: FRIEND });
    expect(parseFriendRecommendation(content)).toEqual({ pubkey: FRIEND });
    expect(content).not.toContain("name");
    expect(content).not.toContain("note");
    expect(directMessagePreview(content)).toBe("[好友推荐]");
  });

  it("does not mistake arbitrary text, forged objects or invalid keys for recommendations", () => {
    expect(parseFriendRecommendation("你好")).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: OTHER, note: "secret" }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: "abc" }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-dm-burn", pubkey: FRIEND }))).toBeNull();
    expect(parseFriendRecommendation("{" + "x".repeat(300))).toBeNull();
    expect(() => serializeFriendRecommendation("not-a-key")).toThrow();
  });

  it("remains a normal NIP-17 encrypted DM instead of a Home post", () => {
    const content = serializeFriendRecommendation(FRIEND);
    expect(isFeedRenderableMessage({ content, tags: [["t", "hainei-dm"]] })).toBe(false);
    expect(directMessagePreview(content)).not.toContain(FRIEND);
  });

  it("preserves composer drafts and renders an actionable card using existing friendship controls", () => {
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const directStore = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(chat).toContain('role="dialog" aria-modal="true" aria-label="推荐朋友"');
    expect(chat).toContain('class="recommended-friend-card"');
    expect(chat).toContain("serializeFriendRecommendation(pubkey)");
    expect(chat).toContain("preserveDraft: true");
    expect(chat).toContain("friendships.sendRequest(pubkey)");
    expect(chat).toContain("friendships.acceptRequest(pubkey)");
    expect(chat).toContain('friend.pubkey !== peerPubkey.value');
    expect(directStore).toContain("if (!options?.preserveDraft) void this.clearDraftThrough");
  });
});
