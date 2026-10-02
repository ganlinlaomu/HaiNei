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

        <template v-if="biometricEnabled && !passwordFallbackVisible">
          <button class="btn btn-primary biometric-login-button" type="button" :disabled="loading" @click="doBiometricUnlock(false)">
            {{ loading ? `正在验证 ${biometricLabel}…` : `使用 ${biometricLabel} 登录` }}
          </button>
          <button v-if="hasPasswordFallback" class="btn btn-text" type="button" :disabled="loading" @click="showPasswordFallback">
            使用本地密码
          </button>
          <button v-else class="btn btn-text" type="button" :disabled="loading" @click="switchAccount">
            重新输入私钥
          </button>
        </template>

        <template v-else-if="hasPasswordFallback">
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
            @change="handleUnlockAutofill"
            @animationstart="handleUnlockAutofill"
          />

          <button class="btn btn-primary" type="submit" :disabled="loading">
            {{ loading ? "正在解锁…" : "解锁" }}
          </button>

          <button v-if="biometricEnabled" class="btn btn-text" type="button" :disabled="loading" @click="passwordFallbackVisible = false; doBiometricUnlock(false)">
            使用 {{ biometricLabel }} 登录
          </button>
        </template>

        <template v-else>
          <p class="password-note">此账号由通行密钥保护。若无法验证，可重新输入私钥恢复。</p>
          <button class="btn btn-primary biometric-login-button" type="button" :disabled="loading" @click="doBiometricUnlock(false)">
            {{ loading ? `正在验证 ${biometricLabel}…` : `使用 ${biometricLabel} 登录` }}
          </button>
        </template>

        <button class="btn btn-text" type="button" :disabled="loading" @click="switchAccount">
          切换账号
        </button>
      </form>

      <section v-else class="login-form">
        <div v-if="!addingAccount && ks.accounts.length" class="account-picker">
          <p class="picker-title">此设备上的账号</p>
          <div v-for="account in ks.accounts" :key="account.pubkey" class="account-option">
            <button type="button" class="account-select" :disabled="loading" @click="selectAccount(account.pubkey)">
              <strong>{{ shortPubkey(account.pubkey) }}</strong>
              <small>{{ accountCredentialLabel(account.authType, account.credentialMode) }}</small>
            </button>
            <div class="account-device-actions">
              <button type="button" class="account-device-action" :disabled="loading" @click="removeAccount(account.pubkey)">忘记此账号</button>
              <button type="button" class="account-device-action account-device-action-danger" :disabled="loading" @click="deleteDeviceData(account.pubkey)">删除本机资料</button>
            </div>
          </div>
        </div>

        <p v-if="addingAccount" class="picker-title account-mode-title">添加其他账号</p>
        <GoogleRecoveryPanel
          v-if="googleRecoveryEnabled"
          :client-id="googleClientId"
          @complete="finishGoogleRecovery"
        />
        <div v-if="googleRecoveryEnabled" class="login-divider"><span>或</span></div>
        <button class="btn btn-primary" type="button" :disabled="loading" @click="openPrivateLogin">
          使用私钥登录
        </button>
        <button class="btn btn-secondary" type="button" :disabled="loading" @click="startRegistration">
          {{ addingAccount ? "创建新账号" : "还没有账号？注册" }}
        </button>
        <button v-if="nip46Enabled" class="btn btn-secondary" type="button" :disabled="loading" @click="openRemoteSignerLogin">
          远程签名器（Beta）
        </button>

        <section v-if="showRegister" class="private-login registration-panel">
          <p class="registration-title">保存你的私钥</p>
          <p class="password-note">这是你的 Nostr 账号凭证。海内不会上传或替你找回，请先安全保存。</p>
          <textarea class="input registration-key" :value="generatedNsec" readonly rows="4" spellcheck="false"></textarea>
          <div class="key-actions">
            <button class="paste-button" type="button" :disabled="loading" @click="copyGeneratedNsec">
              {{ copiedNsec ? "已复制" : "复制私钥" }}
            </button>
          </div>
          <p class="password-note">确认后会在此设备保持登录，无需另设密码；以后可在设置中开启通行密钥保护。</p>
          <label class="registration-confirm">
            <input v-model="registrationConfirmed" type="checkbox" :disabled="loading" />
            <span>我已安全保存这份私钥</span>
          </label>
          <button class="btn btn-primary login-button" type="button"
            :disabled="loading || !registrationReady" @click="finishRegistration">
            {{ loading ? "正在创建…" : "进入海内" }}
          </button>
          <button class="btn btn-text" type="button" :disabled="loading" @click="cancelRegistration">取消</button>
        </section>

        <form v-if="showRemoteSigner && !showRegister" class="private-login" @submit.prevent="doLoginNip46">
          <div class="field-group">
            <label class="field-label" for="remote-signer">Bunker URL / NIP-05</label>
            <input
              id="remote-signer"
              v-model="bunkerInput"
              class="input"
              type="text"
              placeholder="bunker://... 或 name@domain"
              autocapitalize="none"
              autocomplete="off"
              autocorrect="off"
              spellcheck="false"
              :disabled="loading"
            />
          </div>
          <p class="password-note">私钥始终保留在远程签名器。海内只保存本机加密的连接凭据；签名器离线时仍可浏览已缓存内容。</p>
          <button class="btn btn-primary login-button" type="submit" :disabled="loading">
            {{ loading ? "正在连接…" : "连接远程签名器" }}
          </button>
          <button class="btn btn-text" type="button" :disabled="loading" @click="showRemoteSigner = false">取消</button>
        </form>

        <form v-if="showPrivateLogin && !showRegister" class="private-login" @submit.prevent="doLoginNsec">
          <div class="field-group">
            <label class="field-label" for="private-key">私钥</label>
            <div class="private-key-field">
              <input id="private-key" ref="nsecInputEl" v-model="nsecInput" class="input private-key-input"
                :type="showPrivateKey ? 'text' : 'password'" placeholder="nsec1... / 64 位 hex" autocapitalize="none"
                autocomplete="off" autocorrect="off" spellcheck="false" inputmode="text" :disabled="loading" />
              <button class="visibility-button" type="button" :aria-label="showPrivateKey ? '隐藏私钥' : '显示私钥'"
                :disabled="loading" @click="showPrivateKey = !showPrivateKey"><span aria-hidden="true">👁</span></button>
            </div>
            <div class="key-actions">
              <button class="paste-button" type="button" :disabled="loading" @click="pastePrivateKey">粘贴私钥</button>
              <span v-if="recognizedKeyType" class="recognized-key">已识别 {{ recognizedKeyType }} 私钥</span>
            </div>
          </div>

          <div class="encryption-section">
            <p class="device-login-title">在此设备保持登录</p>
            <p class="password-note">默认安全保存在独立的设备凭据库，下次打开可直接进入，不需要另设密码。</p>
            <details class="login-options">
              <summary>其他登录保护方式</summary>
              <label class="login-option"><input v-model="loginStorageMode" type="radio" value="device" /> 在此设备保持登录（推荐）</label>
              <label class="login-option"><input v-model="loginStorageMode" type="radio" value="password" /> 使用本地保护密码</label>
              <label class="login-option"><input v-model="loginStorageMode" type="radio" value="session" /> 仅此次登录</label>
            </details>
            <div v-if="loginStorageMode === 'password'" id="local-password-fields" class="password-fields">
              <label class="field-label" for="local-password">本地保护密码</label>
              <input id="local-password" v-model="nsecPassword" class="input" type="password" autocomplete="new-password" placeholder="至少 8 位" :disabled="loading" />
              <label class="field-label" for="confirm-password">确认密码</label>
              <input id="confirm-password" v-model="confirmPassword" class="input" type="password" autocomplete="new-password" placeholder="再次输入密码" :disabled="loading" />
              <p class="password-note">下次选择此账号后，只需输入这个密码解锁。</p>
              <p class="password-note muted">密码只用于本机加密，不会上传。</p>
            </div>
            <p v-else-if="loginStorageMode === 'session'" class="password-note muted">私钥只保留在内存中，关闭或重启应用后需要重新输入。</p>
          </div>
          <button class="btn btn-primary login-button" type="submit" :disabled="loading">{{ loading ? "正在登录…" : "登录" }}</button>
          <p class="privacy-note">私钥不会以明文写入本机存储</p>
        </form>
      </section>

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
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { generateSecretKey, nip19 } from "nostr-tools";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import GoogleRecoveryPanel from "@/components/GoogleRecoveryPanel.vue";
import { logger } from "@/utils/logger";

