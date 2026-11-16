<template>
  <main class="shared-media-page app-page">
    <SecondaryPageHeader :title="`与 ${displayName} 的聊天内容`" back-label="返回聊天" back-mode="history" />
    <nav class="media-tabs" role="tablist" aria-label="内容类型">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}<span v-if="counts[tab.key]" class="tab-count">{{ counts[tab.key] }}</span>
      </button>
    </nav>

    <section class="media-body" :aria-busy="loading">
      <p v-if="!loading && !counts[activeTab]" class="media-empty">{{ emptyText }}</p>

      <template v-if="activeTab === 'images'">
        <template v-for="group in imageGroups" :key="group.label">
          <h3 class="month-label">{{ group.label }}</h3>
          <div class="image-grid">
            <div v-for="item in group.items" :key="item.key" class="image-cell">
              <PostImagePreview :content="item.markdown" :show-all="true" alt-text="聊天图片" />
            </div>
          </div>
        </template>
      </template>

      <template v-else-if="activeTab === 'videos'">
        <template v-for="group in videoGroups" :key="group.label">
          <h3 class="month-label">{{ group.label }}</h3>
          <div class="video-list">
            <article v-for="item in group.items" :key="item.id" class="video-item">
              <VideoPlayer :video-data="videoData(item.media)" />
              <button type="button" class="locate-link" @click="locate(item.id)">{{ itemMeta(item) }} · 在聊天中查看</button>
            </article>
          </div>
        </template>
      </template>

      <template v-else-if="activeTab === 'files'">
        <template v-for="group in fileGroups" :key="group.label">
          <h3 class="month-label">{{ group.label }}</h3>
          <ul class="row-list">
            <li v-for="item in group.items" :key="item.id" class="row-item">
              <DmFileMessage :media="item.media" />
              <button type="button" class="locate-link" @click="locate(item.id)">{{ itemMeta(item) }} · 在聊天中查看</button>
            </li>
          </ul>
        </template>
      </template>

      <template v-else>
        <template v-for="group in linkGroups" :key="group.label">
          <h3 class="month-label">{{ group.label }}</h3>
          <ul class="row-list">
            <li v-for="item in group.items" :key="item.key" class="row-item link-row">
              <a :href="item.url" target="_blank" rel="noopener noreferrer nofollow" class="link-main">
                <strong>{{ item.host }}</strong>
                <span>{{ item.url }}</span>
              </a>
              <button type="button" class="locate-link" @click="locate(item.id)">{{ itemMeta(item) }} · 在聊天中查看</button>
            </li>
          </ul>
        </template>
      </template>

      <p v-if="loading" class="media-loading" role="status">正在读取本机聊天记录…</p>
      <p v-else-if="truncated" class="media-loading">只显示最近 {{ MAX_MESSAGES }} 条消息里的内容</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import PostImagePreview from "@/components/PostImagePreview.vue";
import DmFileMessage from "@/components/DmFileMessage.vue";
import { collectSharedMedia, type SharedMediaItems } from "@/utils/sharedMedia";
import type { PrivateVideoMedia } from "@/nostr/messaging/privateMedia";
import type { VideoData } from "@/utils/videoUtils";
import { useDirectMessagesStore } from "@/stores/directMessages";
import { useFriendsStore } from "@/stores/friends";
import { useFriendshipsStore } from "@/stores/friendships";
import { useKeyStore } from "@/stores/keys";
import { privateProfileDisplayName, useProfilesStore } from "@/stores/profiles";
import { loadAccountStoresOnce, waitForFirstPaint } from "@/utils/bottomTabActivation";

const VideoPlayer = defineAsyncComponent(() => import("@/components/VideoPlayer.vue"));

type TabKey = keyof SharedMediaItems;
const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "images", label: "图片" },
  { key: "videos", label: "视频" },
  { key: "files", label: "文件" },
  { key: "links", label: "链接" },
];
const MAX_MESSAGES = 5000;

const route = useRoute();
const router = useRouter();
const keys = useKeyStore();
const directMessages = useDirectMessagesStore();
const friends = useFriendsStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();

const peerPubkey = computed(() => String(route.params.pubkey || "").trim().toLowerCase());
const localName = computed(() => friends.list.find(friend => friend.pubkey === peerPubkey.value)?.name);
const displayName = computed(() => privateProfileDisplayName(profiles.getProfile(peerPubkey.value)?.nickname, peerPubkey.value, localName.value));
const activeTab = ref<TabKey>("images");
const loading = ref(true);
const truncated = ref(false);
const media = ref<SharedMediaItems>({ images: [], videos: [], files: [], links: [] });
let generation = 0;

const counts = computed(() => ({
  images: media.value.images.length,
  videos: media.value.videos.length,
  files: media.value.files.length,
  links: media.value.links.length,
}));
const emptyText = computed(() => ({
  images: "还没有聊天图片",
  videos: "还没有聊天视频",
  files: "还没有聊天文件",
  links: "还没有聊天链接",
})[activeTab.value]);

