<template>
  <main class="settings-container system-settings-page app-page">
    <SecondaryPageHeader title="设置" back-label="返回我的" />
    <div v-if="settings.syncing" class="sync-status">{{ settings.syncStatusText || "正在同步加密设置…" }}</div>
    <div v-else-if="settings.syncError" class="sync-status sync-warning">{{ settings.syncError }}</div>
    <div v-else-if="settings.lastRelaySyncTimestamp || settings.lastMediaSyncTimestamp" class="sync-status sync-ok">
      已同步设置：<span v-if="settings.lastRelaySyncTimestamp">Relay {{ formatSyncTimestamp(settings.lastRelaySyncTimestamp) }}</span><span v-if="settings.lastRelaySyncTimestamp && settings.lastMediaSyncTimestamp"> · </span><span v-if="settings.lastMediaSyncTimestamp">Media {{ formatSyncTimestamp(settings.lastMediaSyncTimestamp) }}</span>
    </div>
    <section class="system-content">
      <ConnectionSection :runtime="relayRuntime" />

      <MediaSection />

      <PrivacySection />

      <BackgroundLockSection v-if="keyStore.credentialMode === 'password' || keyStore.credentialMode === 'passkey'" />

      <AppearanceSection />

      <DataSaverSection />

      <AndroidUpdateSection v-if="isNativeAndroid" />

      <PushSection :is-native-app="isNativeApp" />

      <CacheSection />

      <DiagnosticsSection :runtime="relayRuntime" />

      <details v-if="keyStore.loginMethod === 'private-key'" class="technical-section account-section security-section">
        <summary class="section-heading account-heading">
          <div class="section-heading-main">
            <span class="section-heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg>
            </span>
            <div>
              <h3>账号安全</h3>
              <p>{{ accountProtectionText }}</p>
            </div>
          </div>
        </summary>
        <div class="account-panel">
          <div class="account-control-card">
            <div v-if="keyStore.isEncrypted" class="account-setting-row biometric-row">
              <div class="privacy-copy">
                <strong>{{ biometricLabel }} 登录保护</strong>
                <span class="small">{{ biometricEnabled ? "已开启，重新打开时需验证后进入海内" : biometricSupported ? `开启后用 ${biometricLabel}、设备锁或通行密钥保护登录` : "当前环境未通过预检，仍可尝试启用" }}</span>
              </div>
              <button
                class="account-inline-action"
                type="button"
                :disabled="biometricBusy || securityBusy"
                @click="toggleBiometricUnlock"
              >
                {{ biometricBusy ? "处理中…" : biometricEnabled ? "关闭" : "启用" }}
              </button>
            </div>

            <div v-if="googleBackupAvailable" class="account-setting-row">
              <div class="privacy-copy">
                <strong>备份到 Google 账号</strong>
                <span class="small">先在手机上加密再保存，Google 和海内都看不到内容。换手机时登录同一个 Google 账号即可恢复。</span>
              </div>
              <button class="account-inline-action" type="button" :disabled="securityBusy" @click="beginGoogleBackup">备份</button>
            </div>

            <div class="account-setting-row key-row">
              <div class="privacy-copy">
                <strong>私钥（高级）</strong>
                <span class="small">任何人拿到私钥都能读你的消息、冒充你。只在需要自己保存时查看。</span>
                <code v-if="revealedNsec" class="revealed-key">{{ revealedNsec }}</code>
              </div>
              <div class="key-row-actions">
                <button v-if="!revealedNsec" class="account-inline-action" type="button" :disabled="securityBusy" @click="revealPrivateKey">查看</button>
                <template v-else>
                  <button class="account-inline-action" type="button" @click="copyPrivateKey">复制</button>
                  <button class="account-inline-action" type="button" @click="revealedNsec = ''">隐藏</button>
                </template>
              </div>
            </div>

            <fieldset class="protection-modes" :disabled="securityBusy">
              <legend>登录保护方式</legend>
              <label class="protection-mode">
                <input type="radio" name="login-protection" :checked="protectionChoice === 'device'" @change="chooseProtection('device')" />
                <span><strong>在这台手机上保持登录</strong><small>打开即可进入，可再叠加 {{ biometricLabel }} 保护（推荐）</small></span>
              </label>
              <label class="protection-mode">
                <input type="radio" name="login-protection" :checked="protectionChoice === 'password'" @change="chooseProtection('password')" />
                <span><strong>使用本地保护密码</strong><small>每次打开都要输入密码；密码只用于本机加密，不会上传</small></span>
              </label>
              <form v-if="protectionChoice === 'password' && keyStore.credentialMode !== 'password'" class="password-setup" @submit.prevent="applyLocalPassword">
                <input v-model="newLocalPassword" class="input" type="password" autocomplete="new-password" placeholder="至少 8 位" aria-label="本地保护密码" />
                <input v-model="confirmLocalPassword" class="input" type="password" autocomplete="new-password" placeholder="再次输入密码" aria-label="确认本地保护密码" />
                <button class="btn btn-primary" type="submit">{{ securityBusy ? "保存中…" : "使用此密码" }}</button>
              </form>
              <label class="protection-mode">
                <input type="radio" name="login-protection" :checked="protectionChoice === 'session'" @change="chooseProtection('session')" />
                <span><strong>仅此次登录</strong><small>不在这台手机上保存登录凭证，关闭应用后需要重新输入私钥</small></span>
              </label>
            </fieldset>
          </div>
        </div>
      </details>

      <details class="technical-section account-section identity-section">
        <summary class="section-heading account-heading">
          <div class="section-heading-main">
            <span class="section-heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>
            </span>
            <div>
              <h3>账户</h3>
              <p>{{ nickname }} · {{ shortPk }} · {{ accountProtectionText }}</p>
            </div>
          </div>
        </summary>
        <div class="account-panel">
          <div class="account-control-card">
            <div v-if="keyStore.loginMethod === 'nip46'" class="account-setting-row biometric-row">
              <div class="privacy-copy">
                <strong>远程签名器（Beta）</strong>
                <span class="small">{{ keyStore.remoteSignerConnected ? "已连接 · 发帖、评论、私信与加密操作由远程签名器授权" : "当前未连接 · 发送时会自动重连，本机缓存仍可浏览" }}</span>
              </div>
              <button
                class="account-inline-action"
                type="button"
                :disabled="remoteSignerBusy || keyStore.remoteSignerConnected"
                @click="reconnectRemoteSigner"
              >
                {{ remoteSignerBusy ? "连接中…" : keyStore.remoteSignerConnected ? "已连接" : "重新连接" }}
              </button>
            </div>

            <div v-if="keyStore.loginMethod === 'private-key' && keyStore.isUnlocked" class="account-setting-row biometric-row">
              <div class="privacy-copy">
                <strong>添加设备</strong>
                <span class="small">在新手机上选「我已有账号 › 用另一台手机扫码」，再用这台手机扫描它的二维码</span>
              </div>
              <button type="button" class="account-inline-action" @click="router.push('/device-pair')">开始扫码</button>
            </div>

            <div class="account-actions-row">
              <button class="account-action-button account-action-secondary" type="button" @click="switchAccount">
                切换账号
              </button>
              <button class="account-action-button account-action-primary" type="button" @click="addAccount">
                添加账号
              </button>
            </div>

            <div class="account-danger-row">
              <button class="account-danger-button" type="button" @click="doLogout">
                退出登录
              </button>
            </div>
          </div>
        </div>
      </details>

    </section>

    <AccountSwitcherSheet
      :open="showAccountSwitcher"
      :accounts="keyStore.accounts"
      :current-pubkey="keyStore.pkHex"
      :busy-pubkey="switchingTo"
      @close="showAccountSwitcher = false"
      @select="switchToAccount"
      @add="addAccount"
    />
    <GoogleRecoveryPanel
      v-if="googleBackupAvailable && googleBackupMounted"
      ref="googleBackupPanel"
      :client-id="googleClientId"
      mode="backup"
      :backup-secret-hex="keyStore.skHex"
      backup-action-label="完成备份"
      hide-trigger
      @backed-up="ui.addToast('已备份到 Google 账号', 2_200, 'success')"
      @error="message => ui.addToast(message, 2_500, 'error')"
    />

    <footer class="version-footer" aria-label="当前应用版本">
      HaiNei v{{ APP_VERSION }} · {{ APP_UPDATE_SUMMARY }}
    </footer>
  </main>
