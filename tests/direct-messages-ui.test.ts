import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canStartDirectMessage,
  directMessagePeer,
  directMessagePreview,
  isDirectMessageTags,
} from "@/nostr/messaging/directMessages";
import { buildDirectConversationSummaries, directMessagesForPeer } from "@/stores/directMessages";
import type { InboxItem } from "@/stores/messages";

const ACCOUNT = "a".repeat(64);
const FRIEND = "b".repeat(64);
const OTHER = "c".repeat(64);

function dm(id: string, pubkey: string, recipientPubkeys: string[], created_at: number, content = "你好"): InboxItem {
  return {
    id,
    pubkey,
    recipientPubkeys,
    created_at,
    content,
    conversationId: `conversation:${pubkey === ACCOUNT ? recipientPubkeys[0] : pubkey}`,
    protocol: "nip17",
    transportKind: 1059,
    tags: [["t", "hainei-dm"]],
  };
}

describe("direct-message navigation and UI contract", () => {
  it("has exactly the required five bottom tabs and no compose tab", () => {
    const source = readFileSync(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    const labels = [...source.matchAll(/<span class="nav-label">([^<]+)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(["首页", "好友", "私信", "通知", "我的"]);
    expect(source).toContain('to="/conversations"');
    expect(source).not.toContain('<span class="nav-label">发帖</span>');
    expect(source).toContain('to="/settings"');
  });

  it("uses the existing composer behind a route-aware floating button", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    expect(app).toContain('class="compose-fab"');
    expect(app).toContain("ui.openPostEditor()");
    expect(app).toContain("PostEditorModal");
    expect(app).toContain("ui.blockingOverlays.size === 0");
    expect(app).not.toContain("new PostEditor");
    const router = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(router).toContain('path: "/messages/:pubkey"');
    expect(router).toContain("hideBottomNav: true");
    const navigation = readFileSync(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    expect(navigation).toContain('<nav v-if="shouldShowBottomNav" class="bottom-nav">');
    expect(navigation).not.toContain('<nav v-show="shouldShowBottomNav"');
  });

  it("allows only accepted, non-self peers to start private messages", () => {
    const accepted = (pubkey: string) => pubkey === FRIEND;
    expect(canStartDirectMessage(ACCOUNT, FRIEND, accepted)).toBe(true);
    expect(canStartDirectMessage(ACCOUNT, ACCOUNT, accepted)).toBe(false);
    expect(canStartDirectMessage(ACCOUNT, OTHER, accepted)).toBe(false);
    expect(canStartDirectMessage(ACCOUNT, FRIEND, () => false)).toBe(false);
  });

  it("builds latest-first conversations and routes messages by peer", () => {
    const first = dm("first", FRIEND, [ACCOUNT], 10);
    const latest = dm("latest", ACCOUNT, [FRIEND], 30, "![](blossom+aesgcm:encrypted)");
    const other = dm("other", OTHER, [ACCOUNT], 20);
    const summaries = buildDirectConversationSummaries([first, latest, other], ACCOUNT, { [latest.conversationId!]: 2 });
    expect(summaries.map(item => item.peerPubkey)).toEqual([FRIEND, OTHER]);
    expect(summaries[0]).toMatchObject({ latest, unread: 2 });
    expect(directMessagesForPeer([other, latest, first], ACCOUNT, FRIEND).map(item => item.id)).toEqual(["first", "latest"]);
    expect(directMessagePeer({ senderPubkey: ACCOUNT, recipientPubkeys: [FRIEND] }, ACCOUNT)).toBe(FRIEND);
    expect(directMessagePreview(latest.content)).toBe("[图片]");
    expect(isDirectMessageTags(first.tags)).toBe(true);
  });

  it("keeps DM unread and activity unread as separate navigation badges", () => {
    const source = readFileSync(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    expect(source).toContain("directMessages.unreadCount");
    expect(source).toContain("notifications.unreadCount");
    expect(source).not.toContain("notifications.unreadCount + directMessages.unreadCount");
  });

  it("reuses NIP-17 send, durable queue, and encrypted image components", () => {
    const store = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const service = readFileSync(join(process.cwd(), "src/nostr/messaging/service.ts"), "utf8");
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(store).toContain("sendDirectMessage({");
    expect(store).not.toContain("nostrClient.publish");
    expect(service).toContain("outgoingQueueRepository.putIfAbsent");
    expect(chat).toContain('class="chat-composer"');
    expect(chat).toContain("'输入消息……'");
    expect(chat).toContain("uploadEncryptedCommentImage");
    expect(chat).toContain("PostImagePreview");
    expect(conversations).toContain("`/messages/${pubkey}`");
  });
});
