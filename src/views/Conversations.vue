<template>
  <main class="conversations-page app-page">
    <header class="page-header">
      <div class="page-title">
        <h1>私信</h1>
        <span v-if="syncLabel" class="sync-label" role="status" aria-live="polite">{{ syncLabel }}</span>
      </div>
      <button
        class="conversation-filter"
        type="button"
        :aria-label="`当前显示${filterMode === 'all' ? '全部' : '未读'}私信，点击切换`"
        :aria-pressed="filterMode === 'unread'"
        @click="toggleFilter"
      >
        {{ filterMode === 'all' ? '全部' : '未读' }}
        <span aria-hidden="true">⌄</span>
      </button>
    </header>

    <button class="conversation-filter" type="button" @click="router.push('/calls')">通话记录</button>

    <label class="conversation-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <input v-model="searchQuery" type="search" placeholder="搜索私信" autocomplete="off" />
    </label>

    <div class="conversation-row assistant-row">
      <button class="conversation-main" type="button" @click="router.push('/nearby')">
        <span class="assistant-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" /></svg></span>
        <span class="conversation-copy"><strong>文件传输助手</strong><span v-if="nearbyPresence.online" class="preview">{{ nearbyPresence.online }} 台设备在线</span></span>
        <span class="conversation-meta">
          <span v-if="nearbyUnread.count" class="unread-badge" :aria-label="`${nearbyUnread.count} 条新传输`">{{ nearbyUnread.count }}</span>
          <span v-else aria-hidden="true">›</span>
        </span>
      </button>
    </div>

    <div v-if="conversations.length === 0" class="empty-state">
      <strong>暂无私信</strong>
      <span>和好友开始一段新的私密对话。</span>
      <button class="empty-action" type="button" @click="ui.openNewConversation()">发起私信</button>
    </div>
    <div v-else-if="filteredConversations.length === 0" class="search-empty">{{ emptyFilteredMessage }}</div>
    <div v-else class="conversation-list">
      <div
        v-for="conversation in filteredConversations"
        :key="conversation.peerPubkey"
        class="conversation-row"
        :class="{ pinned: conversation.pinned }"
        @touchstart="onTouchStart($event, conversation.peerPubkey)"
        @touchmove="onTouchMove($event, conversation.peerPubkey)"
        @touchend="onTouchEnd(conversation.peerPubkey)"
        @touchcancel="onTouchCancel(conversation.peerPubkey)"
      >
        <div class="swipe-actions">
          <button class="action pin" type="button" @click.stop="togglePin(conversation.peerPubkey)">{{ conversation.pinned ? "取消置顶" : "置顶" }}</button>
          <button class="action mute" type="button" @click.stop="toggleMute(conversation.peerPubkey)">{{ conversation.muted ? "取消免打扰" : "免打扰" }}</button>
          <button class="action hide" type="button" @click.stop="hideConversation(conversation.peerPubkey)">隐藏</button>
          <button class="action delete" type="button" @click.stop="deleteConversation(conversation.peerPubkey)">删除</button>
        </div>
        <button
          class="conversation-main"
          type="button"
          :style="swipeStyle(conversation.peerPubkey)"
          @pointerdown="warmConversation(conversation.peerPubkey)"
          @focus="warmConversation(conversation.peerPubkey)"
          @click="openConversation(conversation.peerPubkey)"
        >
          <ProfileAvatar :pubkey="conversation.peerPubkey" :local-name="localName(conversation.peerPubkey)" :size="48" />
          <span class="conversation-copy">
            <strong>
              <svg v-if="conversation.pinned" class="row-flag" viewBox="0 0 24 24" aria-label="已置顶"><path d="M15 3l6 6-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z"/></svg>
              {{ displayName(conversation.peerPubkey) }}
            </strong>
            <span class="preview">{{ preview(conversation.latest, conversation.draft) }}</span>
          </span>
          <span class="conversation-meta">
            <time>{{ formatRelativeTime(conversation.latest.created_at) }}</time>
            <span v-if="conversation.unread && conversation.muted" class="unread-dot" :aria-label="`${conversation.unread} 条未读私信（免打扰）`"></span>
            <span v-else-if="conversation.unread" class="unread-badge" :aria-label="`${conversation.unread} 条未读私信`">{{ conversation.unread > 99 ? '99+' : conversation.unread }}</span>
            <svg v-else-if="conversation.muted" class="row-flag muted-flag" viewBox="0 0 24 24" aria-label="免打扰"><path d="M18 16v-5a6 6 0 0 0-9.6-4.8M6 9.5V16l-2 2h11M10 21h4M3 3l18 18"/></svg>
          </span>
        </button>
      </div>
    </div>
    <NewConversationSheet
      :visible="ui.showNewConversation"
      @close="ui.closeNewConversation()"
      @select="openConversation"
    />
  </main>