</template>
<script setup lang="ts">
import { APP_VERSION } from "@/db/dexie";
import { APP_UPDATE_SUMMARY } from "@/appRelease";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import AccountSwitcherSheet from "@/components/AccountSwitcherSheet.vue";
import ConnectionSection from "./settings/ConnectionSection.vue";
import MediaSection from "./settings/MediaSection.vue";
import DiagnosticsSection from "./settings/DiagnosticsSection.vue";
import { useRelayRuntimeStatus } from "./settings/useRelayRuntimeStatus";
import PrivacySection from "./settings/PrivacySection.vue";
import BackgroundLockSection from "./settings/BackgroundLockSection.vue";
import AppearanceSection from "./settings/AppearanceSection.vue";
import DataSaverSection from "./settings/DataSaverSection.vue";
import AndroidUpdateSection from "./settings/AndroidUpdateSection.vue";
import PushSection from "./settings/PushSection.vue";
import CacheSection from "./settings/CacheSection.vue";
import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { accountDisplayName } from "@/services/accountRegistry";
import { biometricMethodLabel } from "@/utils/biometricLabel";
const GoogleRecoveryPanel = defineAsyncComponent(() => import("@/components/GoogleRecoveryPanel.vue"));
import { useRouter } from "vue-router";

import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { useProfilesStore } from "@/stores/profiles";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { runWhenIdle } from "@/utils/bottomTabActivation";
import { isNativeAndroidApp } from "@/services/androidUpdater";

