<template>
  <main class="app-page calls-page">
    <header><button type="button" @click="router.push('/conversations')" aria-label="返回私信">‹ 返回</button><h1>通话</h1></header>
    <div class="filters" aria-label="通话筛选"><button type="button" :aria-pressed="!missedOnly" @click="missedOnly = false">最近通话</button><button type="button" :aria-pressed="missedOnly" @click="missedOnly = true">未接</button></div>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="subscribe">重试</button></p>
    <p v-else-if="loading" role="status">正在读取通话记录…</p>
    <p v-else-if="!visible.length">{{ missedOnly ? '暂无未接来电' : '暂无通话记录' }}</p>
    <ul>
      <li v-for="item in visible" :key="item.id">
        <button class="record" type="button" @click="router.push(`/messages/${item.peer}`)">
          <ProfileAvatar :pubkey="item.peer" :size="44" />
          <span class="copy"><strong :class="{ missed: item.missed }">{{ name(item.peer) }}</strong><span>{{ item.direction === 'incoming' ? '呼入 · ' : item.direction === 'outgoing' ? '呼出 · ' : '' }}{{ item.text }}</span><time>{{ new Date(item.createdAt * 1000).toLocaleString() }}</time></span>
        </button>
        <button class="callback" type="button" :aria-label="`回拨 ${name(item.peer)}`" :disabled="busy || call.phase !== 'idle' || !friendships.isAccepted(item.peer)" data-live-audio-action data-ringtone-arm @pointerdown="preload" @focus="preload" @click="callBack(item.peer)">回拨</button>
      </li>
    </ul>
    <button v-if="hasMore" type="button" :disabled="loading" @click="limit += 50">加载更多</button>
    <p class="note">显示本账号已同步到此设备的记录。旧版记录可能没有呼入／呼出信息。</p>
  </main>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import Dexie, { liveQuery } from "dexie";
import { db } from "@/db/dexie";
import { callHistoryItem, uniqueCallHistory, type CallHistoryItem } from "@/services/callHistory";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { useFriendsStore } from "@/stores/friends";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { loadCallEngine, loadedCallEngine, useCallStore } from "@/stores/call";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
const keys = useKeyStore(), friendships = useFriendshipsStore(), friends = useFriendsStore(), profiles = useProfilesStore();
const router = useRouter(), call = useCallStore();
const records = ref<CallHistoryItem[]>([]), limit = ref(50), missedOnly = ref(false), hasMore = ref(false), loading = ref(true), error = ref(""), busy = ref(false);
let subscription: { unsubscribe(): void } | undefined;
let generation = 0;
const visible = computed(() => records.value);
const name = (peer: string) => privateProfileDisplayName(profiles.getProfile(peer)?.nickname, peer, friends.list.find(f => f.pubkey === peer)?.name);
function subscribe() {
  subscription?.unsubscribe(); const token = ++generation;
  records.value = []; error.value = ""; hasMore.value = false;
  const account = keys.pkHex, count = limit.value, missed = missedOnly.value;
  if (!account || !keys.isUnlocked) { loading.value = false; return; }
  loading.value = true;
  subscription = liveQuery(async () => {
    const items: CallHistoryItem[] = [];
    // Scan the account index, not the bounded 1000-message inbox. Keep only call rows.
    await db.syncedMessages.where("[accountPubkey+createdAt+id]")
      .between([account, Dexie.minKey, Dexie.minKey], [account, Dexie.maxKey, Dexie.maxKey])
      .reverse().until(() => items.length > count).each(record => {
        const item = callHistoryItem(record, account);
        if (item && (!missed || item.missed) && !items.some(row => row.id === item.id)) items.push(item);
      });
    return uniqueCallHistory(items);
  }).subscribe({ next: items => {
    if (token !== generation) return;
    records.value = items.slice(0, count); hasMore.value = items.length > count; loading.value = false;
  }, error: () => { if (token === generation) { loading.value = false; error.value = "读取通话记录失败，请重试"; } } });
}
watch(() => [keys.pkHex, keys.isUnlocked, limit.value, missedOnly.value], subscribe, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { generation++; subscription?.unsubscribe(); });
function preload() { void loadCallEngine().catch(() => {}); }
async function callBack(peer: string) {
  if (busy.value || call.phase !== "idle" || !friendships.isAccepted(peer)) return;
  busy.value = true; error.value = "";
  const account = keys.pkHex;
  try {
    const engine = loadedCallEngine() || await loadCallEngine();
    if (keys.pkHex === account && keys.isUnlocked && friendships.isAccepted(peer)) await engine.startCall(peer);
  } catch { error.value = "暂时无法发起通话，请重试"; }
  finally { busy.value = false; }
}
</script>
<style scoped>
.calls-page{max-width:720px;margin:auto;padding:16px}.calls-page header{display:flex;align-items:center;gap:16px}.calls-page h1{font-size:24px}.calls-page button{font:inherit;color:inherit;min-height:44px;border:0;border-radius:12px;padding:10px 14px;background:var(--bg-f1f5f9,#f1f5f9);cursor:pointer}.filters{display:flex;gap:12px;margin:16px 0}.filters button[aria-pressed=true]{background:#2563eb;color:#fff}.calls-page ul{list-style:none;padding:0}.calls-page li{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border,#cbd5e1);padding:10px 0}.calls-page .record{display:flex;align-items:center;gap:12px;flex:1;min-width:0;text-align:left;background:transparent;padding:4px}.copy{display:flex;flex-direction:column;gap:5px;min-width:0}.copy strong,.copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy span,.copy time,.note{font-size:13px;opacity:.75}.missed{color:#dc2626}.calls-page button:disabled{opacity:.45;cursor:default}.calls-page button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
</style>
