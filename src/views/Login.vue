<template>
  <main class="login-card">
    <div class="login-center">
      <header class="brand">
        <h1>海内</h1>
        <p class="brand-subtitle">纯 · 知己</p>
        <p v-if="pageMode === 'login'" class="brand-tagline">只与你选择的人连接</p>
      </header>

      <section v-if="pageMode === 'restoring'" class="state-panel restoring-panel">
        <p class="status-message" role="status" aria-live="polite">正在恢复会话…</p>
      </section>

      <form v-else-if="pageMode === 'unlock'" class="unlock-form" @submit.prevent="doUnlock">
        <div class="welcome-block">
          <p class="welcome-title">欢迎回来</p>
          <p class="account-id" :title="shortAccount">{{ shortAccount }}</p>
        </div>

        <label class="field-label" for="unlock-password">本地保护密码</label>
        <input
          id="unlock-password"
          ref="unlockPasswordEl"
          v-model="unlockPassword"
          class="input"
          type="password"
          autocomplete="current-password"
          placeholder="输入本地保护密码"
          :disabled="loading"
        />

        <button class="btn btn-primary" type="submit" :disabled="loading">
          {{ loading ? "正在解锁…" : "解锁" }}
        </button>

        <button class="btn btn-text" type="button" :disabled="loading" @click="switchAccount">
          切换账号
        </button>
      </form>

      <form v-else class="login-form" @submit.prevent="doLoginNsec">
        <div class="field-group">
          <label class="field-label" for="private-key">私钥</label>
          <div class="private-key-field">
            <input
              id="private-key"
              ref="nsecInputEl"
              v-model="nsecInput"
              class="input private-key-input"
              :type="showPrivateKey ? 'text' : 'password'"
              placeholder="nsec1... / 64 位 hex"
              autocapitalize="none"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              inputmode="text"
              autofocus
              :disabled="loading"
            />
            <button
              class="visibility-button"
              type="button"
              :aria-label="showPrivateKey ? '隐藏私钥' : '显示私钥'"
              :title="showPrivateKey ? '隐藏私钥' : '显示私钥'"
              :disabled="loading"
              @click="showPrivateKey = !showPrivateKey"
            >
              <span aria-hidden="true">👁</span>
            </button>
          </div>

          <div class="key-actions">
            <button class="paste-button" type="button" :disabled="loading" @click="pastePrivateKey">
              粘贴私钥
            </button>
            <span v-if="recognizedKeyType" class="recognized-key" aria-live="polite">
              已识别 {{ recognizedKeyType }} 私钥
            </span>
          </div>
        </div>

        <div class="encryption-section">
          <button
            class="accordion-button"
            type="button"
            :aria-expanded="saveEncrypted"
            aria-controls="local-password-fields"
            :disabled="loading"
            @click="saveEncrypted = !saveEncrypted"
          >
            <span class="disclosure" aria-hidden="true">{{ saveEncrypted ? "▾" : "▸" }}</span>
            在本机加密保存私钥
          </button>

          <div v-if="saveEncrypted" id="local-password-fields" class="password-fields">
            <label class="field-label" for="local-password">本地保护密码</label>
            <input
              id="local-password"
              v-model="nsecPassword"
              class="input"
              type="password"
              autocomplete="new-password"
              placeholder="输入密码"
              :disabled="loading"
            />

            <label class="field-label" for="confirm-password">确认密码</label>
            <input
              id="confirm-password"
              v-model="confirmPassword"
              class="input"
              type="password"
              autocomplete="new-password"
              placeholder="再次输入密码"
              :disabled="loading"
            />

            <p class="password-note">启用后，下次打开 HaiNei 时只需输入这个密码解锁。</p>
            <p class="password-note muted">这个密码只用于本机加密，不是 Nostr 密码，也不会上传。</p>
          </div>
        </div>

        <button class="btn btn-primary login-button" type="submit" :disabled="loading">
          {{ loading ? "正在登录…" : "登录" }}
        </button>

        <div class="divider" aria-hidden="true"><span>或</span></div>

        <button
          class="btn btn-secondary"
          type="button"
          :class="{ 'plugin-unavailable': !pluginDetected }"
          :disabled="loading"
          @click="loginWithExtension"
        >
          使用浏览器插件登录
        </button>
        <p class="plugin-label">NIP-07</p>
        <p class="plugin-status" :class="{ detected: pluginDetected }">
          {{ pluginDetected ? "已检测到浏览器插件" : "当前未检测到插件" }}
        </p>

        <p class="privacy-note">私钥只保存在你的设备中</p>
      </form>

      <p v-if="loginStatus && pageMode !== 'restoring'" class="status-message" role="status" aria-live="polite">
        {{ loginStatus }}
      </p>

      <transition name="shake">
        <div v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
          {{ errorMessage }}
        </div>
      </transition>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { nip19 } from "nostr-tools";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { logger } from "@/utils/logger";