const keyStore = useKeyStore();
const friendships = useFriendshipsStore();
const profiles = useProfilesStore();
const settings = useSettingsStore();
const ui = useUIStore();
const router = useRouter();

const nickname = computed(() => profiles.getProfile(keyStore.pkHex)?.nickname?.trim() || "未设置昵称");
const shortPk = computed(() => keyStore.pkHex ? `${keyStore.pkHex.slice(0, 8)}...${keyStore.pkHex.slice(-6)}` : "");

const relayRuntime = useRelayRuntimeStatus();
const biometricSupported = ref(false);
const biometricBusy = ref(false);
const remoteSignerBusy = ref(false);
const biometricRevision = ref(0);
const isNativeApp = (() => {
  const capacitor = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
})();
const isNativeAndroid = isNativeAndroidApp();
const biometricEnabled = computed(() => {
  void biometricRevision.value;
  return keyStore.hasBiometricUnlock();
});
const biometricLabel = computed(() => biometricMethodLabel());
const googleClientId = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID || "").trim();
const googleBackupAvailable = computed(() =>
  !!googleClientId && !isNativeApp && keyStore.loginMethod === "private-key" && !!keyStore.skHex
);
const googleBackupMounted = ref(false);
const googleBackupPanel = ref<{ begin?: () => Promise<void> } | null>(null);
const showAccountSwitcher = ref(false);
const switchingTo = ref("");
const securityBusy = ref(false);
const revealedNsec = ref("");
const protectionChoice = ref<"device" | "password" | "session">("device");
const newLocalPassword = ref("");
const confirmLocalPassword = ref("");
function currentProtection(): "device" | "password" | "session" {
  if (keyStore.credentialMode === "password") return "password";
  if (keyStore.credentialMode === "session") return "session";
  return "device";
}
const accountProtectionText = computed(() => {
  if (keyStore.loginMethod === "nip46") {
    return keyStore.remoteSignerConnected ? "远程签名器 · 已连接" : "远程签名器 · 离线";
  }
  return biometricEnabled.value
    ? `${biometricLabel.value}保护`
    : keyStore.credentialMode === "device"
      ? "本机保持登录"
      : keyStore.credentialMode === "password" ? "本地密码保护" : "仅当前会话";
});
let cancelDeferredRuntimeRefresh: (() => void) | null = null;
let viewActive = false;

function formatSyncTimestamp(timestamp?: number) {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : "—";
}

function scheduleDeferredRuntimeRefresh() {
  if (!viewActive || cancelDeferredRuntimeRefresh) return;
  cancelDeferredRuntimeRefresh = runWhenIdle(() => {
    cancelDeferredRuntimeRefresh = null;
    if (!viewActive || !keyStore.pkHex) return;
    relayRuntime.startStatusPolling();
    void refreshBiometricSupport();
  }, 1_000);
}

