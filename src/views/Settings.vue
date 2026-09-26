<template>
  <main class="settings-container app-page">
    <section v-if="!hasAccount" class="card">
      <h2>我的</h2>
      <p class="small">当前未登录。</p>
      <button class="btn btn-primary" type="button" @click="router.push('/login')">前往登录</button>
    </section>
    <section v-else class="settings-card">
      <header class="my-profile-summary">
        <ProfileAvatar :pubkey="keyStore.pkHex" :local-name="nickname" :size="56" />
        <span><strong>{{ nickname }}</strong><span class="pubkey-row"><small>{{ shortPk }}</small><button class="copy-pubkey" type="button" aria-label="复制公钥" title="复制公钥" @click="copyPubkey"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></span></span>
      </header>
      <button class="top-level-row" type="button" @click="router.push('/settings/profile')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><strong>我的资料</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/settings/saved')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg></span><strong>已收藏</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/friends')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0M14 15.5a5 5 0 0 1 7 4.5"/></svg></span><strong>好友 / 好友分组</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/settings/system')"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></span><strong>设置</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
    </section>
  </main>
</template>
<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";

const keyStore = useKeyStore();
const profiles = useProfilesStore();
const ui = useUIStore();
const router = useRouter();

const hasAccount = computed(() => !!keyStore.pkHex);
const nickname = computed(() => profiles.getProfile(keyStore.pkHex)?.nickname?.trim() || "未设置昵称");
const shortPk = computed(() => keyStore.pkHex ? `${keyStore.pkHex.slice(0, 8)}...${keyStore.pkHex.slice(-6)}` : "");

async function copyPubkey() {
  if (!keyStore.pkHex) return;
  try {
    await navigator.clipboard.writeText(keyStore.pkHex);
    ui.addToast("已复制公钥", 1_800, "success");
  } catch {
    ui.addToast("复制失败，请稍后重试", 2_000, "error");
  }
}
</script>

<style scoped>
.settings-container{width:100%;min-height:100%;margin:0 auto;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px);box-sizing:border-box;background:#fff;color:#0f1419}
.card{padding:16px;border:1px solid #e8edf3;box-shadow:0 2px 8px rgba(15,23,42,.035)}
.settings-card{width:100%;padding:0;background:#fff;overflow:hidden}
.my-profile-summary{display:flex;min-height:88px;align-items:center;gap:13px;padding:15px 16px}
.my-profile-summary>span{display:grid;min-width:0;gap:4px}
.my-profile-summary strong{overflow:hidden;color:#172033;font-size:1.05rem;text-overflow:ellipsis;white-space:nowrap}
.my-profile-summary small{color:#64748b;font-size:.78rem}
.pubkey-row{display:flex;align-items:center;gap:5px}
.copy-pubkey{display:grid;width:28px;height:28px;padding:5px;border:0;border-radius:7px;background:transparent;color:#64748b;place-items:center;cursor:pointer}
.copy-pubkey:active{background:#eef2f6}
.copy-pubkey svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
h2,p{margin-top:0} h2{margin-bottom:4px}
.top-level-row{display:flex;width:100%;min-height:64px;align-items:center;justify-content:space-between;gap:14px;padding:13px 16px;border:0;border-top:1px solid #eff1f3;background:#fff;color:#1e293b;text-align:left;cursor:pointer}.top-level-row:active{background:#f7f9f9}
.row-main{display:flex;min-width:0;align-items:center;gap:12px}
.row-main strong{font-size:.94rem;font-weight:600}
.row-icon{display:grid;width:24px;height:24px;flex:0 0 24px;place-items:center;color:#475569}
.row-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.row-chevron{flex:0 0 auto;color:#94a3b8;font-size:22px}
.small{color:#64748b;font-size:.82rem}
.btn{min-height:42px;padding:0 16px;border:0;border-radius:10px;cursor:pointer}
.btn-primary{background:#2563eb;color:#fff}
</style>
