<template>
  <main class="saved-page app-page">
    <SecondaryPageHeader title="已收藏" back-label="返回我的" />
    <p class="privacy-note">收藏仅保存在当前设备和账号中</p>
    <section v-if="savedPosts.length" class="saved-list">
      <PostCard v-for="post in savedPosts" :key="post.id" :message="post" />
    </section>
    <div v-else class="empty-state">{{ bookmarks.records.length ? "收藏的动态已不在本地" : "暂无收藏" }}</div>
  </main>
</template>

<script setup lang="ts">
import { computed, watch } from "vue";
import { useRouter } from "vue-router";
import PostCard from "@/components/PostCard.vue";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { useBookmarksStore } from "@/stores/bookmarks";
import { useKeyStore } from "@/stores/keys";
import { useMessagesStore } from "@/stores/messages";
import type { InboxItem } from "@/stores/messages";

const router = useRouter();
const keys = useKeyStore();
const bookmarks = useBookmarksStore();
const messages = useMessagesStore();

const savedPosts = computed(() => bookmarks.records
  .map(bookmark => messages.inbox.find(message => message.id === bookmark.messageId))
  .filter((message): message is InboxItem => !!message));

watch(() => keys.pkHex, async account => {
  if (!account) return;
  await Promise.all([bookmarks.load(account), messages.load(account)]);
}, { immediate: true });
</script>

<style scoped>
.saved-page{width:100%;margin:0 auto;padding:0 10px calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.privacy-note{margin:12px 4px;color:#64748b;font-size:12px}.saved-list{display:grid;gap:12px}.empty-state{padding:64px 16px;text-align:center;color:#94a3b8}
</style>