async function refreshBiometricSupport() {
  biometricSupported.value = await keyStore.supportsBiometricUnlock();
}

async function reconnectRemoteSigner() {
  if (remoteSignerBusy.value || keyStore.loginMethod !== "nip46") return;
  remoteSignerBusy.value = true;
  try {
    await keyStore.reconnectRemoteSigner();
    ui.addToast("远程签名器已重新连接", 2_000, "success");
  } catch {
    ui.addToast("远程签名器连接失败，请稍后重试", 2_500, "error");
  } finally {
    remoteSignerBusy.value = false;
  }
}

async function toggleBiometricUnlock() {
  if (biometricBusy.value) return;
  biometricBusy.value = true;
  try {
    if (biometricEnabled.value) {
      await keyStore.disableBiometricUnlock();
      biometricRevision.value += 1;
      ui.addToast(`${biometricLabel.value}登录保护已关闭`, 2_000, "success");
    } else {
      await keyStore.enableBiometricUnlock();
      biometricRevision.value += 1;
      ui.addToast(`${biometricLabel.value}登录保护已开启`, 2_000, "success");
    }
  } catch (error) {
    const cancelled = error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
    if (!cancelled) ui.addToast(error instanceof Error ? error.message : `${biometricLabel.value} 设置失败`, 2_500, "error");
  } finally {
    biometricBusy.value = false;
  }
}

function switchAccount() {
  keyStore.refreshAccounts();
  showAccountSwitcher.value = true;
}

async function switchToAccount(pubkey: string) {
  if (switchingTo.value) return;
  if (pubkey === keyStore.pkHex) {
    showAccountSwitcher.value = false;
    return;
  }
  const target = keyStore.accounts.find(account => account.pubkey === pubkey);
  switchingTo.value = pubkey;
  try {
    // Credentials are checked before the current account is locked, so a
    // failure leaves the user signed in where they were.
    const result = await keyStore.selectRememberedAccount(pubkey);
    showAccountSwitcher.value = false;
    if (result === "connected") {
      await router.replace("/");
      if (target) ui.addToast(`已切换到 ${accountDisplayName(target)}`, 1_800, "success");
    } else {
      await router.replace({ path: "/login", query: { redirect: "/" } });
    }
  } catch (error) {
    ui.addToast(error instanceof Error ? error.message : "切换账号失败", 2_500, "error");
  } finally {
    switchingTo.value = "";
  }
}

function addAccount() {
  showAccountSwitcher.value = false;
  // Stay signed in until another account actually signs in; backing out returns here.
  void router.push({ path: "/login", query: { mode: "add", redirect: "/" } });
}

async function beginGoogleBackup() {
  if (!googleBackupAvailable.value) return;
  googleBackupMounted.value = true;
  await nextTick();
  if (!googleBackupPanel.value?.begin) {
    ui.addToast("Google 备份正在加载，请稍后再试", 2_000, "info");
    return;
  }
  await googleBackupPanel.value.begin();
}

function revealPrivateKey() {
  if (!keyStore.skHex || !confirm("确定显示私钥？请确认身边没有人看你的屏幕。")) return;
  revealedNsec.value = nip19.nsecEncode(hexToBytes(keyStore.skHex));
}

async function copyPrivateKey() {
  try {
    await navigator.clipboard.writeText(revealedNsec.value);
    ui.addToast("已复制私钥，请尽快存进密码管理器", 2_400, "success");
  } catch {
    ui.addToast("无法自动复制，请长按私钥手动复制", 2_400, "error");
  }
}

async function runSecurityChange(task: () => Promise<void>, success: string) {
  if (securityBusy.value) return;
  securityBusy.value = true;
  try {
    await task();
    biometricRevision.value += 1;
    ui.addToast(success, 2_000, "success");
  } catch (error) {
    ui.addToast(error instanceof Error ? error.message : "设置失败，请重试", 2_500, "error");
  } finally {
    securityBusy.value = false;
    protectionChoice.value = currentProtection();
  }
}

