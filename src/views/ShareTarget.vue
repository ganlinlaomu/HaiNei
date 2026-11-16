<template>
  <main class="share-page app-page">
    <SecondaryPageHeader title="分享到海内" back-label="取消分享" back-mode="history" />
    <section v-if="loading" class="share-state" aria-live="polite">正在读取分享内容…</section>
    <section v-else-if="!share" class="share-state" aria-live="polite">
      <p>没有待分享的内容，或分享已过期。</p>
      <button type="button" class="share-primary" @click="router.replace('/')">返回首页</button>
    </section>
    <template v-else>
      <section class="share-summary" aria-label="待分享内容">
        <p v-if="share.text" class="share-text">{{ share.text }}</p>
        <ul v-if="share.files.length" class="share-files">
          <li v-for="file in share.files" :key="file.key">
            <span class="share-file-name">{{ file.name }}</span>
            <small>{{ formatDmFileSize(file.size) }}</small>
          </li>
        </ul>
        <p class="share-hint">选好友后内容会放进输入框，确认后再发送。</p>
        <div class="share-actions">
          <button type="button" class="share-primary" @click="pickerOpen = true">选择好友</button>
          <button type="button" class="share-secondary" @click="cancel">取消分享</button>
        </div>
      </section>
      <NewConversationSheet :visible="pickerOpen" title="分享给" @close="pickerOpen = false" @select="sendTo" />
    </template>
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import NewConversationSheet from "@/components/NewConversationSheet.vue";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import { formatDmFileSize } from "@/nostr/messaging/privateFile";
import { assignPendingShare, clearPendingShare, readPendingShare, type PendingShareMeta } from "@/services/shareTarget";
import { useUIStore } from "@/stores/ui";

const router = useRouter();
const ui = useUIStore();
const loading = ref(true);
const share = ref<PendingShareMeta | null>(null);
const pickerOpen = ref(false);

async function sendTo(pubkey: string) {
  pickerOpen.value = false;
  try {
    if (!(await assignPendingShare(pubkey))) {
      ui.addToast("分享已过期，请重新分享", 2200, "info");
      share.value = null;
      return;
    }
    await router.replace(`/messages/${pubkey}`);
  } catch {
    ui.addToast("无法打开聊天，请重试", 2200, "error");
  }
}

async function cancel() {
  await clearPendingShare();
  await router.replace("/");
}

onMounted(async () => {
  share.value = await readPendingShare();
  loading.value = false;
  if (share.value) pickerOpen.value = true;
});
</script>

<style scoped>
.share-page{width:100%;margin:0 auto;box-sizing:border-box;padding:0 0 calc(env(safe-area-inset-bottom) + 24px)}
.share-summary,.share-state{max-width:640px;margin:0 auto;box-sizing:border-box;padding-right:16px;padding-left:16px}
.share-state{padding-top:56px;padding-bottom:56px;color:var(--fg-64748b);text-align:center}
.share-summary{display:flex;flex-direction:column;gap:12px;padding-top:16px;padding-bottom:16px}
.share-text{margin:0;padding:12px 14px;border-radius:12px;background:var(--bg-f1f5f9);color:var(--fg-0f1419);white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto}
.share-files{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.share-files li{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border:1px solid var(--bd-e2e8f0);border-radius:10px;color:var(--fg-0f1419)}
.share-file-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.share-files small{color:var(--fg-64748b)}
.share-hint{margin:0;color:var(--fg-64748b);font-size:13px}
.share-actions{display:flex;gap:10px}
.share-primary,.share-secondary{min-height:44px;padding:0 20px;border-radius:22px;font:inherit;font-weight:700}
.share-primary{border:0;background:#1687e8;color:#fff}
.share-secondary{border:1px solid var(--bd-cbd5e1);background:var(--bg-fff);color:var(--fg-334155)}
</style>
