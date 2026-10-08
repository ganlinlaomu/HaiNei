import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { parseFriendRecommendation, serializeFriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { isFeedRenderableMessage } from "@/nostr/messaging/messageViewModel";

const FRIEND = "b".repeat(64);
const OTHER = "c".repeat(64);

describe("encrypted friend recommendation", () => {
  it("round trips an owner-authored nickname and bio without sharing local-only fields", () => {
    const content = serializeFriendRecommendation(FRIEND.toUpperCase(), {
      nickname: " 海内朋友 ",
      bio: "  喜欢咖啡和旅行  ",
    });
    expect(JSON.parse(content)).toEqual({
      type: "hainei-friend-recommendation", pubkey: FRIEND,
      nickname: "海内朋友", bio: "喜欢咖啡和旅行",
    });
    expect(parseFriendRecommendation(content)).toEqual({
      pubkey: FRIEND, nickname: "海内朋友", bio: "喜欢咖啡和旅行",
    });
    expect(JSON.parse(content)).not.toHaveProperty("note");
    expect(JSON.parse(content)).not.toHaveProperty("groups");
    expect(JSON.parse(content)).not.toHaveProperty("avatar");
    expect(directMessagePreview(content)).toBe("[好友推荐]");
  });

  it("keeps older pubkey-only cards readable", () => {
    const content = serializeFriendRecommendation(FRIEND);
    expect(JSON.parse(content)).toEqual({ type: "hainei-friend-recommendation", pubkey: FRIEND });
    expect(parseFriendRecommendation(content)).toEqual({ pubkey: FRIEND });
  });

  it("rejects arbitrary text, forged extra fields, invalid lengths and non-string snapshots", () => {
    expect(parseFriendRecommendation("你好")).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: OTHER, note: "secret" }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: OTHER, groups: ["private"] }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: FRIEND, nickname: 123 }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: FRIEND, bio: "x".repeat(501) }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-friend-recommendation", pubkey: "abc" }))).toBeNull();
    expect(parseFriendRecommendation(JSON.stringify({ type: "hainei-dm-burn", pubkey: FRIEND }))).toBeNull();
    expect(parseFriendRecommendation("{" + "x".repeat(2100))).toBeNull();
    expect(() => serializeFriendRecommendation("not-a-key")).toThrow();
    expect(() => serializeFriendRecommendation(FRIEND, { nickname: "x".repeat(101) })).toThrow();
    expect(() => serializeFriendRecommendation(FRIEND, { bio: "x".repeat(501) })).toThrow();
  });

  it("remains a NIP-17 encrypted DM and doesn't leak the profile in Home or inbox previews", () => {
    const content = serializeFriendRecommendation(FRIEND, { nickname: "测试昵称", bio: "测试简介" });
    expect(isFeedRenderableMessage({ content, tags: [["t", "hainei-dm"]] })).toBe(false);
    expect(directMessagePreview(content)).toBe("[好友推荐]");
    expect(directMessagePreview(content)).not.toContain("测试");
    expect(directMessagePreview(content)).not.toContain(FRIEND);
  });

  it("requires an explicit preview, uses author-authored profile fields, and preserves drafts", () => {
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const directStore = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(chat).toContain('role="dialog" aria-modal="true" aria-label="推荐朋友"');
    expect(chat).toContain('class="recommended-friend-card"');
    expect(chat).toContain("serializeFriendRecommendation(card.pubkey, card)");
    expect(chat).toContain("selectedRecommendation.value =");
    expect(chat).toContain("selectedRecommendation.nickname");
    expect(chat).toContain("selectedRecommendation.bio");
    expect(chat).toContain("profile?.nickname?.trim()");
    expect(chat).toContain("profile?.bio?.trim()");
    expect(chat).toContain("对方即使还不是他的好友，也能看到这些资料");
    expect(chat).toContain("preserveDraft: true");
    expect(chat).toContain("friendships.sendRequest(pubkey)");
    expect(chat).toContain("friendships.acceptRequest(pubkey)");
    expect(chat).toContain("friend.pubkey !== peerPubkey.value");
    expect(directStore).toContain("if (!options?.preserveDraft) void this.clearDraftThrough");
  });
});