function chooseProtection(choice: "device" | "password" | "session") {
  protectionChoice.value = choice;
  if (choice === currentProtection() && !(choice === "device" && keyStore.credentialMode === "passkey")) return;
  if (choice === "password") return; // wait for the password form
  newLocalPassword.value = "";
  confirmLocalPassword.value = "";
  if (choice === "device") {
    if (biometricEnabled.value && !confirm(`将关闭 ${biometricLabel.value} 保护，打开应用即可直接进入。继续？`)) {
      protectionChoice.value = currentProtection();
      return;
    }
    void runSecurityChange(() => keyStore.keepSignedInOnDevice(), "已改为在这台手机上保持登录");
    return;
  }
  if (!confirm("改为仅此次登录后，这台手机不再保存登录凭证，关闭应用后需要重新输入私钥。请先确认已备份私钥。继续？")) {
    protectionChoice.value = currentProtection();
    return;
  }
  void runSecurityChange(() => keyStore.useSessionOnlyLogin(), "已改为仅此次登录");
}

function applyLocalPassword() {
  if (newLocalPassword.value.length < 8) {
    ui.addToast("本地保护密码至少需要 8 位", 2_000, "error");
    return;
  }
  if (newLocalPassword.value !== confirmLocalPassword.value) {
    ui.addToast("两次输入的密码不一致", 2_000, "error");
    return;
  }
  const password = newLocalPassword.value;
  void runSecurityChange(async () => {
    await keyStore.protectWithLocalPassword(password);
    newLocalPassword.value = "";
    confirmLocalPassword.value = "";
  }, "已开启本地密码保护");
}

async function doLogout() {
  await keyStore.logout();
  location.href = "/#/login";
}

watch(() => keyStore.pkHex, async pk => {
  relayRuntime.resetRuntimeStatus(!pk);
  if (!pk) {
    settings.reset();
    return;
  }
  revealedNsec.value = "";
  protectionChoice.value = currentProtection();
  if (settings.loadedFor !== pk) await settings.load(pk);
  if (keyStore.pkHex !== pk || settings.loadedFor !== pk) return;

  // Relay state is already in memory, so this is safe for first paint.
  relayRuntime.refreshStatuses();
  scheduleDeferredRuntimeRefresh();
}, { immediate: true });

onMounted(() => {
  viewActive = true;
  scheduleDeferredRuntimeRefresh();
});
onActivated(() => {
  viewActive = true;
  scheduleDeferredRuntimeRefresh();
});
onDeactivated(() => {
  viewActive = false;
  relayRuntime.stopStatusPolling();
  cancelDeferredRuntimeRefresh?.();
  cancelDeferredRuntimeRefresh = null;
});
onBeforeUnmount(() => {
  viewActive = false;
  relayRuntime.stopStatusPolling();
  cancelDeferredRuntimeRefresh?.();
  cancelDeferredRuntimeRefresh = null;
});
</script>

<style scoped src="./settings/systemSettingsSection.css"></style>
<style scoped>
.system-content{padding:0 16px}.account-section{margin-top:8px}

.settings-container {
  width: 100%;
  margin: 0 auto;
  padding: 0 0 calc(var(--bottom-nav-height) + env(safe-area-inset-bottom) + 24px);
  box-sizing: border-box;
}

.card {
  padding: 16px;
  border: 1px solid var(--bd-e8edf3);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.035);
}

.settings-card {
  padding: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  overflow: hidden;
}