function monthLabel(seconds: number) {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}
function groupByMonth<T extends { created_at: number }>(items: T[]) {
  const groups: Array<{ label: string; items: T[] }> = [];
  for (const item of items) {
    const label = monthLabel(item.created_at);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
const imageGroups = computed(() => groupByMonth(media.value.images));
const videoGroups = computed(() => groupByMonth(media.value.videos));
const fileGroups = computed(() => groupByMonth(media.value.files));
const linkGroups = computed(() => groupByMonth(media.value.links));

function itemMeta(item: { created_at: number; own: boolean }) {
  const date = new Date(item.created_at * 1000);
  return `${item.own ? "你" : displayName.value} · ${date.getMonth() + 1}月${date.getDate()}日`;
}
const videoData = (value: PrivateVideoMedia): VideoData => ({ type: "video", url: value.encryptedRef, provider: "Encrypted", embedUrl: value.encryptedRef });

function locate(messageId: string) {
  void router.push({ path: `/messages/${peerPubkey.value}`, query: { focus: messageId } });
}

async function load() {
  const current = ++generation;
  const account = keys.pkHex;
  const peer = peerPubkey.value;
  loading.value = true;
  truncated.value = false;
  media.value = { images: [], videos: [], files: [], links: [] };
  if (!account || !peer || peer === account) {
    loading.value = false;
    return;
  }
  const stale = () => current !== generation || account !== keys.pkHex || peer !== peerPubkey.value;
  try {
    await waitForFirstPaint();
    await loadAccountStoresOnce(account, [friendships, friends, profiles]);
    if (stale()) return;
    let page = await directMessages.loadPeerHistoryPage(peer);
    let scanned = 0;
    const collected: SharedMediaItems = { images: [], videos: [], files: [], links: [] };
    while (!stale()) {
      scanned += page.items.length;
      const next = collectSharedMedia(page.items, account);
      collected.images.push(...next.images);
      collected.videos.push(...next.videos);
      collected.files.push(...next.files);
      collected.links.push(...next.links);
      // Pages arrive oldest-first within each page; show newest first overall.
      media.value = {
        images: [...collected.images].sort(newestFirst),
        videos: [...collected.videos].sort(newestFirst),
        files: [...collected.files].sort(newestFirst),
        links: [...collected.links].sort(newestFirst),
      };
      if (page.exhausted || !page.cursor) break;
      if (scanned >= MAX_MESSAGES) {
        truncated.value = true;
        break;
      }
      page = await directMessages.loadPeerHistoryPage(peer, page.cursor);
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
function newestFirst(left: { created_at: number; key: string }, right: { created_at: number; key: string }) {
  return right.created_at - left.created_at || right.key.localeCompare(left.key);
}

onMounted(load);
watch([() => keys.pkHex, peerPubkey], load);
onBeforeUnmount(() => { generation += 1; });
</script>

<style scoped>
.shared-media-page{width:100%;max-width:760px;margin:0 auto;box-sizing:border-box;padding:0 0 calc(env(safe-area-inset-bottom) + 24px)}
.media-tabs{position:sticky;top:0;z-index:5;display:flex;gap:4px;padding:6px 12px;border-bottom:1px solid var(--bd-eff1f3);background:var(--bg-fff)}
.media-tabs button{flex:1 1 0;min-height:40px;border:0;border-radius:999px;background:transparent;color:var(--fg-536471);font:inherit;font-size:15px;font-weight:600}
.media-tabs button.active{background:var(--bg-e8f4fd);color:var(--fg-1687e8)}
.tab-count{margin-left:4px;font-size:12px;font-weight:500;opacity:.8}
.media-body{padding:0 12px}
.month-label{margin:16px 4px 8px;color:var(--fg-536471);font-size:13px;font-weight:600}
.image-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}
@media (min-width:600px){.image-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.image-cell{position:relative;aspect-ratio:1/1;overflow:hidden;border-radius:4px;background:var(--bg-eff3f4)}
.image-cell :deep(.post-image-preview),.image-cell :deep(.carousel-shell),.image-cell :deep(.carousel),.image-cell :deep(.carousel-slide){width:100%;height:100%;margin:0;aspect-ratio:auto!important;border-radius:0}
.image-cell :deep(.carousel-image){width:100%;height:100%;object-fit:cover}
.video-list{display:flex;flex-direction:column;gap:14px}
.video-item{display:flex;flex-direction:column;gap:6px}
.row-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.row-item{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:6px 4px;border-radius:12px;background:var(--bg-f7f9f9)}
.link-main{display:flex;min-width:0;max-width:100%;flex-direction:column;gap:2px;padding:6px 8px;color:var(--fg-0f1419);text-decoration:none}
.link-main strong{font-size:14px}
.link-main span{overflow:hidden;color:var(--fg-1687e8);font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.locate-link{min-height:32px;padding:0 8px;border:0;background:transparent;color:var(--fg-64748b);font:inherit;font-size:12px;text-align:left}
.media-empty,.media-loading{margin:0;padding:40px 16px;color:var(--fg-94a3b8);text-align:center;font-size:14px}
.media-loading{padding:16px}
</style>
