<template>
  <main ref="container" class="app-page calls-page">
    <header class="calls-header primary-page-header">
      <h1 class="primary-page-title">通话</h1>
      <button class="new-call primary-header-action" type="button" aria-label="发起新通话" @click="showPicker = true">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </header>
    <div class="page-pull-indicator" :style="{ height: pullDistance + 'px' }" role="status">
      {{ refreshing ? "正在更新…" : pullDistance >= 60 ? "松开刷新" : "↓ 下拉刷新" }}
    </div>
    <label class="calls-search primary-page-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <input v-model="search" type="search" autocomplete="off" placeholder="搜索通话记录" aria-label="搜索通话记录"/>
    </label>
    <div class="calls-filters" role="group" aria-label="通话记录筛选">
      <button type="button" :aria-pressed="!missedOnly" @click="missedOnly = false">全部</button>
      <button type="button" :aria-pressed="missedOnly" @click="missedOnly = true">未接来电</button>
    </div>
    <p v-if="error" class="calls-state" role="alert">{{ error }} <button type="button" @click="subscribe">重试</button></p>
    <p v-else-if="loading" class="calls-state" role="status">正在读取通话记录…</p>
    <p v-else-if="!filtered.length" class="calls-state">{{ search.trim() ? "没有匹配的通话" : missedOnly ? "暂无未接来电" : "暂无通话记录" }}</p>
    <TransitionGroup v-else name="call-remove" tag="ul" class="calls-list">
      <li v-for="item in filtered" :key="item.id" class="call-swipe-row"
        @touchstart="onTouchStart($event, item.id)"
        @touchmove="onTouchMove($event, item.id)"
        @touchend="onTouchEnd(item.id)"
        @touchcancel="onTouchCancel(item.id)">
        <div class="call-swipe-actions">
          <button class="call-delete" type="button" :aria-label="`删除 ${name(item.peer)} 的通话记录`"
            :disabled="deletingId === item.id" @click.stop="deleteCallRecord(item)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>
        </div>
        <div class="call-row" :style="swipeStyle(item.id)">
          <button class="call-record" type="button" :aria-label="`查看 ${name(item.peer)} 的资料`"
            @click="isSwipeOpen(item.id) ? closeSwipe(item.id) : router.push(`/profile/${item.peer}`)">
            <ProfileAvatar :pubkey="item.peer" :local-name="localName(item.peer)" :size="46"/>
            <span class="call-copy">
              <strong :class="{ missed: item.missed }">{{ name(item.peer) }}</strong>
              <span :class="{ missed: item.missed }">{{ callSubtitle(item) }}</span>
            </span>
            <time>{{ timeLabel(item.createdAt) }}</time>
          </button>
          <button class="call-back" type="button" :aria-label="`回拨 ${name(item.peer)}`" :disabled="busy || call.phase !== 'idle' || !friendships.isAccepted(item.peer)"
            data-live-audio-action data-ringtone-arm @pointerdown="preload" @focus="preload" @click="startCall(item.peer)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
          </button>
        </div>
      </li>
    </TransitionGroup>
    <button v-if="hasMore && !search.trim()" class="load-more" type="button" :disabled="loading" @click="limit += 50">加载更多</button>
    <p class="calls-note">显示此设备已同步的通话记录。历史版本可能缺少呼入或呼出信息。</p>

    <div v-if="showPicker" class="picker-backdrop" @click.self="showPicker = false">
      <section class="picker-sheet" role="dialog" aria-modal="true" aria-label="发起语音通话">
        <header class="picker-header"><h2>选择联系人</h2><button type="button" aria-label="关闭" @click="showPicker = false">×</button></header>
        <input v-model="contactSearch" type="search" autocomplete="off" placeholder="搜索通讯录" aria-label="搜索要拨打的联系人"/>
        <div class="picker-list">
          <p v-if="!callableFriends.length" class="calls-state">暂无匹配的好友</p>
          <button v-for="friend in callableFriends" :key="friend.pubkey" class="picker-row" type="button"
            :disabled="busy || call.phase !== 'idle'" data-live-audio-action data-ringtone-arm @pointerdown="preload" @focus="preload" @click="startCall(friend.pubkey)">
            <ProfileAvatar :pubkey="friend.pubkey" :local-name="friend.name" :size="42"/>
            <span class="picker-name">{{ name(friend.pubkey) }}</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>
          </button>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { liveQuery } from "dexie";
