<template>
  <main class="saved-page">
    <header class="saved-header">
      <button type="button" aria-label="返回" @click="router.back()">‹</button>
      <h1>已收藏</h1>
      <span></span>
    </header>
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
.saved-page{max-width:720px;margin:0 auto;padding:0 10px calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px)}
.saved-header{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;min-height:54px;background:rgba(248,250,252,.96);border-bottom:1px solid #e2e8f0}.saved-header button{width:44px;height:44px;border:0;background:transparent;color:#334155;font-size:30px}.saved-header h1{margin:0;text-align:center;font-size:17px}.privacy-note{margin:12px 4px;color:#64748b;font-size:12px}.saved-list{display:grid;gap:12px}.empty-state{padding:64px 16px;text-align:center;color:#94a3b8}
</style>