type LoginMethod = "private-key" | "nip07" | "unlock";

const ks = useKeyStore();
const route = useRoute();
const router = useRouter();

const loading = ref(false);
const errorMessage = ref("");
const loginStatus = ref("");
const nsecInput = ref("");
const showPrivateKey = ref(false);
const saveEncrypted = ref(false);
const nsecPassword = ref("");
const confirmPassword = ref("");
const unlockPassword = ref("");
const pluginDetected = ref(typeof window !== "undefined" && !!window.nostr);
const unlockInProgress = ref(false);

const nsecInputEl = ref<HTMLInputElement | null>(null);
const unlockPasswordEl = ref<HTMLInputElement | null>(null);

let pluginDetectionTimer: number | undefined;
let pluginDetectionStopTimer: number | undefined;

const needsUnlock = computed(() => !!ks.pkHex && ks.isEncrypted && !ks.isUnlocked);
const pageMode = computed<"restoring" | "unlock" | "login">(() => {
  if (ks.isRestoring) return "restoring";
  if (needsUnlock.value || unlockInProgress.value) return "unlock";
  return "login";
});

const recognizedKeyType = computed(() => {
  const value = nsecInput.value.trim();
  if (value.startsWith("nsec1")) return "nsec";
  if (/^[0-9a-fA-F]{64}$/.test(value)) return "hex";
  return "";
});