import { readVisibleCallHistoryPage, uniqueCallHistory, type CallHistoryItem } from "@/services/callHistory";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { useFriendsStore } from "@/stores/friends";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { loadCallEngine, loadedCallEngine, useCallStore } from "@/stores/call";
import { loadAccountStoresOnce } from "@/utils/bottomTabActivation";
import { useCallHistoryStore } from "@/stores/callHistory";
import { useSwipeActions } from "@/composables/useSwipeActions";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { resumeAccountMessageSync } from "@/services/accountMessageSync";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
const keys = useKeyStore(), friendships = useFriendshipsStore(), friends = useFriendsStore(), profiles = useProfilesStore();
const router = useRouter(), call = useCallStore(), callHistory = useCallHistoryStore();
const records = ref<CallHistoryItem[]>([]), limit = ref(50), missedOnly = ref(false), hasMore = ref(false), loading = ref(true), error = ref(""), busy = ref(false);
const showPicker = ref(false), search = ref(""), contactSearch = ref(""), deletingId = ref("");
const { close: closeSwipe, isOpen: isSwipeOpen, onTouchStart, onTouchMove,
  onTouchEnd, onTouchCancel, swipeStyle } = useSwipeActions({ actionWidth: 76 });
const { container, pullDistance, refreshing } = usePullToRefresh({ onRefresh: async () => {
  if (keys.pkHex && keys.isUnlocked) await resumeAccountMessageSync("manual");
} });
let subscription: { unsubscribe(): void } | undefined;
let generation = 0;
const localName = (peer: string) => friends.list.find(f => f.pubkey === peer)?.name;
const name = (peer: string) => privateProfileDisplayName(profiles.getProfile(peer)?.nickname, peer, localName(peer));
const filtered = computed(() => uniqueCallHistory([...records.value, ...callHistory.localMissed]
  .filter(item => !callHistory.isDeleted(item.id) && (!missedOnly.value || item.missed)
    && name(item.peer).toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
  .sort((a, b) => b.createdAt - a.createdAt)));
const callableFriends = computed(() => friends.getAcceptedList(friendships.isAccepted).filter(friend => name(friend.pubkey).toLocaleLowerCase().includes(contactSearch.value.trim().toLocaleLowerCase())));
function callSubtitle(item: CallHistoryItem) {
  if (item.missed) return "未接来电";
  const direction = item.direction === "incoming" ? "呼入" : item.direction === "outgoing" ? "呼出" : "通话";
  // Outcome messages were formerly visible in DMs as “📞 语音通话 · ...”.
  // Only show the duration or outcome, never the redundant phone icon/label.
  const outcome = item.text.replace(/^📞\s*语音通话\s*(?:·\s*)?/, "").trim();
  return outcome && outcome !== "语音通话" ? `${direction} · ${outcome}` : direction;
}
function timeLabel(seconds: number) {
  const date = new Date(seconds * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
function subscribe() {
  subscription?.unsubscribe(); const token = ++generation;
  records.value = []; error.value = ""; hasMore.value = false;
  const account = keys.pkHex, count = limit.value, missed = missedOnly.value;
  if (!account || !keys.isUnlocked) { loading.value = false; return; }
  loading.value = true;
  subscription = liveQuery(() => readVisibleCallHistoryPage(account, count, missed))
    .subscribe({ next: page => {
    if (token !== generation) return;
    records.value = page.items; hasMore.value = page.hasMore; loading.value = false;
  }, error: () => { if (token === generation) { loading.value = false; error.value = "读取通话记录失败，请重试"; } } });
}
watch(() => [keys.pkHex, keys.isUnlocked, limit.value, missedOnly.value], subscribe, { immediate: true, flush: "sync" });
watch(() => [keys.pkHex, keys.isUnlocked] as const, ([account, unlocked]) => {
  if (account && unlocked) {
    void loadAccountStoresOnce(account, [friends, friendships, profiles]).catch(() => {});
    void callHistory.load(account).then(() => callHistory.acknowledge(account)).catch(() => {});
  } else showPicker.value = false;
}, { immediate: true });
// Viewing the Calls tab acknowledges the badge. Do not mark unread before
// the account's local and server history has hydrated, or race an offline call.
async function deleteCallRecord(item: CallHistoryItem) {
  const account = keys.pkHex;
  if (!account || deletingId.value || !keys.isUnlocked) return;
  deletingId.value = item.id;
  closeSwipe(item.id);
  try {
    if (keys.pkHex === account && keys.isUnlocked) await callHistory.deleteRecord(account, item.id);
  } catch { error.value = "删除失败，请重试"; }
  finally { deletingId.value = ""; }
}
onBeforeUnmount(() => { generation++; subscription?.unsubscribe(); });
function preload() { void loadCallEngine().catch(() => {}); }
async function startCall(peer: string) {
  if (busy.value || call.phase !== "idle" || !friendships.isAccepted(peer)) return;
  busy.value = true; error.value = "";
  const account = keys.pkHex;
  try {
    const engine = loadedCallEngine() || await loadCallEngine();
    if (keys.pkHex === account && keys.isUnlocked && friendships.isAccepted(peer)) {
      showPicker.value = false;
      await engine.startCall(peer);
    }
  } catch { error.value = "暂时无法发起通话，请重试"; }
  finally { busy.value = false; }
}
</script>

<style scoped>
.calls-page{position:relative;max-width:760px;margin:0 auto;min-height:100vh;overscroll-behavior:contain;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 20px);background:var(--bg-fff);color:var(--fg-0f1419)}
.call-back svg,.picker-row svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.calls-filters{display:flex;gap:8px;padding:2px 16px 12px}
.calls-filters button{min-height:35px;padding:0 17px;border:0;border-radius:999px;background:var(--bg-eef2f6);color:var(--fg-536471);font-size:13px;font-weight:650}
.calls-filters button[aria-pressed=true]{background:#1687e8;color:#fff}
.calls-list{margin:0;padding:0;list-style:none}.call-swipe-row{position:relative;overflow:hidden;touch-action:pan-y;border-bottom:1px solid var(--bd-eff1f3)}
.call-swipe-actions{position:absolute;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;width:76px}
.call-row{position:relative;z-index:1;display:flex;align-items:center;gap:2px;padding:4px 12px;background:var(--bg-fff);transition:transform 200ms ease-out}
.call-record{display:flex;align-items:center;gap:11px;min-height:64px;min-width:0;flex:1;padding:6px 2px;border:0;background:transparent;color:inherit;text-align:left}
.call-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:5px}.call-copy strong,.call-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.call-copy strong{font-size:15px}.call-copy span{font-size:12px;color:var(--fg-64748b)}.call-copy .missed{color:#dc2626}
.call-record time{align-self:flex-start;margin-top:9px;color:var(--fg-94a3b8);font-size:11px;white-space:nowrap}
.call-back{display:grid;place-items:center;flex:0 0 44px;width:44px;height:44px;border:0;border-radius:50%;background:transparent;color:#1687e8}
.call-delete{display:grid;place-items:center;width:52px;height:52px;border:0;border-radius:50%;background:#dc2626;color:white;cursor:pointer}
.call-delete svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.call-remove-move,.call-remove-leave-active{transition:transform 200ms ease,opacity 200ms ease}
.call-remove-leave-to{opacity:0;transform:translateX(-32px)}
.call-remove-leave-active{position:absolute;left:0;right:0;z-index:2;pointer-events:none}
.call-delete:disabled{opacity:.5}
@media (prefers-reduced-motion:reduce){.call-row{transition:none}}
.call-back:disabled{opacity:.35}.calls-state{text-align:center;padding:34px 16px;color:var(--fg-64748b);font-size:14px}.calls-note{padding:14px 16px;color:var(--fg-94a3b8);font-size:12px}
.load-more{display:block;margin:12px auto;border:0;background:transparent;color:#1687e8;min-height:44px}
.picker-backdrop{position:fixed;inset:0;z-index:15000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.46)}
.picker-sheet{display:flex;flex-direction:column;width:100%;max-width:760px;max-height:82dvh;padding:16px 16px calc(env(safe-area-inset-bottom) + 20px);border-radius:22px 22px 0 0;background:var(--bg-fff);color:var(--fg-172033)}
.picker-header{display:flex;justify-content:space-between;align-items:center}.picker-header h2{margin:0 0 12px;font-size:19px}
.picker-header button{width:44px;height:44px;border:0;background:transparent;color:inherit;font-size:28px}
.picker-sheet input{height:44px;padding:0 14px;border:0;border-radius:12px;background:var(--bg-eff3f4);color:inherit;font-size:16px}
.picker-list{overflow:auto;overscroll-behavior:contain}.picker-row{display:flex;align-items:center;gap:12px;width:100%;min-height:60px;border:0;border-bottom:1px solid var(--bd-eff1f3);background:transparent;color:inherit;text-align:left}
.picker-row .picker-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.picker-row :deep(.profile-avatar){flex:0 0 42px;max-width:42px;max-height:42px}.picker-row svg{color:#1687e8}.picker-row:disabled{opacity:.4}
.calls-page button:focus-visible{outline:2px solid #1687e8;outline-offset:2px}
@media (min-width:768px){.picker-sheet{margin:auto;border-radius:22px}}
</style>