.my-profile-summary {
  display: flex;
  min-height: 88px;
  align-items: center;
  gap: 13px;
  padding: 15px 16px;
}
.my-profile-summary > span {
  display: grid;
  min-width: 0;
  gap: 4px;
}
.my-profile-summary strong {
  overflow: hidden;
  color: var(--fg-172033);
  font-size: 1.05rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.my-profile-summary small {
  color: var(--fg-64748b);
  font-size: .78rem;
}

.top-level-row {
  display: flex;
  width: 100%;
  min-height: 64px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 13px 16px;
  border: 0;
  border-top: 1px solid var(--bd-e2e8f0);
  background: transparent;
  color: var(--fg-1e293b);
  text-align: left;
  cursor: pointer;
  list-style: none;
}
.top-level-row::-webkit-details-marker { display: none; }
.row-main { display: flex; min-width: 0; align-items: center; gap: 12px; }
.row-main strong { font-size: .94rem; font-weight: 600; }
.row-icon { display: grid; width: 24px; height: 24px; flex: 0 0 24px; place-items: center; color: var(--fg-475569); }
.row-icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.row-chevron { flex: 0 0 auto; color: var(--fg-94a3b8); font-size: 22px; transition: transform 160ms ease; }
.top-level-group[open] > .top-level-row .row-chevron { transform: rotate(90deg); }
.top-level-content { padding: 4px 16px 16px; border-top: 1px solid var(--bd-eef2f6); }
.top-level-content.account-row { min-height: 64px; }
.identity-section{margin-top:18px;border-top:2px solid var(--bd-e2e8f0)}
.account-panel{padding:2px 0 18px 36px}
.account-control-card{overflow:hidden;border:1px solid var(--bd-e5eaf0);border-radius:16px;background:var(--bg-fff);box-shadow:0 1px 2px rgba(15,23,42,.025)}
.account-setting-row{display:flex;min-height:72px;align-items:center;gap:14px;padding:14px 15px}
.account-inline-action{flex:0 0 auto;min-width:64px;height:36px;padding:0 13px;border:1px solid var(--bd-d8e0e8);border-radius:10px;background:var(--bg-f8fafc);color:var(--fg-334155);font-size:.86rem;font-weight:600;cursor:pointer}
.account-inline-action:disabled{opacity:.55;cursor:default}
.account-actions-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:14px 15px;border-top:1px solid var(--bd-eef2f6)}
.account-action-button{min-height:48px;border-radius:13px;font-size:.94rem;font-weight:600;cursor:pointer;transition:transform 120ms ease,background 120ms ease,border-color 120ms ease}
.account-action-button:active,.account-inline-action:active,.account-danger-button:active{transform:scale(.985)}
.account-action-secondary{border:1px solid var(--bd-d7dee7);background:var(--bg-f8fafc);color:var(--fg-334155)}
.account-action-primary{border:1px solid #475569;background:#475569;color:#fff}
.account-danger-row{padding:0 15px 14px}
.account-setting-row+.account-setting-row,.account-control-card>.protection-modes{border-top:1px solid var(--bd-eef2f6)}
.key-row{align-items:flex-start}.key-row-actions{display:flex;flex:0 0 auto;flex-direction:column;gap:8px}
.revealed-key{display:block;margin-top:6px;padding:10px;border-radius:10px;background:var(--bg-f8fafc);color:var(--fg-0f1419);font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;user-select:all}
.protection-modes{display:grid;gap:4px;margin:0;padding:12px 15px 14px;border:0;border-top:1px solid var(--bd-eef2f6)}
.protection-modes legend{float:left;width:100%;margin-bottom:6px;color:var(--fg-334155);font-size:.9rem;font-weight:600}
.protection-mode{display:flex;min-height:52px;align-items:flex-start;gap:10px;padding:6px 0;cursor:pointer}
.protection-mode input{width:20px;height:20px;margin:2px 0 0;flex:0 0 20px;accent-color:#22304F}
.protection-mode span{display:grid;gap:2px}.protection-mode strong{font-size:.9rem}.protection-mode small{color:var(--fg-64748b);font-size:.78rem;line-height:1.45}
.password-setup{display:grid;gap:8px;padding:2px 0 8px 30px}
.protection-modes:disabled{opacity:.6}
.account-danger-button{width:100%;min-height:46px;border:1px solid var(--bd-fecaca);border-radius:13px;background:var(--bg-fff7f7);color:var(--fg-dc2626);font-size:.93rem;font-weight:600;cursor:pointer}
@media(max-width:520px){.account-panel{padding-left:0}.account-actions-row{gap:8px}.account-action-button{min-height:46px}}

.technical-settings { padding-top: 0; }

.sync-status {
  margin: 10px 12px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg-e0f2fe);
  color: var(--fg-075985);
  font-size: 0.8rem;
}

.sync-warning {
  background: var(--bg-fff7ed);
  color: var(--fg-9a3412);
}

.sync-ok {
  background: var(--bg-ecfdf5);
  color: var(--fg-047857);
}

.version-footer {
  padding: 22px 16px 4px;
  color: var(--fg-94a3b8);
  font-size: 0.68rem;
  line-height: 1.5;
  text-align: center;
}

@media (max-width: 640px) {
  .settings-container {
    padding-right: 0;
    padding-left: 0;
  }

  .card {
    padding: 14px;
  }

  .settings-card {
    padding: 0;
  }

  .account-panel {
    padding-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .row-chevron { transition: none; }
}
</style>
