<template>
  <main ref="container" class="settings-container app-page">
    <header class="primary-page-header"><h1 class="primary-page-title">我的</h1></header>
    <div class="page-pull-indicator" :style="{ height: pullDistance + 'px' }" role="status">
      {{ refreshing ? "正在更新…" : pullDistance >= 60 ? "松开刷新" : "↓ 下拉刷新" }}
    </div>
    <section v-if="!hasAccount" class="card">
      <p class="small">当前未登录。</p>
      <button class="btn btn-primary" type="button" @click="router.push('/login')">前往登录</button>
    </section>
    <section v-else class="settings-card">
      <header class="my-profile-summary">
        <button class="profile-avatar-link" type="button" aria-label="查看我的个人资料" @click="openOwnProfile">
          <ProfileAvatar :pubkey="keyStore.pkHex" :local-name="nickname" :size="56" />
        </button>
        <span><strong>{{ nickname }}</strong><span class="pubkey-row"><small>{{ shortPk }}</small><button class="copy-pubkey" type="button" aria-label="复制公钥" title="复制公钥" @click="copyPubkey"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button><button class="copy-pubkey" type="button" aria-label="打开我的二维码" title="打开我的二维码" @click="showMyQr = true"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z"/></svg></button></span></span>
      </header>
      <button class="top-level-row" type="button" @pointerdown="loadProfileView" @focus="loadProfileView" @click="openOwnProfile"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg></span><strong>我的资料</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @pointerdown="loadPrivateSpaceView" @focus="loadPrivateSpaceView" @click="openPrivateSpace"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 4h12v16H6V6a2 2 0 0 1 2-2Z"/><path d="M9 9h8M9 13h8M9 17h5"/></svg></span><span class="space-row-label"><strong>私人空间</strong><small>收藏 · 笔记 · 待办</small></span></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @click="router.push('/books')"><span class="row-main"><span class="row-icon" aria-hidden="true">📚</span><span class="space-row-label"><strong>电子书</strong><small>搜书 · 下载 · 离线阅读</small></span></span><span class="row-chevron" aria-hidden="true">›</span></button>
      <button class="top-level-row" type="button" @pointerdown="preloadSystemSettings" @focus="preloadSystemSettings" @click="openSystemSettings"><span class="row-main"><span class="row-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg></span><strong>设置</strong></span><span class="row-chevron" aria-hidden="true">›</span></button>
    </section>
    <MyQrCodeSheet :open="showMyQr" :pubkey="keyStore.pkHex" :nickname="nickname" @close="showMyQr = false" />
  </main>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ProfileAvatar from "@/components/ProfileAvatar.vue";
import MyQrCodeSheet from "@/components/MyQrCodeSheet.vue";
import { useKeyStore } from "@/stores/keys";
import { useProfilesStore } from "@/stores/profiles";
import { useUIStore } from "@/stores/ui";
import { pubkeyToNpub, shortNpub } from "@/utils/nostrQr";
import { loadProfileView, loadSystemSettingsView, loadPrivateSpaceView } from "@/router/lazyViews";
import { runAfterFirstPaint, runWhenIdle } from "@/utils/bottomTabActivation";
import { usePullToRefresh } from "@/components/usePullToRefresh";
import { resumeAccountMessageSync } from "@/services/accountMessageSync";

const keyStore = useKeyStore();
const profiles = useProfilesStore();
const ui = useUIStore();
const router = useRouter();
const showMyQr = ref(false);
const { container, pullDistance, refreshing } = usePullToRefresh({ onRefresh: async () => {
  if (keyStore.pkHex && keyStore.isUnlocked) await resumeAccountMessageSync("manual");
} });

const hasAccount = computed(() => !!keyStore.pkHex);
const nickname = computed(() => profiles.getProfile(keyStore.pkHex)?.nickname?.trim() || "未设置昵称");
const shortPk = computed(() => shortNpub(keyStore.pkHex));

function preloadSystemSettings() {
  void loadSystemSettingsView();
}

function openSystemSettings() {
  preloadSystemSettings();
  void router.push("/settings/system");
}

function openOwnProfile() {
  void loadProfileView();
  if (keyStore.pkHex) void router.push(`/profile/${keyStore.pkHex}`);
}

function openPrivateSpace() {
  void loadPrivateSpaceView();
  void router.push("/settings/private-space");
}

onMounted(() => {
  // The Settings hub is already local. Warm likely next screens after first
  // paint and only while idle so navigation remains responsive.
  runAfterFirstPaint(() => {
    preloadSystemSettings();
    runWhenIdle(() => {
      void loadProfileView();
    }, 800);
  });
});

async function copyPubkey() {
  if (!keyStore.pkHex) return;
  try {
    await navigator.clipboard.writeText(pubkeyToNpub(keyStore.pkHex));
    ui.addToast("已复制 npub 公钥", 1_800, "success");
  } catch {
    ui.addToast("复制失败，请稍后重试", 2_000, "error");
  }
}
</script>

<style scoped>
.settings-container{position:relative;overscroll-behavior:contain;width:100%;min-height:100vh;margin:0 auto;padding:0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px);box-sizing:border-box;background:var(--bg-fff);color:var(--fg-0f1419)}
.card{padding:16px;border:1px solid var(--bd-e8edf3);box-shadow:0 2px 8px rgba(15,23,42,.035)}
.settings-card{width:100%;padding:0;background:var(--bg-fff);overflow:hidden}
.my-profile-summary{display:flex;min-height:88px;align-items:center;gap:13px;padding:15px 16px}
.profile-avatar-link{display:grid;padding:0;border:0;border-radius:50%;background:transparent;place-items:center;cursor:pointer}
.profile-avatar-link:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.my-profile-summary>span{display:grid;min-width:0;gap:4px}
.my-profile-summary strong{overflow:hidden;color:var(--fg-172033);font-size:1.05rem;text-overflow:ellipsis;white-space:nowrap}
.my-profile-summary small{color:var(--fg-64748b);font-size:.78rem}
.pubkey-row{display:flex;align-items:center;gap:5px}
.copy-pubkey{display:grid;width:28px;height:28px;padding:5px;border:0;border-radius:7px;background:transparent;color:var(--fg-64748b);place-items:center;cursor:pointer}
.copy-pubkey:active{background:var(--bg-eef2f6)}
.copy-pubkey svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
h2,p{margin-top:0} h2{margin-bottom:4px}
.top-level-row{display:flex;width:100%;min-height:64px;align-items:center;justify-content:space-between;gap:14px;padding:13px 16px;border:0;border-top:1px solid var(--bd-eff1f3);background:var(--bg-fff);color:var(--fg-1e293b);text-align:left;cursor:pointer}.top-level-row:active{background:var(--bg-f7f9f9)}
.row-main{display:flex;min-width:0;align-items:center;gap:12px}
.row-main strong{font-size:.94rem;font-weight:600}
.row-icon{display:grid;width:24px;height:24px;flex:0 0 24px;place-items:center;color:var(--fg-475569)}
.row-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.row-chevron{flex:0 0 auto;color:var(--fg-94a3b8);font-size:22px}
.small{color:var(--fg-64748b);font-size:.82rem}
.btn{min-height:42px;padding:0 16px;border:0;border-radius:10px;cursor:pointer}
.btn-primary{background:#2563eb;color:#fff}
.space-row-label{display:flex;flex-direction:column;gap:3px;min-width:0}
.space-row-label small{color:var(--fg-64748b);font-size:12px;font-weight:400}
</style>
