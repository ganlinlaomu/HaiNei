<template>
  <div class="recommendation-picker-overlay" @click.self="emit('close')">
    <section class="recommendation-picker" role="dialog" aria-modal="true" aria-label="推荐朋友">
      <header class="recommendation-picker-header">
        <h2>推荐朋友</h2>
        <button type="button" aria-label="关闭推荐朋友" @click="emit('close')">×</button>
      </header>
      <template v-if="selected">
        <div class="recommendation-send-preview">
          <span class="recommendation-eyebrow">确认推荐的名片</span>
          <div class="recommendation-identity">
            <ProfileAvatar :pubkey="selected.pubkey" :size="44" />
            <div class="recommendation-identity-text">
              <strong>{{ selected.nickname || "未设置昵称" }}</strong>
              <small>{{ shortNpub(selected.pubkey, 13, 8) }}</small>
            </div>
          </div>
          <p class="recommendation-bio">{{ selected.bio || "暂无简介" }}</p>
        </div>
        <p class="recommendation-privacy-note">确认后会将该好友本人设置的昵称和简介作为名片快照，以加密私信发送给 {{ peerName }}。对方即使还不是他的好友，也能看到这些资料。</p>
        <div class="recommendation-confirm-actions">
          <button type="button" @click="emit('back')">返回选择</button>
          <button type="button" class="recommendation-confirm-send" @click="emit('confirm')">确认发送</button>
        </div>
      </template>
      <template v-else>
        <p class="recommendation-picker-help">选择一位好友，将其昵称、简介和公钥加密发送给 {{ peerName }}。</p>
        <input v-model.trim="query" class="recommendation-search" type="search" autocomplete="off" placeholder="搜索好友" aria-label="搜索要推荐的好友" />
        <div class="recommendation-picker-list">
          <button v-for="friend in candidates" :key="friend.pubkey" class="recommendation-picker-item" type="button" @click="emit('select', friend.pubkey)">
            <ProfileAvatar :pubkey="friend.pubkey" :local-name="friend.name" :size="40" />
            <span class="recommendation-picker-identity">
              <strong>{{ friend.name }}</strong>
              <small>{{ friend.bio || "暂无简介" }}</small>
            </span>
            <span class="recommendation-picker-arrow" aria-hidden="true">→</span>
          </button>
          <p v-if="candidates.length === 0" class="recommendation-picker-empty">没有可推荐的好友</p>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import type { FriendRecommendation } from "@/nostr/messaging/friendRecommendation";
import { shortNpub } from "@/utils/nostrQr";

/** Sheet for choosing a friend to recommend, then confirming the card snapshot. */
defineProps<{
  peerName: string;
  selected: FriendRecommendation | null;
  candidates: Array<{ pubkey: string; name: string; bio: string }>;
}>();
const query = defineModel<string>("query", { required: true });
const emit = defineEmits<{ close: []; select: [pubkey: string]; back: []; confirm: [] }>();
</script>

<style scoped>
.recommendation-eyebrow{font-size:11px;font-weight:700;color:var(--fg-536471)}
.recommendation-bio{margin:0;color:var(--fg-536471);font-size:12px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5;overflow:hidden}
.recommendation-identity{display:flex;align-items:center;gap:10px;min-width:0}
.recommendation-identity-text{display:flex;min-width:0;flex-direction:column;gap:4px}
.recommendation-identity-text strong{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recommendation-identity-text small{color:var(--fg-657786);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recommendation-picker-overlay{position:fixed;z-index:30;inset:0;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.36)}
.recommendation-picker{width:100%;max-width:640px;max-height:min(76vh,640px);display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding:18px 18px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:var(--bg-fff);box-shadow:0 -14px 45px rgba(15,23,42,.12)}
.recommendation-picker-header{display:flex;justify-content:space-between;align-items:center}
.recommendation-picker-header h2{font-size:18px;margin:0}.recommendation-picker-header button{width:34px;height:34px;border:0;background:var(--bg-f1f5f9);border-radius:50%;font-size:24px;color:var(--fg-475569)}
.recommendation-picker-help{margin:0;color:var(--fg-64748b);font-size:12px;line-height:1.5}
.recommendation-search{width:100%;min-height:42px;box-sizing:border-box;padding:0 13px;border:1px solid var(--bd-e2e8f0);border-radius:11px;background:var(--bg-f8fafc);font:inherit;font-size:16px;outline-offset:2px}
.recommendation-picker-list{min-height:64px;overflow:auto;overscroll-behavior:contain}
.recommendation-picker-item{display:flex;width:100%;min-height:64px;align-items:center;gap:11px;padding:8px 2px;border:0;border-bottom:1px solid var(--bd-f1f5f9);background:var(--bg-fff);text-align:left;color:var(--fg-0f1419);font-size:14px}
.recommendation-picker-identity{display:flex;min-width:0;flex:1;flex-direction:column;gap:3px}.recommendation-picker-identity strong{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.recommendation-picker-identity small{color:var(--fg-64748b);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recommendation-send-preview{display:flex;flex-direction:column;gap:11px;border:1px solid var(--bd-e2e8f0);border-radius:15px;padding:14px}
.recommendation-privacy-note{color:var(--fg-64748b);font-size:12px;line-height:1.6;margin:0}
.recommendation-confirm-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.recommendation-confirm-actions button{min-height:44px;border:1px solid var(--bd-cbd5e1);border-radius:12px;background:var(--bg-fff);color:var(--fg-334155);font-weight:650;font:inherit}.recommendation-confirm-actions .recommendation-confirm-send{background:#1687e8;border-color:#1687e8;color:#fff}
.recommendation-picker-arrow{color:var(--fg-94a3b8)}.recommendation-picker-empty{padding:16px;text-align:center;color:var(--fg-64748b);font-size:13px}
</style>
