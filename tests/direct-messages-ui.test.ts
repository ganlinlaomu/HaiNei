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
import { readThemedSource } from "./helpers/themedSource";

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
  it("exposes five labeled communication tabs, with notifications on Home", () => {
    const source = readThemedSource(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    const labels = [...source.matchAll(/<router-link class="nav-item"[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);
    expect(labels).toEqual(["动态", "私信", "通话", "通讯录", "我的"]);
    for (const path of ["/conversations", "/calls", "/friends", "/settings"]) {
      expect(source).toContain(`to="${path}"`);
    }
    expect(source).toContain('class="nav-label"');
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    expect(home).toContain('aria-label="查看通知"');
    expect(home).toContain("notifications.unreadCount");
    const settings = readThemedSource(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    expect(settings).not.toContain('router.push("/friends")');
    expect(settings).not.toContain("好友 / 好友分组");
  });

  it("shows profile save progress and prevents duplicate submissions", () => {
    const profile = readThemedSource(join(process.cwd(), "src/views/MyProfile.vue"), "utf8");
    expect(profile).toContain('const saving = ref(false)');
    expect(profile).toContain(':disabled="saving"');
    expect(profile).toContain('saving ? "保存中…" : "保存"');
    expect(profile).toContain('if (!account || saving.value) return');
    expect(profile).toContain("saving.value = true");
    expect(profile).toContain("saving.value = false");
  });

  it("uses the shared secondary header on friend profiles while preserving history-back behavior", () => {
    const profile = readThemedSource(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const secondaryHeader = readThemedSource(join(process.cwd(), "src/components/SecondaryPageHeader.vue"), "utf8");
    expect(profile).toContain('<SecondaryPageHeader title="个人资料" back-label="返回上一页" back-mode="history" />');
    expect(profile).not.toContain('class="profile-topbar"');
    expect(profile).not.toContain('class="back-button"');
    expect(secondaryHeader).toContain('backMode?: "push" | "history"');
    expect(secondaryHeader).toContain('if (props.backMode === "history") router.back()');
  });

  it("keeps DM receipt controls out of Home and profile feeds", () => {
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const profile = readThemedSource(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const viewModel = readThemedSource(join(process.cwd(), "src/nostr/messaging/messageViewModel.ts"), "utf8");
    const routing = readThemedSource(join(process.cwd(), "src/nostr/messaging/messageRouting.ts"), "utf8");
    expect(home).toContain("const isHomeRenderable = isFeedRenderableMessage");
    expect(profile).toContain("isFeedRenderableMessage(message)");
    expect(routing).toContain('values.has(`t:${DM_RECEIPT_TYPE}`)');
    expect(routing).toContain("isDmReceiptPayload(content)");
    expect(viewModel).toContain("isDmReceiptMessage({ tags: message.tags || [] })");
  });

  it("uses one durable-record mapper across Home, Profile, inbox restore and DM history", () => {
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const profile = readThemedSource(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const messages = readThemedSource(join(process.cwd(), "src/stores/messages.ts"), "utf8");
    const directMessages = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const viewModel = readThemedSource(join(process.cwd(), "src/nostr/messaging/messageViewModel.ts"), "utf8");

    expect(viewModel).toContain("export function syncedMessageRecordToInboxItem");
    expect(messages).toContain(".map(syncedMessageRecordToInboxItem)");
    expect(home).toContain("records.map(syncedMessageRecordToInboxItem)");
    expect(profile).toContain("records.map(syncedMessageRecordToInboxItem)");
    expect(directMessages).toContain("records.map(syncedMessageRecordToInboxItem)");
    expect(home).not.toContain("function syncedRecordToInbox");
    expect(profile).not.toContain("historyRecordToInboxItem");
    expect(directMessages).not.toContain("function recordInboxItem");
  });

  it("shows a friend's non-DM posts on their profile", () => {
    const profile = readThemedSource(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const repository = readThemedSource(join(process.cwd(), "src/repositories/syncedMessageRepository.ts"), "utf8");
    expect(profile).toContain('class="profile-posts"');
    expect(profile).toContain('<PostCard v-for="post in ownerPosts"');
    expect(profile).toContain("syncedMessageRepository.listBySender(account, owner)");
    expect(profile).toContain("for (const message of historicalOwnerPosts.value)");
    expect(profile).toContain("for (const message of messages.inbox)");
    expect(profile).toContain("isFeedRenderableMessage(message)");
    expect(repository).toContain('where("[accountPubkey+senderPubkey]")');
    expect(profile).toContain("message.pubkey.toLowerCase() === ownerPubkey.value");
    expect(profile).toContain("records.map(syncedMessageRecordToInboxItem)");
    expect(profile).toContain("!feedPreferences.isHidden(message.id)");
    expect(profile).toContain("loadAccountStoresOnce(account, stores)");
    expect(profile).toContain("storesLoadedForAccount(account, stores)");
    expect(profile).toContain("暂无动态");
  });

  it("uses the same profile view for self and exposes editing only there", () => {
    const profile = readThemedSource(join(process.cwd(), "src/views/Profile.vue"), "utf8");
    const settings = readThemedSource(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    expect(profile).toContain("const isSelf = computed(() => ownerPubkey.value === keys.pkHex)");
    expect(profile).toContain('v-if="isSelf" class="message-button"');
    expect(profile).toContain("@click=\"router.push('/settings/profile')\">编辑资料</button>");
    expect(profile).not.toContain('router.replace("/settings/profile")');
    expect(settings).toContain('aria-label="查看我的个人资料"');
    expect(settings).toContain("void router.push(`/profile/${keyStore.pkHex}`)");
    expect(settings).toContain('@click="openOwnProfile"');
  });

  it("opens the peer profile from the DM header name/avatar and received-message avatar", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain('class="peer-profile avatar-profile-link"');
    expect(chat).toContain('class="peer-profile name-profile-link"');
    expect(chat).toContain('class="message-avatar-link"');
    expect(chat).toContain('@click="openPeerProfile"');
    expect(chat).toContain('openProfile(router, keys.pkHex, peerPubkey.value, event)');
  });

  it("shows the sender's temporary text until burn without revealing the receiver's unopened text", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const burned = chat.indexOf('v-if="isBurned(message)" class="burned-placeholder"');
    const sent = chat.indexOf('v-else-if="isOwn(message)" class="temporary-message"');
    const opened = chat.indexOf('v-else-if="canShowTemporaryText(message)" class="temporary-message"');
    const reveal = chat.indexOf('class="temporary-reveal"');
    expect(burned).toBeGreaterThan(0);
    expect(sent).toBeGreaterThan(burned);
    expect(opened).toBeGreaterThan(sent);
    expect(reveal).toBeGreaterThan(opened);

    const senderBranch = chat.slice(sent, opened);
    expect(senderBranch).toContain('v-if="messageText(message.content)" class="bubble-text"');
    expect(senderBranch).toContain(':text="messageText(message.content)"');
    expect(senderBranch).toContain('♨ 阅后即焚 · {{ burnDuration(message) }} 秒');
    expect(senderBranch).not.toContain("对方打开后");
    const recipientBranch = chat.slice(opened, reveal);
    expect(recipientBranch).toContain('v-else-if="canShowTemporaryText(message)"');
    expect(chat).toContain('@click.stop="revealDisappearing(message)"');
    expect(chat).toContain('临时消息已销毁');
    expect(chat).toContain('return !isOwn(message) && !isBurned(message)');
  });

  it("marks a disappearing message read only after an explicit reveal and an exact receipt", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(chat).toContain("void directMessages.acknowledgeOpenedDisappearing(peer, message, deadline)");
    expect(store).toContain("this.scheduleOpenedBurn(peer, id, deadline)");
    expect(chat).toContain('v-if="isBurned(message)" class="burned-placeholder"');
    expect(chat).toContain('return directMessages.outgoingReceiptStatus(peerPubkey.value, message) || "sent"');
    expect(chat).not.toContain('isDisappearing(message) && receipt === "read" ? "delivered" : receipt');
    expect(store).toContain("if (hasDisappearingMarker(message.tags)) {");
    expect(store).toContain('this.exactReadById[message.id.toLowerCase()] === peer');
    expect(store).toContain('return receiptStatusForMessage(message, state ? { ...state, read: undefined } : state)');
  });

  it("shows a compact timestamp for every direct-message type", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain('v-if="!isMediaCaption(message) || isDisappearing(message)" class="message-meta"');
    expect(chat).toContain('<time>{{ formatBubbleTime(message.created_at) }}</time>');
    expect(chat).toContain(".message-meta{display:flex");
    expect(chat).toContain("font-size:9px");
    expect(chat).toContain("font-variant-numeric:tabular-nums");
    expect(chat).not.toContain('class="message-status"');
  });

  it("keeps long quoted replies inside mobile bubbles and the composer", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    // Both sent bubbles and the active reply composer must be bounded,
    // including single uninterrupted URLs, emojis and long CJK previews.
    expect(chat).toContain("class=\"quoted-message\"");
    expect(chat).toContain("class=\"replying-preview\"");
    expect(chat).toMatch(/\.message-stack,\s*\.message-bubble\s*\{\s*min-width:\s*0;/);
    expect(chat).toMatch(/\.quoted-message\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;/);
    expect(chat).toMatch(/\.quoted-message span\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*white-space:\s*normal;/);
    expect(chat).toMatch(/\.media-caption-bubble\s*>\s*\.quoted-message\s*\{\s*width:\s*calc\(100% - 20px\)/);
    expect(chat).toMatch(/\.composer-region\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/);
    expect(chat).toMatch(/\.replying-preview\s*\{[^}]*max-width:\s*calc\(100% - 32px\);[^}]*overflow:\s*hidden;/);
    expect(chat).toMatch(/\.replying-copy span\s*\{[^}]*-webkit-line-clamp:\s*2;[^}]*white-space:\s*normal;/);
    // No change to the actual quoted message ID / send path.
    expect(chat).toContain('@click.stop="jumpToQuotedMessage(message.replyTo)"');
    expect(chat).toContain("const replyTo = replyingToMessage.value?.id;");
  });

  it("supports quoted replies in direct-message bubbles and composer", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const taskRepository = readThemedSource(join(process.cwd(), "src/repositories/outgoingDmTaskRepository.ts"), "utf8");

    expect(chat).not.toContain('class="message-reply-button"');
    expect(chat).toContain('class="quoted-message"');
    expect(chat).toContain('@click.stop="jumpToQuotedMessage(message.replyTo)"');
    expect(chat).toContain('class="replying-preview"');
    expect(chat).toContain("replyingToId");
    expect(chat).toContain('@touchstart="handleMessageTouchStart(message, $event)"');
    expect(chat).toContain('@touchmove="handleMessageTouchMove(message, $event)"');
    expect(chat).toContain("SWIPE_REPLY_THRESHOLD");
    expect(chat).toContain("LONG_PRESS_MS");
    expect(chat).toContain('class="message-action-menu" :class="{ dragging: actionMenuDragging }"');
    expect(chat).toContain('@touchmove.passive="onActionMenuTouchMove"');
    expect(chat).toContain("actionMenuPosition");
    expect(chat).toContain('querySelector<HTMLElement>(".message-bubble")');
    expect(chat).toContain("fitsBelow");
    expect(chat).toContain("position:fixed");
    expect(chat).toContain("@selectstart.prevent");
    expect(chat).toContain("@dragstart.prevent");
    expect(chat).toContain("-webkit-touch-callout:none");
    expect(chat).toContain("window.getSelection?.()?.removeAllRanges()");
    expect(chat).toContain('@touchstart="handleMessageTouchStart(message, $event)"');
    expect(chat).not.toContain('@touchstart.prevent="handleMessageTouchStart');
    expect(chat).toContain("replyFromActionMenu");
    expect(chat).toContain("copyFromActionMenu");
    expect(chat).toContain("isMediaGestureTarget");
    expect(chat).toContain(".post-image-preview, .optimistic-image, .voice-message");
    expect(chat).toContain('target.scrollIntoView({ behavior: "smooth", block: "center" })');
    expect(chat).toContain("'message-highlight': highlightedMessageId === message.id");
    expect(chat).toContain("directMessages.send(peerPubkey.value, text, image, replyTo, disappearingSeconds.value ?? undefined)");
    expect(chat).toContain("directMessages.sendAudio(peerPubkey.value, audio, replyTo)");
    expect(store).toContain("replyTo: task.replyTo");
    expect(store).toContain("replyTo === message.replyTo");
    expect(taskRepository).toContain("record.replyTo");
  });

  it("keeps My settings and the new primary contacts page consistent", () => {
    const settings = readThemedSource(join(process.cwd(), "src/views/Settings.vue"), "utf8");
    const system = readThemedSource(join(process.cwd(), "src/views/SystemSettings.vue"), "utf8");
    const friends = readThemedSource(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    const profile = readThemedSource(join(process.cwd(), "src/views/MyProfile.vue"), "utf8");
    const saved = readThemedSource(join(process.cwd(), "src/views/Saved.vue"), "utf8");
    const router = readThemedSource(join(process.cwd(), "src/router/index.ts"), "utf8");
    const secondaryHeader = readThemedSource(join(process.cwd(), "src/components/SecondaryPageHeader.vue"), "utf8");
    expect(settings).toContain("openSystemSettings");
    expect(settings).toContain('router.push("/settings/system")');
    expect(settings).toContain("loadSystemSettingsView");
    expect(settings).toContain('<section v-else class="settings-card">');
    expect(settings).toContain("background:#fff;color:#0f1419");
    expect(settings).toContain("border-top:1px solid #eff1f3;background:#fff");
    expect(settings).not.toContain('<section v-else class="card settings-card">');
    for (const source of [system, profile, saved]) {
      expect(source).toContain("SecondaryPageHeader");
    }
    expect(settings).toContain('aria-label="复制公钥"');
    expect(settings).toContain('aria-label="打开我的二维码"');
    expect(settings).toContain("navigator.clipboard.writeText(pubkeyToNpub(keyStore.pkHex))");
    expect(settings).toContain('ui.addToast("已复制 npub 公钥"');
    expect(settings).not.toContain('class="technical-section"');
    expect(settings).not.toContain("inspectRelays");
    expect(settings).not.toContain("getCacheStats");
    expect(settings).not.toContain("enablePushNotifications");
    expect(settings).not.toContain("startStatusPolling");
    expect(system).toContain("<h3>连接</h3>");
    expect(system).toContain("图片与视频 / Media");
    expect(system).toContain("数据使用 / Data Saver");
    expect(system).toContain('后台推送 / {{ isNativeApp ? "Android Push" : "Web Push" }}');
    expect(system).toContain("存储 / Cache");
    expect(system).toContain("高级设置 / Diagnostics");
    expect(system).toContain('<SecondaryPageHeader title="设置" back-label="返回我的" />');
    expect(friends).toContain('<header class="contacts-header primary-page-header">');
    expect(friends).toContain('<h1 class="primary-page-title">通讯录</h1>');
    expect(friends).toContain('filteredAcceptedFriends');
    expect(friends).toContain('components: { ProfileAvatar, QrScannerSheet }');
    expect(saved).toContain('<SecondaryPageHeader title="已收藏" back-label="返回我的" />');
    expect(saved).not.toContain("收藏会先保存在本机，并通过加密同步到其他设备");
    expect(saved).not.toContain("收藏仅保存在当前设备和账号中");
    expect(profile).toContain('<SecondaryPageHeader title="编辑资料" back-label="返回个人资料" back-mode="history" />');
    expect(friends).toMatch(/return \{[\s\S]*router,[\s\S]*acceptedFriends/);
    expect(secondaryHeader).toContain('backTo: "/settings"');
    expect(secondaryHeader).toContain('backLabel: "返回我的"');
    expect(secondaryHeader).not.toContain("variant?:");
    expect(secondaryHeader).not.toContain(".compact{");
    expect(secondaryHeader).toContain('<span class="back-glyph" aria-hidden="true">‹</span>');
    expect(secondaryHeader).not.toContain("<svg");
    expect(secondaryHeader).not.toContain("backdrop-filter");
    expect(secondaryHeader).toContain("grid-template-columns:44px 1fr 44px");
    expect(secondaryHeader).toContain("min-height:54px");
    expect(secondaryHeader).toContain("font-size:30px");
    expect(secondaryHeader).toContain("position:sticky;top:0");
    expect(profile).toContain(".profile-page{width:100%;margin:0 auto;box-sizing:border-box;padding:0 0 ");
    expect(saved).toContain(".saved-page{width:100%;margin:0 auto;padding:0 0 ");
    expect(profile).toContain(".profile-editor{padding:8px 16px 0}");
    expect(saved).toContain(".saved-list{display:grid;gap:12px;padding:0 10px}");
    expect(friends).not.toContain(".friends-header{");
    expect(friends).toContain('class="contacts-search primary-page-search"');
    expect(router).toContain('path: "/settings/system"');
  });

  it("guards friend relationship actions against duplicate taps and restores the default tab", () => {
    const friends = readThemedSource(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    expect(friends).toContain('relationshipBusy = reactive(new Set<string>())');
    expect(friends).toContain(':disabled="relationshipBusy.has(request.peerPubkey)"');
    expect(friends).toContain('if (relationshipBusy.has(pubkey)) return');
    expect(friends).toContain('else activeSection.value = "accepted"');
    expect(friends).toContain("await friends.upsertMetadata(hexKey");
    expect(friends).toContain("const ok = await friends.remove(friend.pubkey)");
  });

  it("keeps post audiences tied to live accepted-friend groups", () => {
    const editor = readThemedSource(join(process.cwd(), "src/components/PostEditorModal.vue"), "utf8");
    const friends = readThemedSource(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    expect(editor).toContain("audienceRecipients(");
    // The visibility label is derived from stored recipients, not memory-only metadata.
    expect(editor).not.toContain("_localMeta");
    expect(readThemedSource(join(process.cwd(), "src/components/PostCard.vue"), "utf8")).toContain("postAudienceSummary(props.message.recipientPubkeys");
    expect(editor).toContain("normalizeSelectedAudienceGroups(");
    expect(editor).toContain("watch(groups, availableGroups =>");
    expect(editor).toContain("const recipientsCount = computed(() => recipients.value.length + Number(botMentioned.value))");
    expect(editor).toContain("postAudienceFriends, uploads"); // Vue setup() must expose template values.
    expect(editor).toContain("postAudienceFriends.length === 0");
    expect(friends).toContain('record.state === "accepted" || record.state === "outgoing_pending"');
    expect(friends).toContain("friendGroupTags(friend)");
  });

  it("keeps Home post composer and uses a dedicated new-message action in private chats", () => {
    const app = readThemedSource(join(process.cwd(), "src/App.vue"), "utf8");
    expect(app.match(/class="compose-fab"/g)).toHaveLength(1);
    expect(app).toContain("ui.openPostEditor()");
    expect(app).toContain('route.name === "Conversations"');
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(conversations).toContain("ui.openNewConversation()");
    expect(conversations).toContain('aria-label="发起新私信"');
    expect(app).toContain('const primaryRoutes = new Set(["Home"])');
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
    const router = readThemedSource(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(router).toContain('path: "/messages/:pubkey"');
    expect(router).toContain("hideBottomNav: true");
    const navigation = readThemedSource(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    expect(navigation).toContain('<nav v-if="shouldShowBottomNav" class="bottom-nav" aria-label="主导航">');
    expect(navigation).not.toContain('<nav v-show="shouldShowBottomNav"');
  });

  it("keeps mobile conversation and profile page roots full width", () => {
    for (const file of ["Conversations.vue", "Messages.vue", "MyProfile.vue", "Profile.vue"]) {
      const source = readThemedSource(join(process.cwd(), `src/views/${file}`), "utf8");
      expect(source, file).toContain("width:100%");
      expect(source, file).toContain("margin:0");
      expect(source, file).toContain("box-sizing:border-box");
    }
  });

  it("provides X-style conversation search and the required empty state", () => {
    const source = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(source).toContain("私信</h1>");
    expect(source).toContain("全部");
    expect(source).toContain("未读");
    expect(source).toContain('@click="toggleFilter"');
    expect(source).toContain('filterMode = ref<"all" | "unread">("all")');
    expect(source).toContain('filterMode.value === "unread" && conversation.unread <= 0');
    expect(source).toContain("暂无未读私信");
    expect(source).toContain('type="search"');
    expect(source).toContain("filteredConversations");
    expect(source).toContain("friendByPubkey");
    expect(source).toContain("new Map(friends.list.map");
    expect(source).toContain("暂无私信");
    expect(source).toContain("开始一段新的私密对话。");
  });

  it("uses swipe actions instead of a more menu for conversation hide/delete", () => {
    const source = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
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
    const swipe = readThemedSource(join(process.cwd(), "src/composables/useSwipeActions.ts"), "utf8");
    const notifications = readThemedSource(join(process.cwd(), "src/views/Notifications.vue"), "utf8");
    expect(swipe).toContain("export function useSwipeActions");
    expect(swipe).toContain("Math.abs(dy) > Math.abs(dx)");
    expect(swipe).toContain("event.preventDefault()");
    expect(swipe).toContain("closeOthers(id)");
    expect(swipe).toContain("function onTouchCancel");
    expect(swipe).toContain("resetGesture()");
    expect(notifications).toContain('useSwipeActions } from "@/composables/useSwipeActions"');
    expect(notifications).toContain("touch-action: pan-y");
    expect(notifications).not.toContain("reactive<Record<string, number>>");
  });

  it("uses card feed surfaces for Home and flat full-width list surfaces for messaging", () => {
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const postCard = readThemedSource(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    const notifications = readThemedSource(join(process.cwd(), "src/views/Notifications.vue"), "utf8");
    expect(home).toContain("<PostCard");
    expect(postCard).toContain(".post-card{");
    expect(postCard).toContain("border-radius:14px");
    expect(conversations).toContain("background:#fff");
    expect(conversations).toContain(".conversation-list{display:flex;width:100%");
    expect(notifications).toContain("background: #fff");
    expect(notifications).toContain("padding: 0 0 calc(");
    expect(notifications).toContain("margin: 4px 16px 10px");
    expect(notifications).toContain("padding: 10px 16px");
    expect(notifications).toContain("<h1>通知</h1>");
    expect(notifications.match(/@touchcancel="onTouchCancel\(n\.id\)"/g)).toHaveLength(3);
  });

  it("keeps UX consistency across friends, Home, and conversation empty states", () => {
    const friends = readThemedSource(join(process.cwd(), "src/views/Friends.vue"), "utf8");
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(friends).toContain('useSwipeActions } from "@/composables/useSwipeActions"');
    expect(friends).toContain('class="friend-swipe-actions"');
    expect(friends).toContain("loadAccountStoresOnce(account, stores)");
    expect(friends).toContain("storesLoadedForAccount(account, stores)");
    expect(friends).toContain("正在加载好友…");
    expect(friends).toContain(">重新加载</button>");
    expect(friends).toContain("@touchcancel=");
    expect(friends).not.toContain(".btn-edit");
    expect(friends).not.toContain(".btn-delete");
    expect(friends).toContain(">添加好友</button>");
    expect(friends).not.toContain('class="more-button"');
    expect(home).toContain("条新动态");
    expect(home).toContain("还没有好友");
    expect(home).toContain("暂时没有新动态");
    expect(home).toContain("router.push('/friends')");
    expect(home).toContain("ui.openPostEditor()");
    expect(conversations).toContain("ui.openNewConversation()");
    expect(conversations).toContain(">发起私信</button>");
  });

  it("prioritizes near-viewport encrypted images and auto-loads Home pages with an unsupported-browser fallback", () => {
    const imagePreview = readThemedSource(join(process.cwd(), "src/components/PostImagePreview.vue"), "utf8");
    const priorityQueue = readThemedSource(join(process.cwd(), "src/utils/priorityTaskQueue.ts"), "utf8");
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    expect(imagePreview).toContain("IntersectionObserver");
    expect(imagePreview).toContain('rootMargin: "500px 0px"');
    expect(imagePreview).toContain("DecryptPriority");
    expect(priorityQueue).toContain("a.priority - b.priority");
    expect(home).toContain("syncedMessageRepository.listHistoryPage");
    expect(home).toContain("AUTO_LOAD_MORE_THRESHOLD");
    expect(home).toContain('addEventListener("scroll", handleHomeScroll');
    expect(home).toContain("distanceToBottom <= AUTO_LOAD_MORE_THRESHOLD");
    expect(home).toContain("loadMoreMessages()");
    expect(home).toContain('ref="loadMoreSentinel"');
    expect(home).toContain("IntersectionObserver");
    expect(home).toContain('rootMargin: "420px 0px"');
    expect(home).toContain('v-else-if="!autoLoadSupported" class="load-more-btn"');
    expect(home).toContain('loadMoreMessages({ notifyOnError: true })');
    expect(home).toContain('if (options.notifyOnError) ui.addToast("历史消息加载失败，请重试"');
    expect(home).toContain("|| !readyForPending.value");
    expect(home).toContain("|| homeAccountPk !== keys.pkHex");
    expect(home).toContain("if (!readyForPending.value || homeAccountPk !== keys.pkHex) return");
    expect(home).toContain("if (initialized) await nextTick(attachLoadMoreObserver)");
    expect(home).toContain('homeRelayState.value === "offline"');
    expect(home).toContain('if (homeRelayState.value === relay) return;');
    expect(home).toContain("}, 2000);");
    expect(home).toContain("已缓存内容仍可查看");
    expect(home).toContain("正在重新连接…");
    expect(home).not.toContain("setTimeout(() => {\n        const startIndex = displayedMessages.value.length");
  });

  it("hydrates device session before version checks and router auth restore", () => {
    const main = readThemedSource(join(process.cwd(), "src/main.ts"), "utf8");
    const worker = readThemedSource(join(process.cwd(), "public/service-worker.js"), "utf8");
    const migrationIndex = main.indexOf("await migrateLegacyLocalStorage()");
    const versionIndex = main.indexOf("const versionChanged = initVersionTracking()");
    const routerIndex = main.indexOf("app.use(router)");
    const mountIndex = main.indexOf('app.mount("#app")');
    expect(migrationIndex).toBeGreaterThan(-1);
    expect(versionIndex).toBeGreaterThan(migrationIndex);
    expect(routerIndex).toBeGreaterThan(versionIndex);
    expect(mountIndex).toBeGreaterThan(routerIndex);
    expect(worker).toContain("url.origin === self.location.origin");
    expect(worker).toContain("stale-while-revalidate");
    expect(worker).toContain("event.respondWith(fetch(request))");
  });

  it("uses revisions and a safe insert-only fast path for Home reconciliation", () => {
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const messages = readThemedSource(join(process.cwd(), "src/stores/messages.ts"), "utf8");
    const preferences = readThemedSource(join(process.cwd(), "src/stores/feedPreferences.ts"), "utf8");
    expect(home).toContain("lastReconciledSnapshot");
    expect(home).toContain("msgs.inboxRevision");
    expect(home).toContain("feedPreferences.revision");
    expect(home).toContain("canApplyInserts");
    expect(home).toContain("msgs.inboxMutationsSince(visibleInboxMessageRevision)");
    expect(home).toContain('mutation.type === "insert"');
    expect(home).toContain('mode: canApplyInserts ? "incremental" : "rebuild"');
    expect(home).toContain('refreshResult.mode === "incremental"');
    expect(home).toContain("rebuildVisibleInbox()");
    expect(home).not.toContain("[...feedPreferences.hiddenMessageIds].sort()");
    expect(messages).toContain('type: "replace" | "insert" | "update" | "reset"');
    expect(messages).toContain('this.recordInboxMutation("insert", item.id, evictedId, item)');
    expect(preferences).toContain("revision: 0");
  });

  it("surfaces key action failures in the owning component", () => {
    const postCard = readThemedSource(join(process.cwd(), "src/components/PostCard.vue"), "utf8");
    const commentSheet = readThemedSource(join(process.cwd(), "src/components/CommentSheet.vue"), "utf8");
    const messages = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(postCard).toContain('ui.addToast("操作失败，请重试"');
    expect(commentSheet).toContain('"发送失败，草稿已保留，可重试"');
    expect(messages).toContain("ui.addToast(");
    expect(conversations).toContain('ui.addToast("隐藏失败，请稍后重试"');
    expect(conversations).toContain('ui.addToast("删除失败，请稍后重试"');
  });

  it("lists only accepted non-self friends in the new-conversation sheet", () => {
    const source = readThemedSource(join(process.cwd(), "src/components/NewConversationSheet.vue"), "utf8");
    expect(source).toContain('record.state === "accepted"');
    expect(source).toContain("record.peerPubkey !== keys.pkHex");
    expect(source).toContain("friend.note");
    expect(source).toContain('emit("select", pubkey)');
    expect(source).not.toContain("sendDirectMessage");
  });

  it("shows loading, failure, and retry states while opening a new conversation", () => {
    const source = readThemedSource(join(process.cwd(), "src/components/NewConversationSheet.vue"), "utf8");
    expect(source).toContain("正在加载好友…");
    expect(source).toContain("好友加载失败");
    expect(source).toContain(">重新加载</button>");
    expect(source).toContain("const loadError = ref");
    expect(source).toContain('loadError.value = ""');
    expect(source).toContain("catch (error)");
    expect(source).toContain('@click="load"');
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

  it("keeps app-icon badge synchronization alive while the bottom navigation is hidden in a chat", () => {
    const app = readThemedSource(join(process.cwd(), "src/App.vue"), "utf8");
    const router = readThemedSource(join(process.cwd(), "src/router/index.ts"), "utf8");
    expect(app).toContain("syncAppBadge(");
    expect(app).toContain("directMessages.unreadCount");
    expect(router).toContain('path: "/messages/:pubkey"');
    expect(router).toContain("hideBottomNav: true");
  });

  it("keeps DM unread in the navigation and activity unread on Home", () => {
    const source = readThemedSource(join(process.cwd(), "src/components/HeaderBar.vue"), "utf8");
    expect(source).toContain("directMessages.unreadCount");
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    expect(home).toContain("notifications.unreadCount");
    expect(source).not.toContain("notifications.unreadCount + directMessages.unreadCount");
  });

  it("reuses NIP-17 send, durable queue, and encrypted image components", () => {
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const service = readThemedSource(join(process.cwd(), "src/nostr/messaging/service.ts"), "utf8");
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    expect(store).toContain("sendDirectMessage({");
    expect(store).toContain('pushCategory: "message"');
    expect(store).not.toContain("nostrClient.publish");
    expect(service).toContain("outgoingQueueRepository.putIfAbsent");
    expect(chat).toContain('class="chat-composer"');
    expect(chat).not.toContain("sending = ref(");
    expect(chat).not.toContain(':disabled="!accepted || sending"');
    expect(chat).toContain(':disabled="!accepted || !keys.pkHex ||');
    expect(chat).toContain("directMessages.mergePeerHistory(peer, historyMessages.value)");
    expect(chat).not.toContain("directMessages.peerMessages(peerPubkey.value)");
    expect(chat).toContain("'输入消息……'");
    expect(chat).toContain('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>');
    expect(chat).not.toContain('@click="router.back()">‹</button>');
    expect(store).toContain("uploadEncryptedCommentImage");
    expect(store).toContain("friendshipByPeer");
    expect(store).toContain("new Map(options.friendshipRecords.map");
    expect(chat).toContain("PostImagePreview");
    expect(conversations).toContain("`/messages/${pubkey}`");
  });

  it("opens cached conversations from indexed history without waiting for Relay or rescanning the whole inbox", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const lazyViews = readThemedSource(join(process.cwd(), "src/router/lazyViews.ts"), "utf8");

    expect(conversations).toContain("warmConversation(conversation.peerPubkey)");
    expect(conversations).toContain("directMessages.prefetchPeerHistory(pubkey)");
    expect(conversations).toContain("scheduleConversationWarmup()");
    expect(chat).toContain("await waitForFirstPaint()");
    expect(chat).toContain("await fetchOlderPage(true)");
    expect(chat).toContain("directMessages.mergePeerHistory(peer, historyMessages.value)");
    expect(chat).toContain("watch(() => messageStore.inboxRevision, applyLatestInboxMutation)");
    expect(chat).toContain("loadingConversation = false");
    expect(chat).toContain("void restoreDraft(account, peer)");
    expect(chat).toContain("void markVisibleMessagesRead()");
    expect(store).toContain("prefetchPeerHistory(peerPubkey: string)");
    expect(store).toContain("syncedMessageRepository.listConversationPage(account, conversation, undefined, 50)");
    expect(store).toContain("PEER_HISTORY_WARM_TTL_MS");
    expect(lazyViews).toContain("loadMessagesView,");
  });

  it("provides local in-chat search and per-peer durable drafts without Relay search", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const conversations = readThemedSource(join(process.cwd(), "src/views/Conversations.vue"), "utf8");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    const meta = readThemedSource(join(process.cwd(), "src/repositories/metaRepository.ts"), "utf8");

    expect(chat).toContain('aria-label="搜索当前聊天"');
    expect(chat).toContain('placeholder="搜索当前聊天"');
    expect(chat).toContain("scheduleSearch");
    expect(chat).toContain("directMessages.searchPeerMessages(peer, query, {");
    expect(chat).toContain("new AbortController()");
    expect(chat).toContain("searchAbortController?.abort()");
    expect(chat).toContain("visibleSearchResults");
    expect(chat).toContain("searchComplete");
    expect(chat).toContain("directMessages.loadPeerMessageContext(peerPubkey.value, messageId, 20)");
    expect(chat).toContain("searchContextActive");
    expect(chat).toContain("if (searchContextActive.value)");
    expect(chat).toContain("await focusMessage(messageId)");
    expect(chat).toContain("'message-highlight': highlightedMessageId === message.id");
    expect(chat).toContain("watch([draft, replyingToId], scheduleDraftSave)");
    expect(chat).toContain("}, 300)");
    expect(chat).toContain("directMessages.saveDraft(peer, { text, replyTo }, account)");
    expect(chat).toContain('window.addEventListener("pagehide", handlePageHide)');
    expect(store).toContain("syncedMessageRepository.listConversationPage(account, conversationId, before, limit)");
    expect(store).toContain("scanMessageSearchPages");
    expect(store).not.toContain("const records = await syncedMessageRepository.listConversation(account, conversationId)");
    expect(store).toContain('value.normalize("NFKC").toLocaleLowerCase()');
    expect(store).toContain('const DRAFT_PREFIX = "dm-draft:"');
    expect(store).toContain("clearDraftThrough(peer, now, account)");
    expect(meta).toContain("listPrefix(accountPubkey: string, prefix: string)");
    expect(conversations).toContain("directMessages.draftsByPeer");
    expect(conversations).toContain("草稿：");
    expect(store).not.toContain("searchDirectMessagesOnRelay");
  });

  it("keeps the latest private message visible when the composer receives focus", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain('@focus="handleComposerFocus"');
    expect(chat).toContain('@blur="handleComposerBlur"');
    expect(chat).toContain('window.visualViewport?.addEventListener("resize", handleVisualViewportResize)');
    expect(chat).toContain('window.visualViewport?.removeEventListener("resize", handleVisualViewportResize)');
    expect(chat).toContain("requestAnimationFrame(setMessageListToBottom)");
    expect(chat).toContain("if (composerFocused) setMessageListToBottom()");
  });

  it("keeps long DM rendering bounded while preserving playback, anchors, and latest-read semantics", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain("const windowEnd = ref(initialWindowRange.end)");
    expect(chat).toContain("mergeBoundedMessageIndexes(");
    expect(chat).toContain("MAX_RENDERED_MESSAGES = 100");
    expect(chat).toContain("shiftBoundedMessageWindow");
    expect(chat).toContain("mergeBoundedMessageIndexes");
    expect(chat).toContain("retainedPlaybackMessageId");
    expect(chat).toContain("refreshRetainedPlaybackMessage");
    expect(chat).not.toContain("currentPinnedMessageIndexes");
    expect(chat).toContain("captureMessageDomAnchor");
    expect(chat).toContain("restoreMessageDomAnchor");
    expect(chat).toContain('querySelector<HTMLElement>(".voice-shell.playing")');
    expect(chat).toContain('messageList.value?.addEventListener("load", handleMessageMediaLoad, true)');
    expect(chat).toContain('messageList.value?.removeEventListener("load", handleMessageMediaLoad, true)');
    expect(chat).toContain("windowEnd.value >= messages.value.length");
    expect(chat).toContain("if (!loadingConversation) void markVisibleMessagesRead()");
  });

  it("offers a jump-to-latest control without changing DM read or sync semantics", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain('class="jump-to-latest"');
    expect(chat).toContain("pendingTailCount");
    expect(chat).toContain("showJumpToLatest");
    expect(chat).toContain("function jumpToLatest()");
    expect(chat).toContain("isNearMessageBottom(metrics, BOTTOM_FOLLOW_THRESHOLD)");
    expect(chat).toContain("pendingTailCount.value += newTailCount");
    expect(chat).toContain("showJumpToLatest.value = false");
    expect(chat).toContain("pendingTailCount.value = 0");
  });

  it("uses a ChatGPT-like multiline DM composer that expands on focus and keeps Enter for newlines", () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    expect(chat).toContain("calc(28px + env(safe-area-inset-bottom))");
    expect(chat).toContain('class="composer-normal"');
    expect(chat).toContain('class="composer-recording"');
    expect(chat).toContain('class="composer-preview"');
    expect(chat).toContain('aria-label="发送"');
    expect(chat).toContain("<textarea");
    expect(chat).toContain('rows="1"');
    expect(chat).toContain('enterkeyhint="enter"');
    expect(chat).toContain("resizeComposerTextarea(textInput.value, composerFocused");
    expect(chat).toContain("minHeight: 36");
    expect(chat).toContain("focusedMinHeight: 36");
    expect(chat).toContain("width:calc(100% - 48px)");
    expect(chat).toContain(".chat-composer:focus-within{width:calc(100% - 32px)");
    expect(chat).toContain(".composer-region:has(.chat-composer:focus-within){padding-bottom:calc(8px + env(safe-area-inset-bottom))}");
    expect(chat).toContain("min-height:48px");
    expect(chat).toContain(".composer-normal:focus-within{min-height:76px");
    expect(chat).toContain("max-height:108px");
    expect(chat).toContain("border-radius:24px");
    expect(chat).toContain("border-radius:50%");
    expect(chat).toContain("box-shadow:0 4px 18px");
    expect(chat).toContain("width:min(100%,720px)");
    expect(chat).toContain('class="composer-icon-visual"');
    expect(chat).toContain('class="composer-icon-visual send-visual"');
    expect(chat).toContain('<path d="M12 5v14M5 12h14"/>');
    expect(chat).toContain('class="attachment-file-input sr-file-input"');
    expect(chat).toContain(".attachment-file-input{position:absolute;inset:0;width:100%;height:100%");
    expect(chat).not.toContain('@click="chooseImage"');
    expect(chat).toContain("width:44px;height:44px");
    expect(chat).toContain("margin:-5px");
    expect(chat).toContain(".send-button .send-visual{background:#0f1419}");
    expect(chat).toContain(".send-button .send-visual svg{width:18px;height:18px}");
    expect(chat).toContain('class="composer-actions"');
    expect(chat).toContain(".composer-actions{display:contents}");
    expect(chat).toContain(".composer-normal:focus-within .composer-actions{display:flex");
    expect(chat).toContain("grid-template-rows:auto 34px");
  });

  it("revalidates friendship before new DM navigation and keeps DM authorization in the account sync owner", () => {
    const sheet = readThemedSource(join(process.cwd(), "src/components/NewConversationSheet.vue"), "utf8");
    const accountSync = readThemedSource(join(process.cwd(), "src/services/accountMessageSync.ts"), "utf8");
    const home = readThemedSource(join(process.cwd(), "src/views/Home.vue"), "utf8");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");

    expect(sheet).toContain("if (!friendships.isAccepted(pubkey))");
    expect(sheet).toContain("好友关系已变更，请重新选择");
    expect(accountSync).toContain("isAuthorizedCanonicalDirectMessage(");
    expect(home).not.toContain("isAuthorizedCanonicalDirectMessage(");
    expect(home).not.toContain("accountMessageSyncManager");
    expect(home).not.toContain("messageSync.start(");
    expect(home).not.toContain("messageSync.stop(");
    expect(home).toContain("onAccountMessageSyncStatus(applyAccountSyncStatus)");
    expect(home).toContain('resumeAccountMessageSync("manual")');
    expect(store).toContain('if (!friendships.isAccepted(task.peerPubkey)) throw new Error("好友关系已变更")');
  });

  it("uses per-message optimistic status without blocking the composer", async () => {
    const chat = readThemedSource(join(process.cwd(), "src/views/Messages.vue"), "utf8");
    const { dmDeliveryLabel } = await import("@/utils/networkOperationFeedback");
    expect(dmDeliveryLabel("uploading")).toBe("上传中…");
    expect(dmDeliveryLabel("sending")).toBe("发送中…");
    expect(dmDeliveryLabel("sent")).toBe("✓ Relay 已接受");
    expect(dmDeliveryLabel("upload_failed")).toBe("上传失败");
    expect(dmDeliveryLabel("send_failed")).toBe("发送失败");
    expect(chat).toContain("font-size:9px;font-weight:400");
    expect(chat).toContain("opacity:.85");
    expect(chat).toContain("retryOutgoingMessage(message.outgoing.localId)");
    expect(chat).toContain('draft.value = ""');
    expect(chat).not.toContain("sendError");
    expect(chat).not.toContain("sending.value");
    const store = readThemedSource(join(process.cwd(), "src/stores/directMessages.ts"), "utf8");
    expect(store).toContain('onAppResume(() => {');
    expect(store).not.toContain('window.addEventListener("pageshow", resume)');
    expect(store).toContain("resumePending(true)");
  });
});