type LoginMethod = "private-key" | "nip46" | "unlock" | "switch" | "register" | "google";

const ks = useKeyStore();
const route = useRoute();
const router = useRouter();

const loading = ref(false);
const errorMessage = ref("");
const loginStatus = ref("");
const nsecInput = ref("");
const showPrivateKey = ref(false);
const loginStorageMode = ref<"device" | "password" | "session">("device");
const nsecPassword = ref("");
const confirmPassword = ref("");
const unlockPassword = ref("");
const unlockInProgress = ref(false);
const passwordFallbackVisible = ref(false);
const autoBiometricAccount = ref("");
const showPrivateLogin = ref(false);
const showRemoteSigner = ref(false);
const bunkerInput = ref("");
const showRegister = ref(false);
const nip46Enabled = import.meta.env.VITE_ENABLE_NIP46 === "true";
const googleClientId = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID || "").trim();
const googleRecoveryEnabled = !!googleClientId;
const generatedNsec = ref("");
const registrationConfirmed = ref(false);
const copiedNsec = ref(false);

const nsecInputEl = ref<HTMLInputElement | null>(null);
const unlockPasswordEl = ref<HTMLInputElement | null>(null);

const needsUnlock = computed(() => !!ks.pkHex && ks.isEncrypted && !ks.isUnlocked);
const biometricEnabled = computed(() => !!ks.pkHex && ks.hasBiometricUnlock(ks.pkHex));
const hasPasswordFallback = computed(() => ks.credentialMode === "password");
const biometricLabel = computed(() => "通行密钥");
const addingAccount = computed(() => route.query.mode === "add");
const pageMode = computed<"restoring" | "unlock" | "login">(() => {
  if (ks.isRestoring) return "restoring";
  if (needsUnlock.value || unlockInProgress.value) return "unlock";
  return "login";
});