</template>

<script setup lang="ts">
import { nearbyPresence, nearbyUnread } from "@/services/nearbyUnread";
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import NewConversationSheet from "@/components/NewConversationSheet.vue";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { directMessagePreview } from "@/nostr/messaging/directMessages";
import { hasDisappearingMarker } from "@/nostr/messaging/disappearingMessages";
import { buildDirectConversationSummaries, useDirectMessagesStore, type DmDraft } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { formatRelativeTime } from "@/utils/format";
import { loadAccountStoresOnce, runAfterFirstPaint, runWhenIdle } from "@/utils/bottomTabActivation";
import { loadMessagesView } from "@/router/lazyViews";
import { useSwipeActions } from "@/composables/useSwipeActions";
import { sortConversationRows } from "@/utils/conversationOrder";
import { networkOnline } from "@/services/networkStatus";
import {
  getAccountMessageSyncStatus,
  messageSyncPhase,
  onAccountMessageSyncStatus,
  type AccountMessageSyncSnapshot,
} from "@/services/accountMessageSync";

const router = useRouter();
const keys = useKeyStore();
const messages = useMessagesStore();
const directMessages = useDirectMessagesStore();
const friendships = useFriendshipsStore();
const friends = useFriendsStore();
const profiles = useProfilesStore();
const ui = useUIStore();
const searchQuery = ref("");
const syncSnapshot = ref<AccountMessageSyncSnapshot>(getAccountMessageSyncStatus());
const currentSyncLabel = computed(() => {
  const snapshot = syncSnapshot.value;
  if (!keys.pkHex || snapshot.accountPubkey !== keys.pkHex.toLowerCase()) return "";
  const phase = messageSyncPhase(snapshot, directMessages.historyHydrationPhase === "hydrating");
  if (!networkOnline.value) return "离线";
  return phase === "connecting" ? "连接中…" : phase === "syncing" ? "同步中…" : "";
});
// Every foreground return runs a short catch-up; show the label only when it
// lasts, so a sub-second pass does not flash "同步中…". Offline shows at once.
const SYNC_LABEL_DELAY_MS = 700;
const syncLabel = ref("");
let syncLabelTimer: ReturnType<typeof setTimeout> | null = null;
watch(currentSyncLabel, label => {
  if (syncLabelTimer) clearTimeout(syncLabelTimer);
  syncLabelTimer = null;
  if (!label || label === "离线" || syncLabel.value) {
    syncLabel.value = label;
    return;
  }
  syncLabelTimer = setTimeout(() => {
    syncLabelTimer = null;
    syncLabel.value = currentSyncLabel.value;
  }, SYNC_LABEL_DELAY_MS);
}, { immediate: true });
const stopSyncStatusListener = onAccountMessageSyncStatus(snapshot => { syncSnapshot.value = snapshot; });
const filterMode = ref<"all" | "unread">("all");
// Four 64px actions: pin, mute, hide, delete.
const { close: closeSwipe, closeOthers: closeOtherSwipes, isOpen: isSwipeOpen, onTouchCancel, onTouchEnd, onTouchMove, onTouchStart, swipeStyle } = useSwipeActions({ actionWidth: 256 });
const canonicalConversations = computed(() => buildDirectConversationSummaries(
  directMessages.conversationItems(),
  keys.pkHex,
  directMessages.visibleUnreadByConversation,
  { friendshipRecords: friendships.records, preferencesByPeer: directMessages.preferencesByPeer },
));
const conversations = computed(() => {
  const existing = new Set(canonicalConversations.value.map(item => item.peerPubkey));
  const rows = canonicalConversations.value.map(item => ({
    ...item,
    draft: directMessages.draftsByPeer[item.peerPubkey],
  }));
  for (const [peerPubkey, draft] of Object.entries(directMessages.draftsByPeer)) {
    if (!draft || existing.has(peerPubkey) || !friendships.isAccepted(peerPubkey) || directMessages.preferencesByPeer[peerPubkey]?.hidden) continue;
    rows.push({
      peerPubkey,
      conversationId: `draft:${peerPubkey}`,
      latest: {
        id: `draft:${peerPubkey}`,
        pubkey: keys.pkHex,
        recipientPubkeys: [peerPubkey],
        created_at: Math.floor(draft.updatedAt / 1000),
        content: "",
        protocol: "nip17" as const,
        transportKind: 1059,
        tags: [["t", "hainei-dm"]],
      },
      unread: 0,
      draft,
    });
  }
  return sortConversationRows(rows.map(row => {
    const preference = friends.conversationPreference(row.peerPubkey);
    return { ...row, pinned: preference.pinned, muted: preference.muted };
  }), peer => friends.conversationPreference(peer).pinnedAt);
});
const friendByPubkey = computed(() => new Map(friends.list.map(friend => [friend.pubkey, friend])));
const localName = (pubkey: string) => friendByPubkey.value.get(pubkey)?.name;
const displayName = (pubkey: string) => privateProfileDisplayName(profiles.getProfile(pubkey)?.nickname, pubkey, localName(pubkey));
const preview = (message: InboxItem, draft?: DmDraft) => {
  if (draft) {
    const text = draft.text.trim() || (draft.replyTo ? "引用回复" : "");
    if (text) return `草稿：${text}`;
  }
  // Never surface concealed temporary plaintext in the conversation preview.
  if (hasDisappearingMarker(message.tags)) return directMessages.burnedById[message.id] ? "临时消息已销毁" : "♨ 阅后即焚消息";
  if (message.outgoing?.state === "uploading") return "[图片] · 上传中…";
  if (message.outgoing?.state === "sending") return message.outgoing.hasImage ? "[图片] · 发送中…" : "消息发送中…";
  if (message.outgoing?.state === "upload_failed" || message.outgoing?.state === "send_failed") return "发送失败";
  return directMessagePreview(message.content) || "新消息";
};
const filteredConversations = computed(() => {
  const needle = searchQuery.value.trim().toLocaleLowerCase();
  return conversations.value.filter(conversation => {
    if (filterMode.value === "unread" && conversation.unread <= 0) return false;
    if (!needle) return true;
    const friend = friendByPubkey.value.get(conversation.peerPubkey);
    const profileName = profiles.getProfile(conversation.peerPubkey)?.nickname || "";
    return [displayName(conversation.peerPubkey), friend?.name, friend?.note, profileName]
      .some(value => value?.toLocaleLowerCase().includes(needle));
  });
});
const emptyFilteredMessage = computed(() => {
  if (searchQuery.value.trim()) return "未找到相关私信";
  if (filterMode.value === "unread") return "暂无未读私信";
  return "暂无私信";
});

