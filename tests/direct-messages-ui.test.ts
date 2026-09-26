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
  it("has exactly the required four icon-only bottom tabs and keeps friends under My", () => {
    const source = readFileSync(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    const labels = [...source.matchAll(/<router-link class="nav-item"[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);
    expect(labels).toEqual(["首页", "私信", "通知", "我的"]);
    expect(source).toContain('to="/conversations"');
    expect(source).not.toContain('to="/friends"');
    expect(source).not.toContain('class="nav-label"');
    expect(source).toContain('to="/settings"');
    const settings = readFileSync(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    expect(settings).toContain("router.push('/friends')");
  });

  it("uses My as a navigation hub with dedicated settings and consistent back navigation", () => {
    const settings = readFileSync(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    const system = readFileSync(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    const friends = readFileSync(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    const profile = readFileSync(join(process.cwd(), "src/views/MyProfile.vue"), "utf8");
    const saved = readFileSync(join(process.cwd(), "src/views/Saved.vue"), "utf8");
    const router = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(settings).toContain("router.push('/settings/system')");
    expect(settings).not.toContain('class="technical-section"');
    expect(system).toContain("连接 / Relay");
    expect(system).toContain("图片与视频 / Media");
    expect(system).toContain("数据使用 / Data Saver");
    expect(system).toContain("后台推送 / Web Push");
    expect(system).toContain("存储 / Cache");
    expect(system).toContain("高级设置 / Diagnostics");
    expect(system).toContain("router.push('/settings')");
    expect(friends).toContain("好友 / 好友分组</h1>");
    expect(friends).toContain("router.push('/settings')");
    expect(profile).toContain("router.push('/settings')");
    expect(saved).toContain("router.push('/settings')");
    expect(router).toContain('path: "/settings/system"');
  });

  it("uses the existing composer behind a route-aware floating button", () => {
    const app = readFileSync(join(process.cwd(), "src/App.vue"), "utf8");
    expect(app.match(/class="compose-fab"/g)).toHaveLength(1);
    expect(app).toContain("ui.openPostEditor()");
    expect(app).toContain('route.name === "Conversations"');
    expect(app).toContain("ui.openNewConversation()");
    expect(app).toContain('key="message"');
    expect(app).toContain('key="compose"');
    expect(app).toContain("transition: opacity 240ms cubic-bezier(.2,.75,.25,1), transform 240ms cubic-bezier(.2,.75,.25,1)");
    expect(app).toContain(".fab-to-message-enter-from { opacity: 0; transform: scale(.72) rotate(90deg); }");
    expect(app).toContain(".fab-to-message-leave-to { opacity: 0; transform: scale(.72) rotate(-90deg); }");
    expect(app).toContain(".fab-to-compose-enter-from { opacity: 0; transform: scale(.72) rotate(-90deg); }");
    expect(app).toContain(".fab-to-compose-leave-to { opacity: 0; transform: scale(.72) rotate(90deg); }");
    expect(app).not.toContain('mode="out-in"');
    expect(app).toContain("PostEditorModal");
    expect(app).toContain("ui.blockingOverlays.size === 0");
    expect(app).not.toContain("new PostEditor");
    const router = readFileSync(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(router).toContain('path: "/messages/:pubkey"');
    expect(router).toContain("hideBottomNav: true");
    const navigation = readFileSync(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    expect(navigation).toContain('<nav v-if="shouldShowBottomNav" class="bottom-nav" aria-label="主导航">');
    expect(navigation).not.toContain('<nav v-show="shouldShowBottomNav"');
  });

  it("keeps mobile conversation and profile page roots full width", () => {
    for (const file of ["Conversations.vue", "Messages.vue", "MyProfile.vue", "Profile.vue"]) {
      const source = readFileSync(join(process.cwd(), `src/views/${file}`), "utf8");
      expect(source, file).toContain("width:100%");
      expect(source, file).toContain("margin:0");
      expect(source, file).toContain("box-sizing:border-box");
    }
  });

  it("provides X-style conversation search and the required empty state", () => {
    const source = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(source).toContain("私信</h1>");
    expect(source).toContain("全部");
    expect(source).toContain('type="search"');
    expect(source).toContain("filteredConversations");
    expect(source).toContain("暂无私信");
    expect(source).toContain("开始一段新的私密对话。");
  });

  it("uses swipe actions instead of a more menu for conversation hide/delete", () => {
    const source = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(source).toContain('@touchstart="onTouchStart($event, conversation.peerPubkey)"');
    expect(source).toContain('class="swipe-actions"');
    expect(source).toContain('class="action hide"');
    expect(source).toContain('class="action delete"');
    expect(source).toContain("directMessages.hideConversation(pubkey)");
    expect(source).toContain("directMessages.deleteConversation(pubkey)");
    expect(source).toContain('useSwipeActions } from "@/composables/useSwipeActions"');
    expect(source).toContain("touch-action:pan-y");
    expect(source).not.toContain('class="more-button"');
    expect(source).not.toContain('class="conversation-menu"');
    expect(source).not.toContain("toggleMenu(");
  });

  it("shares swipe gesture handling with notifications", () => {
    const swipe = readFileSync(join(process.cwd(), "src/composables/useSwipeActions.ts"), "utf8");
    const notifications = readFileSync(join(process.cwd(), "src/views/Notifications.vue"), "utf8");
    expect(swipe).toContain("export function useSwipeActions");
    expect(swipe).toContain("Math.abs(dy) > Math.abs(dx)");
    expect(swipe).toContain("event.preventDefault()");
    expect(swipe).toContain("closeOthers(id)");
    expect(notifications).toContain('useSwipeActions } from "@/composables/useSwipeActions"');
    expect(notifications).toContain("touch-action: pan-y");
    expect(notifications).not.toContain("reactive<Record<string, number>>");
  });

  it("keeps UX consistency across friends, Home, and conversation empty states", () => {
    const friends = readFileSync(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const conversations = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(friends).toContain('useSwipeActions } from "@/composables/useSwipeActions"');
    expect(friends).toContain('class="friend-swipe-actions"');
    expect(friends).toContain(">添加好友</button>");
    expect(friends).not.toContain('class="more-button"');
    expect(home).toContain("条新动态");
    expect(home).toContain("这里还没有动态");
    expect(home).toContain("router.push('/friends')");
    expect(conversations).toContain("ui.openNewConversation()");
    expect(conversations).toContain(">发起私信</button>");
  });

  it("surfaces key action failures through the shared toast store", () => {
    const home = readFileSync(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const messages = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readFileSync(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(home).toContain('ui.addToast("评论发送失败，请稍后重试"');
    expect(home).toContain('ui.addToast("操作失败，请稍后重试"');
    expect(messages).toContain("ui.addToast(");
    expect(conversations).toContain('ui.addToast("隐藏失败，请稍后重试"');
    expect(conversations).toContain('ui.addToast("删除失败，请稍后重试"');
  });

  it("lists only accepted non-self friends in the new-conversation sheet", () => {
    const source = readFileSync(join(process.cwd(), "src/components/NewConversationSheet.vue"), "utf8");
    expect(source).toContain('record.state === "accepted"');
    expect(source).toContain("record.peerPubkey !== keys.pkHex");
    expect(source).toContain("friend.note");
    expect(source).toContain('emit("select", pubkey)');
    expect(source).not.toContain("sendDirectMessage");
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
    expect(store).toContain('pushCategory: "message"');
    expect(store).not.toContain("nostrClient.publish");
    expect(service).toContain("outgoingQueueRepository.putIfAbsent");
    expect(chat).toContain('class="chat-composer"');
    expect(chat).not.toContain("sending = ref(");
    expect(chat).not.toContain(':disabled="!accepted || sending"');
    expect(chat).toContain(':disabled="!accepted || !keys.pkHex ||');
    expect(chat).toContain('const messages = computed(() => directMessages.peerMessages(peerPubkey.value))');
    expect(chat).toContain("'输入消息……'");
    expect(chat).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>');
    expect(chat).not.toContain('@click="router.back()">‹</button>');
    expect(store).toContain("uploadEncryptedCommentImage");
    expect(chat).toContain("PostImagePreview");
    expect(conversations).toContain("`/messages/${pubkey}`");
  });

  it("keeps the compact DM composer above the safe-area bottom", () => {
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain("calc(28px + env(safe-area-inset-bottom))");
    expect(chat).toContain('class="composer-normal"');
    expect(chat).toContain('class="composer-recording"');
    expect(chat).toContain('class="composer-preview"');
    expect(chat).toContain('aria-label="发送"');
    expect(chat).toContain("width:calc(100% - 32px)");
    expect(chat).toContain("height:54px;min-height:54px");
    expect(chat).toContain("border-radius:28px");
    expect(chat).toContain("border-radius:50%");
    expect(chat).toContain("box-shadow:0 4px 18px");
    expect(chat).toContain("width:min(100%,720px)");
  });

  it("uses per-message optimistic status without blocking the composer", () => {
    const chat = readFileSync(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain("上传中…");
    expect(chat).toContain("发送中…");
    expect(chat).toContain("✓ 已发送");
    expect(chat).not.toContain("✔️ 已发送");
    expect(chat).toContain("font-size:9px;font-weight:400");
    expect(chat).toContain("opacity:.85");
    expect(chat).toContain("上传失败 ·");
    expect(chat).toContain("发送失败 ·");
    expect(chat).toContain("directMessages.retry(message.outgoing.localId)");
    expect(chat).toContain('draft.value = ""');
    expect(chat).not.toContain("sendError");
    expect(chat).not.toContain("sending.value");
    const store = readFileSync(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(store).toContain('window.addEventListener("online", resume)');
    expect(store).toContain('window.addEventListener("pageshow", resume)');
    expect(store).toContain("resumePending(true)");
  });
});