const registrationReady = computed(() =>
  registrationConfirmed.value
);

function accountCredentialLabel(
  authType: "private-key" | "nip46",
  mode: "device" | "password" | "passkey" | "session",
) {
  if (authType === "nip46") return "远程签名器 · 本机加密连接凭据";
  if (mode === "device") return "私钥 · 本机保持登录";
  if (mode === "passkey") return "私钥 · 通行密钥保护";
  return "私钥 · 本地密码保护";
}

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

function shortPubkey(pubkey: string) {
  try {
    const npub = nip19.npubEncode(pubkey);
    return `${npub.slice(0, 12)}...${npub.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 10)}...${pubkey.slice(-6)}`;
  }
}

async function presentUnlockMethod() {
  if (pageMode.value !== "unlock" || loading.value || unlockInProgress.value) return;
  errorMessage.value = "";
  loginStatus.value = "";

  if (biometricEnabled.value && autoBiometricAccount.value !== ks.pkHex) {
    autoBiometricAccount.value = ks.pkHex;
    passwordFallbackVisible.value = false;
    await doBiometricUnlock(true);
    return;
  }

  if (!biometricEnabled.value) {
    passwordFallbackVisible.value = hasPasswordFallback.value;
    await nextTick();
    unlockPasswordEl.value?.focus();
  }
}

onMounted(async () => {
  ks.refreshAccounts();

  if (addingAccount.value) {
    showPrivateLogin.value = false;
    showRegister.value = false;
  }

  await presentUnlockMethod();
});

watch(pageMode, async (mode) => {
  if (mode !== "unlock") return;
  await presentUnlockMethod();
});