function toggleFilter() {
  filterMode.value = filterMode.value === "all" ? "unread" : "all";
  closeOtherSwipes();
}

async function load() {
  const account = keys.pkHex;
  if (!account) return;
  await loadAccountStoresOnce(account, [messages, friendships, friends, profiles]);
}
function warmConversation(pubkey: string) {
  void loadMessagesView();
  void directMessages.prefetchPeerHistory(pubkey).catch(() => undefined);
}
function scheduleConversationWarmup() {
  runAfterFirstPaint(() => {
    void loadMessagesView();
    runWhenIdle(() => {
      const firstPeer = conversations.value[0]?.peerPubkey;
      if (firstPeer) void directMessages.prefetchPeerHistory(firstPeer).catch(() => undefined);
    }, 600);
  });
}
function openConversation(pubkey: string) {
  warmConversation(pubkey);
  if (isSwipeOpen(pubkey)) {
    closeSwipe(pubkey);
    return;
  }
  closeOtherSwipes();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  void router.push(`/messages/${pubkey}`);
}
async function togglePin(pubkey: string) {
  closeSwipe(pubkey);
  const pinned = !friends.conversationPreference(pubkey).pinned;
  try {
    await friends.setConversationPreference(pubkey, { pinned });
    ui.addToast(pinned ? "已置顶" : "已取消置顶", 1200, "info");
  } catch {
    ui.addToast("操作失败，请稍后重试", 2000, "error");
  }
}
async function toggleMute(pubkey: string) {
  closeSwipe(pubkey);
  const muted = !friends.conversationPreference(pubkey).muted;
  try {
    await friends.setConversationPreference(pubkey, { muted });
    ui.addToast(muted ? "已开启免打扰，不再推送通知" : "已关闭免打扰", 1600, "info");
  } catch {
    ui.addToast("操作失败，请稍后重试", 2000, "error");
  }
}
async function hideConversation(pubkey: string) {
  closeSwipe(pubkey);
  try {
    await directMessages.hideConversation(pubkey);
    ui.addToast("已隐藏私信", 1500, "info");
  } catch {
    ui.addToast("隐藏失败，请稍后重试", 2000, "error");
  }
}
async function deleteConversation(pubkey: string) {
  closeSwipe(pubkey);
  if (!window.confirm("仅删除当前设备/当前账号中的聊天记录，无法撤回对方或 Relay 上的消息。")) return;
  try {
    await directMessages.deleteConversation(pubkey);
    ui.addToast("已删除本机聊天记录", 1600, "info");
  } catch {
    ui.addToast("删除失败，请稍后重试", 2000, "error");
  }
}

