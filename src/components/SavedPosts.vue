<template>
  <section class="saved-content" aria-label="收藏的动态">
    <p class="saved-help">收藏会先保存在本机，并通过加密同步到其他设备。</p>
    <p v-if="loadError" class="saved-error" role="alert">{{ loadError }}</p>
    <p v-if="loading && !rows.length" class="saved-empty">正在读取收藏…</p>
    <p v-else-if="!rows.length" class="saved-empty">{{ query.trim() ? "没有匹配的收藏" : "暂无收藏" }}</p>
    <template v-else>
      <div v-if="missingCount" class="missing-summary">
        <span>{{ missingCount }} 条收藏尚未在本机找到原文。记录仍会保留，不会自动删除。</span>
        <button type="button" :disabled="retrying || loading" @click="retryMissing">
          {{ retrying ? "请求同步中…" : "重新检查" }}
        </button>
      </div>
      <div class="saved-list">
        <template v-for="row in rows" :key="row.id">
          <PostCard v-if="row.message" :message="row.message" />
          <div v-else class="missing-post">
            <strong>收藏的动态暂不可用</strong>
            <p>此设备尚未取得原文 · {{ row.id.slice(0, 12) }}…</p>
            <button type="button" @click="removeMissing(row.id)">取消收藏</button>
          </div>
        </template>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import PostCard from "@/components/PostCard.vue";
import { useBookmarksStore } from "@/stores/bookmarks";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore, type InboxItem } from "@/stores/messages";
import { syncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { isFeedRenderableMessage, syncedMessageRecordToInboxItem } from "@/nostr/messaging/messageViewModel";
import { resumeAccountMessageSync } from "@/services/accountMessageSync";

const props = defineProps<{ query: string }>();
const keys = useKeyStore();
const bookmarks = useBookmarksStore();
const messages = useMessagesStore();
const locallyResolved = ref<Record<string, InboxItem>>({});
const loading = ref(false);
const retrying = ref(false);
const loadError = ref("");
const refreshKey = ref(0);
let generation = 0;

const rows = computed(() => {
  if (!keys.isUnlocked || !keys.pkHex || bookmarks.loadedFor !== keys.pkHex.toLowerCase()) return [];
  const activeInbox = messages.loadedFor === keys.pkHex.toLowerCase() ? messages.inbox : [];
  const inbox = new Map(activeInbox.filter(isFeedRenderableMessage).map(item => [item.id, item]));
  const term = props.query.trim().toLocaleLowerCase();
  return [...bookmarks.records]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(bookmark => {
      const candidate = inbox.get(bookmark.messageId) || locallyResolved.value[bookmark.messageId];
      const message = candidate && isFeedRenderableMessage(candidate) ? candidate : null;
      return { id: bookmark.messageId, message };
    })
    .filter(row => !term || (row.message?.content.toLocaleLowerCase().includes(term))
      || row.id.toLocaleLowerCase().includes(term));
});
const missingCount = computed(() => rows.value.filter(row => !row.message).length);

watch(
  () => [keys.pkHex, keys.isUnlocked, bookmarks.records.map(record => record.messageId).join(","), refreshKey.value] as const,
  async ([pubkey, unlocked]) => {
    const run = ++generation;
    locallyResolved.value = {};
    loadError.value = "";
    loading.value = !!pubkey && unlocked;
    if (!pubkey || !unlocked) return;
    const account = pubkey.toLowerCase();
    const current = () => run === generation && keys.isUnlocked && keys.pkHex.toLowerCase() === account;
    try {
      await Promise.all([bookmarks.load(account), messages.load(account)]);
      if (!current()) return;
      // The inbox is a bounded recent-message cache. Read older saved posts directly
      // from the existing account-scoped encrypted repository without changing sync.
      const inboxIds = new Set(messages.inbox.map(item => item.id));
      const missingIds = bookmarks.records.map(item => item.messageId).filter(id => !inboxIds.has(id));
      for (let i = 0; i < missingIds.length; i += 20) {
        const batch = missingIds.slice(i, i + 20);
        const found = await Promise.all(batch.map(async id => {
          const record = await syncedMessageRepository.get(account, id);
          if (!record || !record.plaintext) return null;
          const message = syncedMessageRecordToInboxItem(record);
          return isFeedRenderableMessage(message) ? message : null;
        }));
        if (!current()) return;
        const next = { ...locallyResolved.value };
        batch.forEach((id, index) => { if (found[index]) next[id] = found[index]; });
        locallyResolved.value = next;
      }
    } catch {
      if (current()) loadError.value = "读取收藏失败，请重新进入或稍后重试。";
    } finally {
      if (current()) loading.value = false;
    }
  },
  { immediate: true },
);

async function retryMissing() {
  if (retrying.value || !keys.isUnlocked) return;
  retrying.value = true;
  try {
    // Request the normal sync coordinator to resume; do not open extra Relay sockets
    // or assume an old encrypted event is still available on the Relay.
    const requested = await resumeAccountMessageSync("manual");
    if (!requested) loadError.value = "当前无法发起消息同步，请检查连接。";
    refreshKey.value += 1;
  } catch {
    loadError.value = "同步请求失败，请稍后重试。";
  } finally {
    retrying.value = false;
  }
}

async function removeMissing(id: string) {
  if (!keys.isUnlocked || !bookmarks.isBookmarked(id)) return;
  try { await bookmarks.toggle(id); }
  catch { loadError.value = "取消收藏失败，请重试。"; }
}
</script>

<style scoped>
.saved-content{padding-bottom:12px}
.saved-help{margin:8px 14px 12px;color:#64748b;font-size:12px;line-height:1.5}
.saved-error{margin:8px 14px;color:#b91c1c;font-size:13px}
.saved-empty{text-align:center;padding:64px 16px;color:#94a3b8;font-size:13px}
.saved-list{display:grid;gap:12px;padding:0 10px}
.missing-summary{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 14px;padding:11px;border:1px solid #e2e8f0;border-radius:10px;color:#64748b;font-size:12px;line-height:1.5}
.missing-summary button,.missing-post button{border:0;background:#eef2f6;border-radius:7px;padding:8px;color:#334155;font:inherit;white-space:nowrap}
.missing-summary button:disabled{opacity:.55}
.missing-post{padding:16px;border:1px solid #e2e8f0;border-radius:12px;color:#334155;font-size:13px}
.missing-post p{margin:8px 0;color:#64748b;font-size:12px;overflow-wrap:anywhere}
</style>