function clearSensitiveInputs() {
  nsecInput.value = "";
  nsecPassword.value = "";
  confirmPassword.value = "";
  unlockPassword.value = "";
  passwordFallbackVisible.value = false;
  generatedNsec.value = "";
  registrationConfirmed.value = false;
  copiedNsec.value = false;
  showPrivateKey.value = false;
  bunkerInput.value = "";
  showRemoteSigner.value = false;
  loginStorageMode.value = "device";
  showRegister.value = false;
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

async function finishGoogleRecovery(payload: { skHex: string; backupId: string; isNewAccount: boolean }) {
  if (loading.value || !payload.skHex) return;
  loading.value = true;
  errorMessage.value = "";
  loginStatus.value = payload.isNewAccount ? "正在创建海内账号…" : "正在恢复海内账号…";
  try {
    await ks.loginWithNsec(payload.skHex);
    await finishLogin();
  } catch (error) {
    logLoginFailure("google", payload.isNewAccount ? "create-account" : "restore-account", error);
    errorMessage.value = payload.isNewAccount
      ? "Google 备份已创建，但本机账号初始化失败，请重新使用 Google 登录恢复。"
      : "Google 账号恢复失败，请重试。";
  } finally {
    payload.skHex = "";
    loading.value = false;
    loginStatus.value = "";
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
  if (loginStorageMode.value === "password" && nsecPassword.value.length < 8) {
    errorMessage.value = "本地保护密码至少需要 8 位";
    return;
  }
  if (loginStorageMode.value === "password" && nsecPassword.value !== confirmPassword.value) {
    errorMessage.value = "两次输入的密码不一致";
    return;
  }

  loading.value = true;
  loginStatus.value = "正在登录…";
  try {
    await ks.loginWithNsec(
      privateKey,
      loginStorageMode.value === "password" ? nsecPassword.value : undefined,
      loginStorageMode.value !== "session",
    );
    await finishLogin();
  } catch (error) {
    logLoginFailure("private-key", "login", error);
    errorMessage.value = loginStorageMode.value === "device"
      ? "无法安全保存本机登录凭据。可在“其他登录保护方式”中改用本地密码或仅此次登录。"
      : "登录失败，请重试。";
  } finally {
    loading.value = false;
    loginStatus.value = "";
  }
}

async function selectAccount(pubkey: string) {
  if (loading.value) return;
  errorMessage.value = "";
  loading.value = true;
  let selectedForUnlock = false;
  try {
    const result = await ks.selectRememberedAccount(pubkey);
    if (result === "connected") {
      await finishLogin();
      return;
    }
    selectedForUnlock = result === "unlock";
  } catch (error) {
    logLoginFailure("switch", "select-account", error);
    errorMessage.value = error instanceof Error ? error.message : "切换账号失败";
  } finally {
    loading.value = false;
  }
  if (selectedForUnlock) {
    autoBiometricAccount.value = "";
    await presentUnlockMethod();
  }
}

async function deleteDeviceData(pubkey: string) {
  if (loading.value || !window.confirm("删除此账号的全部本机资料？将清除本机私信、草稿、待发消息、缓存和登录凭证；不会删除其他账号或任何远端内容。此操作无法恢复。")) return;
  loading.value = true;
  try { await ks.deleteAccountDeviceData(pubkey); }
  catch { errorMessage.value = "本机资料删除失败，请重试"; }
  finally { loading.value = false; }
}

async function removeAccount(pubkey: string) {
  if (loading.value || !window.confirm("忘记此账号？将移除本机保存的登录凭证，但保留本机历史数据。以后重新输入私钥后仍可继续使用这些历史。")) return;
  loading.value = true;
  try {
    await ks.removeAccountFromDevice(pubkey);
  } finally {
    loading.value = false;
  }
}

function isBiometricCancellation(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

async function showPasswordFallback() {
  passwordFallbackVisible.value = true;
  errorMessage.value = "";
  await nextTick();
  unlockPasswordEl.value?.focus();
}

async function doBiometricUnlock(automatic = false) {
  if (loading.value || !biometricEnabled.value) return;
  errorMessage.value = "";
  loading.value = true;
  unlockInProgress.value = true;
  loginStatus.value = `正在验证 ${biometricLabel.value}…`;
  try {
    await ks.unlockWithBiometric();
    await finishLogin();
  } catch (error) {
    if (!isBiometricCancellation(error)) {
      logLoginFailure("unlock", "biometric", error);
      errorMessage.value = error instanceof Error ? error.message : `${biometricLabel.value} 登录失败`;
      passwordFallbackVisible.value = hasPasswordFallback.value;
      if (hasPasswordFallback.value) {
        await nextTick();
        unlockPasswordEl.value?.focus();
      }
    } else if (!automatic) {
      errorMessage.value = "";
    }
  } finally {
    loading.value = false;
    unlockInProgress.value = false;
    loginStatus.value = "";
  }
}

let autofillTimer: ReturnType<typeof window.setTimeout> | null = null;
function handleUnlockAutofill(event: Event) {
  if (loading.value || !unlockPassword.value) return;
  if (event.type === "animationstart") {
    const animation = event as AnimationEvent;
    if (animation.animationName !== "hainei-password-autofill") return;
  }
  if (autofillTimer) window.clearTimeout(autofillTimer);
  autofillTimer = window.setTimeout(() => {
    autofillTimer = null;
    if (unlockPassword.value && !loading.value) void doUnlock();
  }, 80);
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

function openPrivateLogin() {
  showRegister.value = false;
  showRemoteSigner.value = false;
  showPrivateLogin.value = !showPrivateLogin.value;
}

function openRemoteSignerLogin() {
  if (loading.value || !nip46Enabled) return;
  errorMessage.value = "";
  showRegister.value = false;
  showPrivateLogin.value = false;
  showRemoteSigner.value = !showRemoteSigner.value;
}

async function doLoginNip46() {
  if (loading.value || !nip46Enabled) return;
  const input = bunkerInput.value.trim();
  if (!input) {
    errorMessage.value = "请输入 Bunker URL 或 NIP-05 地址";
    return;
  }
  loading.value = true;
  errorMessage.value = "";
  loginStatus.value = "正在连接远程签名器…";
  try {
    await ks.loginWithNip46(input);
    await finishLogin();
  } catch (error) {
    logLoginFailure("nip46", "connect", error);
    const reason = error instanceof Error ? error.message : "";
    errorMessage.value = reason === "remote_signer_feature_disabled"
      ? "远程签名器 Beta 当前未启用"
      : reason === "invalid_remote_signer_input" || reason === "invalid_remote_signer_relays"
        ? "Bunker 地址无效或没有可用的安全 Relay"
        : "远程签名器连接失败，请检查签名器与 Relay 后重试。";
  } finally {
    loading.value = false;
    loginStatus.value = "";
  }
}

function startRegistration() {
  if (loading.value) return;
  errorMessage.value = "";
  showPrivateLogin.value = false;
  showRemoteSigner.value = false;
  showRegister.value = true;
  registrationConfirmed.value = false;
  copiedNsec.value = false;
  generatedNsec.value = nip19.nsecEncode(generateSecretKey());
}

async function copyGeneratedNsec() {
  if (!generatedNsec.value) return;
  try {
    await navigator.clipboard.writeText(generatedNsec.value);
    copiedNsec.value = true;
  } catch {
    errorMessage.value = "无法自动复制，请长按私钥手动复制。";
  }
}

function cancelRegistration() {
  generatedNsec.value = "";
  registrationConfirmed.value = false;
  copiedNsec.value = false;
  showRegister.value = false;
}

async function finishRegistration() {
  if (loading.value || !generatedNsec.value || !registrationConfirmed.value) return;
  loading.value = true;
  errorMessage.value = "";
  loginStatus.value = "正在加密并创建账号…";
  try {
    await ks.loginWithNsec(generatedNsec.value);
    await finishLogin();
  } catch (error) {
    logLoginFailure("register", "create-account", error);
    errorMessage.value = "创建账号失败，请重试。";
  } finally {
    loading.value = false;
    loginStatus.value = "";
  }
}

async function switchAccount() {
  if (loading.value) return;
  loading.value = true;
  clearSensitiveInputs();
  errorMessage.value = "";
  loginStatus.value = "";
  try {
    await ks.clearActiveSession();
    ks.refreshAccounts();
  } finally {
    loading.value = false;
  }
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
.login-form { display: grid; gap: 12px; }
.login-divider{display:flex;align-items:center;gap:10px;color:#5f6b7c;font-size:.72rem;text-align:center}
.login-divider::before,.login-divider::after{content:"";height:1px;flex:1;background:#273142}
.login-divider span{flex:0 0 auto}
.account-picker { display: grid; gap: 8px; margin-bottom: 10px; }
.picker-title { margin: 0 0 2px; color: #8d99aa; font-size: .78rem; }
.account-mode-title{margin-top:2px;margin-bottom:0;text-align:center}
.account-option { display:grid; border:1px solid #293445; border-radius:12px; overflow:hidden; }
.account-select { display:grid; min-width:0; gap:4px; padding:11px 12px; border:0; background:transparent; color:#d8dee9; text-align:left; cursor:pointer; }
.account-select strong { overflow:hidden; font: .82rem ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; }
.account-select small { color:#748095; font-size:.72rem; }
.account-device-actions{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #293445}
.account-device-action{min-height:40px;padding:0 10px;border:0;background:#0d141d;color:#8d99aa;font-size:.72rem;cursor:pointer}
.account-device-action+.account-device-action{border-left:1px solid #293445}
.account-device-action-danger{color:#d28f8f}
.account-device-action:disabled{cursor:not-allowed;opacity:.55}
.private-login { margin-top:4px; padding-top:18px; border-top:1px solid #252e3c; }
.registration-panel { display:grid; gap:14px; }
.registration-title { margin:0; color:#cbd2dd; font-size:1rem; font-weight:600; }
.registration-key { min-height:104px; resize:none; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
.registration-confirm { display:flex; gap:10px; align-items:flex-start; color:#aab2c0; font-size:.82rem; line-height:1.45; }
.registration-confirm input { margin-top:3px; }

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

.device-login-title {
  margin: 0 0 5px;
  color: #d8dee9;
  font-size: .9rem;
  font-weight: 650;
}

.login-options {
  margin-top: 10px;
  color: #9da8b8;
  font-size: .82rem;
}

.login-options summary {
  min-height: 40px;
  cursor: pointer;
}

.login-option {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 9px;
  color: #b8c1cf;
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

#unlock-password:-webkit-autofill {
  animation-name: hainei-password-autofill;
  animation-duration: 0.01s;
}

@keyframes hainei-password-autofill {
  from { opacity: 0.99; }
  to { opacity: 1; }
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