onMounted(() => {
  void load();
  scheduleConversationWarmup();
});
onActivated(() => {
  void load();
  scheduleConversationWarmup();
});
onBeforeUnmount(() => {
  if (syncLabelTimer) clearTimeout(syncLabelTimer);
  stopSyncStatusListener();
});
onDeactivated(() => {
  closeOtherSwipes();
  ui.closeNewConversation();
});
</script>

<style scoped>
.assistant-avatar{display:grid;width:48px;height:48px;flex:0 0 48px;place-items:center;border-radius:50%;background:var(--bg-f1f5f9);color:var(--fg-172033)}
.assistant-avatar svg{width:25px;height:25px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linejoin:round}
.conversations-page{width:100%;min-height:100%;margin:0 auto;box-sizing:border-box;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 28px);background:var(--bg-fff);color:var(--fg-0f1419)}
.page-header{position:sticky;top:0;z-index:4;display:flex;align-items:center;justify-content:space-between;min-height:54px;padding:0 16px;background:var(--bg-rgba-255-255-255-97)}.page-title{display:flex;align-items:baseline;gap:8px}.page-header h1{margin:0;font-size:21px;font-weight:750}.sync-label{color:var(--fg-64748b);font-size:13px;font-weight:500}.conversation-filter{display:flex;min-height:36px;align-items:center;gap:2px;padding:0 2px 0 10px;border:0;border-radius:999px;background:transparent;color:var(--fg-536471);font-size:14px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}.conversation-filter:active{background:var(--bg-f1f5f9)}.conversation-filter span{font-size:16px;line-height:1;transform:translateY(-1px)}
.conversation-search{display:grid;grid-template-columns:20px minmax(0,1fr);align-items:center;gap:9px;margin:4px 16px 10px;padding:0 13px;border-radius:999px;background:var(--bg-eff3f4);color:var(--fg-536471)}.conversation-search svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}.conversation-search input{width:100%;height:42px;padding:0;border:0;outline:0;background:transparent;color:var(--fg-0f1419);font-size:16px}.conversation-search input::placeholder{color:var(--fg-536471)}
.conversation-list{display:flex;width:100%;flex-direction:column;border-top:1px solid var(--bd-eff1f3)}.conversation-row{position:relative;width:100%;min-height:72px;overflow:hidden;border-bottom:1px solid var(--bd-eff1f3);background:var(--bg-fff);color:var(--fg-0f1419);touch-action:pan-y}.swipe-actions{position:absolute;inset:0 0 0 auto;display:flex;width:256px}.action{width:64px;padding:0 2px;border:0;color:#fff;font-size:11px;font-weight:650;line-height:1.25;white-space:nowrap}.action.pin{background:#1d9bf0}.action.mute{background:#f59e0b}.action.hide{background:#536471}.action.delete{background:#f4212e}.conversation-main{position:relative;z-index:1;display:grid;width:100%;grid-template-columns:48px minmax(0,1fr) auto;align-items:center;gap:12px;min-width:0;min-height:72px;padding:11px 16px;border:0;background:var(--bg-fff);color:inherit;text-align:left;cursor:pointer;transition:transform .2s ease}.conversation-main:active{background:var(--bg-f7f9f9)}.conversation-copy{display:flex;min-width:0;flex-direction:column;gap:4px}.conversation-copy strong,.preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.conversation-copy strong{display:flex;min-width:0;align-items:center;gap:4px;font-size:15px}.conversation-row.pinned .conversation-main{background:var(--bg-f7f9f9)}.row-flag{width:14px;height:14px;flex:0 0 14px;fill:none;stroke:var(--fg-536471);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.unread-dot{width:9px;height:9px;margin:4px 4px 5px;border-radius:50%;background:var(--fg-94a3b8)}.preview{color:var(--fg-536471);font-size:13px}.conversation-meta{display:flex;align-items:flex-end;gap:7px;flex-direction:column;color:var(--fg-536471);font-size:11px}.unread-badge{display:grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#1d9bf0;color:#fff;font-size:10px;font-weight:700}
.empty-state{display:flex;min-height:44vh;align-items:center;justify-content:center;flex-direction:column;gap:7px;padding:24px;color:var(--fg-536471);text-align:center}.empty-state strong{color:var(--fg-0f1419);font-size:19px}.empty-state span{font-size:14px}.empty-action{min-height:40px;margin-top:8px;padding:0 18px;border:0;border-radius:999px;background:var(--bg-0f1419);color:#fff;font-size:14px;font-weight:650}.search-empty{padding:48px 20px;color:var(--fg-536471);font-size:14px;text-align:center}
</style>