const shortAccount = computed(() => {
  const pubkey = ks.pkHex;
  if (!pubkey) return "";
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 10)}...${pubkey.slice(-6)}`;
  }
});

function detectPlugin() {
  pluginDetected.value = !!window.nostr;
  if (pluginDetected.value && pluginDetectionTimer !== undefined) {
    window.clearInterval(pluginDetectionTimer);
    pluginDetectionTimer = undefined;
  }
}

onMounted(async () => {
  detectPlugin();
  window.addEventListener("focus", detectPlugin);
  pluginDetectionTimer = window.setInterval(detectPlugin, 500);
  pluginDetectionStopTimer = window.setTimeout(() => {
    if (pluginDetectionTimer !== undefined) {
      window.clearInterval(pluginDetectionTimer);
      pluginDetectionTimer = undefined;
    }
  }, 5000);

  if (pageMode.value === "unlock") {
    await nextTick();
    unlockPasswordEl.value?.focus();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("focus", detectPlugin);
  if (pluginDetectionTimer !== undefined) window.clearInterval(pluginDetectionTimer);
  if (pluginDetectionStopTimer !== undefined) window.clearTimeout(pluginDetectionStopTimer);
});

watch(pageMode, async (mode) => {
  errorMessage.value = "";
  loginStatus.value = "";
  await nextTick();
  if (mode === "unlock") unlockPasswordEl.value?.focus();
});

function clearSensitiveInputs() {
  nsecInput.value = "";
  nsecPassword.value = "";
  confirmPassword.value = "";
  unlockPassword.value = "";
  showPrivateKey.value = false;
  saveEncrypted.value = false;
}

function errorType(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

function logLoginFailure(method: LoginMethod, stage: string, error: unknown) {
  logger.error("[Login] Action failed", {
    method,
    stage,
    errorType: errorType(error)
  });
}

function isSafeInternalRedirect(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !/[\u0000-\u001f]/.test(value)
    && router.resolve(value).path !== "/login";
}

async function finishLogin() {
  const redirect = route.query.redirect;
  clearSensitiveInputs();
  await router.replace(isSafeInternalRedirect(redirect) ? redirect : "/");
}

function isValidPrivateKey(value: string) {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return true;
  if (!value.startsWith("nsec1")) return false;
  try {
    const decoded = nip19.decode(value);
    return decoded.type === "nsec" && decoded.data instanceof Uint8Array && decoded.data.length === 32;
  } catch {
    return false;
  }
}

async function pastePrivateKey() {
  errorMessage.value = "";
  try {
    if (!navigator.clipboard?.readText) throw new Error("clipboard_unavailable");
    const text = (await navigator.clipboard.readText()).trim();
    if (text) nsecInput.value = text;
  } catch (error) {
    logLoginFailure("private-key", "clipboard-read", error);
    errorMessage.value = "无法自动读取剪贴板，请长按输入框粘贴私钥。";
  }
}

async function doLoginNsec() {
  if (loading.value) return;
  errorMessage.value = "";

  const privateKey = nsecInput.value.trim();
  if (!privateKey) {
    errorMessage.value = "请输入私钥";
    return;
  }
  if (!isValidPrivateKey(privateKey)) {
    errorMessage.value = "私钥格式不正确\n请输入 nsec1... 或 64 位十六进制私钥。";
    return;
  }
  if (saveEncrypted.value && !nsecPassword.value) {
    errorMessage.value = "请输入本地保护密码";
    return;
  }
  if (saveEncrypted.value && nsecPassword.value !== confirmPassword.value) {
    errorMessage.value = "两次输入的密码不一致";
    return;
  }

  loading.value = true;
  loginStatus.value = "正在登录…";
  try {
    await ks.loginWithNsec(privateKey, saveEncrypted.value ? nsecPassword.value : undefined);
    await finishLogin();
  } catch (error) {
    logLoginFailure("private-key", "login", error);
    errorMessage.value = "登录失败，请重试。";
  } finally {
    loading.value = false;
    loginStatus.value = "";
  }
}

async function loginWithExtension() {
  if (loading.value) return;
  errorMessage.value = "";
  detectPlugin();
  if (!pluginDetected.value) {
    errorMessage.value = "当前浏览器未检测到 NIP-07 插件。\n请使用私钥登录，或在支持 NIP-07 的浏览器中打开 HaiNei。";
    return;
  }

  loading.value = true;
  loginStatus.value = "正在等待浏览器插件授权…";
  try {
    await ks.loginWithExtension();
    await finishLogin();
  } catch (error) {
    logLoginFailure("nip07", "authorization", error);
    errorMessage.value = "登录失败，请重试。";
  } finally {
    loading.value = false;
    loginStatus.value = "";
  }
}

async function doUnlock() {
  if (loading.value) return;
  errorMessage.value = "";
  const password = unlockPassword.value;
  if (!password) {
    errorMessage.value = "请输入本地保护密码";
    return;
  }

  loading.value = true;
  unlockInProgress.value = true;
  loginStatus.value = "正在解锁…";
  try {
    await ks.unlockWithPassword(password);
    await finishLogin();
  } catch (error) {
    logLoginFailure("unlock", "decrypt", error);
    errorMessage.value = "密码不正确，请重试。";
  } finally {
    loading.value = false;
    unlockInProgress.value = false;
    loginStatus.value = "";
  }
}

function switchAccount() {
  if (loading.value) return;
  clearSensitiveInputs();
  errorMessage.value = "";
  loginStatus.value = "";
  ks.logout();
  nextTick(() => nsecInputEl.value?.focus());
}
</script>

<style scoped>
.login-card {
  min-height: 100dvh;
  overflow-y: auto;
  display: flex;
  background: #0b1017;
  color: #d8dee9;
  padding-top: max(20px, env(safe-area-inset-top));
  padding-bottom: max(20px, env(safe-area-inset-bottom));
  margin: 0;
  border-radius: 0;
  box-shadow: none;
}

.login-center {
  width: 100%;
  max-width: 380px;
  margin: auto;
  padding: 32px 20px;
}

.brand {
  text-align: center;
  margin-bottom: 36px;
}

.brand h1 {
  margin: 0;
  color: #e5e9f0;
  font-family: "Source Han Serif SC", "Songti SC", serif;
  font-size: 2.75rem;
  font-weight: 400;
  letter-spacing: 0.12em;
}

.brand-subtitle {
  margin: 8px 0 0;
  color: #aab2c0;
  font-size: 0.95rem;
  letter-spacing: 0.22em;
}

.brand-tagline {
  margin: 12px 0 0;
  color: #697589;
  font-size: 0.82rem;
  letter-spacing: 0.04em;
}

.login-form,
.unlock-form,
.state-panel {
  width: 100%;
  animation: slide-up 200ms ease-out;
}

.field-group {
  margin-bottom: 18px;
}

.field-label {
  display: block;
  margin: 0 0 7px;
  color: #aab2c0;
  font-size: 0.85rem;
}

.input {
  width: 100%;
  min-height: 48px;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid #2b3545;
  border-radius: 12px;
  outline: none;
  background: #101720;
  color: #edf1f7;
  font-size: 16px;
  transition: border-color 180ms ease, box-shadow 180ms ease;
}

.input:focus {
  border-color: #65748b;
  box-shadow: 0 0 0 3px rgba(101, 116, 139, 0.16);
}

.input:disabled,
.btn:disabled,
.paste-button:disabled,
.visibility-button:disabled,
.accordion-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.private-key-field {
  position: relative;
}

.private-key-input {
  padding-right: 52px;
}

.visibility-button {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 44px;
  height: 44px;
  border: 0;
  background: transparent;
  color: #9aa6b7;
  font-size: 1rem;
  cursor: pointer;
}

.key-actions {
  min-height: 34px;
  margin-top: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.paste-button {
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid #303b4d;
  border-radius: 9px;
  background: transparent;
  color: #b8c1cf;
  font-size: 0.82rem;
  cursor: pointer;
}

.recognized-key {
  color: #7eaa98;
  font-size: 0.75rem;
  text-align: right;
}

.encryption-section {
  margin: 2px 0 18px;
}

.accordion-button {
  width: 100%;
  min-height: 44px;
  padding: 8px 0;
  display: flex;
  align-items: center;
  border: 0;
  background: transparent;
  color: #9da8b8;
  font-size: 0.86rem;
  text-align: left;
  cursor: pointer;
}

.disclosure {
  width: 20px;
  color: #697589;
}

.password-fields {
  padding: 10px 0 0 20px;
  animation: slide-up 180ms ease-out;
}

.password-fields .input {
  margin-bottom: 14px;
}

.password-note {
  margin: 0 0 6px;
  color: #8d99aa;
  font-size: 0.76rem;
  line-height: 1.5;
}

.password-note.muted {
  color: #657184;
}

.btn {
  width: 100%;
  min-height: 48px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  font-size: 0.96rem;
  cursor: pointer;
  transition: background-color 180ms ease, border-color 180ms ease, transform 120ms ease;
}

.btn:active:not(:disabled) {
  transform: scale(0.99);
}

.btn-primary {
  min-height: 50px;
  border: 1px solid #718096;
  background: #dce2ea;
  color: #111821;
  font-weight: 600;
}

.btn-primary:hover:not(:disabled) {
  background: #eef2f7;
}

.login-button {
  margin-top: 2px;
}

.divider {
  margin: 24px 0;
  display: flex;
  align-items: center;
  gap: 12px;
  color: #586476;
  font-size: 0.75rem;
}

.divider::before,
.divider::after {
  content: "";
  height: 1px;
  flex: 1;
  background: #252e3c;
}

.btn-secondary {
  border: 1px solid #354154;
  background: transparent;
  color: #c3cad5;
}

.btn-secondary:hover:not(:disabled) {
  border-color: #526078;
  background: #111923;
}

.btn-secondary.plugin-unavailable {
  border-color: #293342;
  color: #929dad;
}

.plugin-label {
  margin: 8px 0 0;
  color: #748095;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-align: center;
}

.plugin-status {
  margin: 5px 0 0;
  color: #687487;
  font-size: 0.72rem;
  text-align: center;
}

.plugin-status.detected {
  color: #7eaa98;
}

.privacy-note {
  margin: 28px 0 0;
  color: #697589;
  font-size: 0.76rem;
  text-align: center;
}

.welcome-block {
  margin-bottom: 26px;
  text-align: center;
}

.welcome-title {
  margin: 0 0 10px;
  color: #cbd2dd;
  font-size: 1rem;
}

.account-id {
  margin: 0;
  color: #7e899a;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}

.unlock-form .btn-primary {
  margin-top: 18px;
}

.btn-text {
  min-height: 44px;
  margin-top: 8px;
  border: 0;
  background: transparent;
  color: #7f8b9d;
  font-size: 0.86rem;
}

.restoring-panel {
  padding: 12px 0;
}

.status-message {
  margin: 16px 0 0;
  color: #8793a5;
  font-size: 0.82rem;
  text-align: center;
}

.error-message {
  margin-top: 14px;
  padding: 11px 12px;
  border: 1px solid rgba(204, 112, 112, 0.28);
  border-radius: 10px;
  background: rgba(132, 53, 53, 0.14);
  color: #dfa0a0;
  font-size: 0.84rem;
  line-height: 1.45;
  text-align: center;
  white-space: pre-line;
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: translateY(0); }
}

.shake-enter-active {
  animation: shake 200ms ease-out;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  35% { transform: translateX(-3px); }
  70% { transform: translateX(3px); }
}

@media (max-height: 700px) {
  .login-center {
    margin: 0 auto;
    padding-top: 24px;
  }

  .brand {
    margin-bottom: 28px;
  }

  .brand h1 {
    font-size: 2.35rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .login-form,
  .unlock-form,
  .state-panel,
  .password-fields,
  .shake-enter-active {
    animation: none;
  }
}
</style>
