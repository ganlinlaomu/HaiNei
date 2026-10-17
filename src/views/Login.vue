<template>
  <div class="login-root">
    <section v-if="pageMode === 'restoring'" class="hn-screen restoring-panel">
      <p class="hn-notice hn-notice-status" role="status" aria-live="polite">正在恢复会话…</p>
    </section>

    <form v-else-if="pageMode === 'unlock'" class="hn-screen unlock-form" @submit.prevent="doUnlock">
      <div class="hn-body unlock-body">
        <span class="hn-avatar unlock-avatar" :style="{ '--hn-avatar-color': accountColor(ks.pkHex) }" aria-hidden="true">
          <img v-if="currentAccount?.avatarThumb" :src="currentAccount.avatarThumb" alt="" />
          <template v-else>{{ accountInitial(currentAccount || {}) }}</template>
        </span>
        <h1 class="hn-title unlock-title">欢迎回来</h1>
        <p class="hn-subtitle unlock-name">{{ currentAccountName }}</p>

        <template v-if="hasPasswordFallback && (!biometricEnabled || passwordFallbackVisible)">
          <label class="hn-field unlock-field">
            <span class="hn-label">本地保护密码</span>
            <input
              id="unlock-password"
              ref="unlockPasswordEl"
              v-model="unlockPassword"
              class="hn-input"
              type="password"
              autocomplete="current-password"
              placeholder="输入本地保护密码"
              :disabled="loading"
              @change="handleUnlockAutofill"
              @animationstart="handleUnlockAutofill"
            />
          </label>
        </template>
        <p v-else-if="!biometricEnabled" class="hn-note unlock-hint">此账号由{{ biometricLabel }}保护。若无法验证，可重新输入私钥恢复。</p>
      </div>

      <div class="hn-actions">
        <p v-if="loginStatus" class="hn-notice hn-notice-status" role="status" aria-live="polite">{{ loginStatus }}</p>
        <p v-if="errorMessage" class="hn-notice hn-notice-error" role="alert">{{ errorMessage }}</p>

        <template v-if="biometricEnabled && !passwordFallbackVisible">
          <button class="hn-btn hn-btn-primary biometric-login-button" type="button" :disabled="loading" @click="doBiometricUnlock(false)">
            {{ loading ? `正在验证 ${biometricLabel}…` : `用 ${biometricLabel} 进入` }}
          </button>
          <button v-if="hasPasswordFallback" class="hn-btn hn-btn-text" type="button" :disabled="loading" @click="showPasswordFallback">
            使用本地密码
          </button>
        </template>
        <template v-else-if="hasPasswordFallback">
          <button class="hn-btn hn-btn-primary" type="submit" :disabled="loading">
            {{ loading ? "正在解锁…" : "解锁" }}
          </button>
          <button v-if="biometricEnabled" class="hn-btn hn-btn-text" type="button" :disabled="loading" @click="passwordFallbackVisible = false; doBiometricUnlock(false)">
            用 {{ biometricLabel }} 进入
          </button>
        </template>
        <button v-else class="hn-btn hn-btn-primary biometric-login-button" type="button" :disabled="loading" @click="doBiometricUnlock(false)">
          {{ loading ? `正在验证 ${biometricLabel}…` : `用 ${biometricLabel} 进入` }}
        </button>

        <button class="hn-btn hn-btn-secondary" type="button" :disabled="loading" @click="switchAccount">
          切换账号
        </button>
      </div>
    </form>

    <template v-else>
      <WelcomeScreen v-if="step === 'welcome'" @start="startRegistration" @have-account="go('methods')">
        <template #notice><LoginNotice /></template>
      </WelcomeScreen>

      <CreateNameStep
        v-else-if="step === 'create-name'"
        v-model:name="registrationName"
        :avatar-preview="registrationAvatarPreview"
        :loading="loading"
        @update:avatar="setRegistrationAvatar"
        @back="back"
        @next="continueToBackup"
      >
        <template #notice><LoginNotice /></template>
      </CreateNameStep>

      <CreateBackupStep
        v-else-if="step === 'create-backup'"
        :nsec="generatedNsec"
        :google-available="googleRecoveryEnabled"
        :loading="loading"
        @back="back"
        @google="beginRegistrationBackup"
        @skip="finishRegistration"
        @copy-failed="errorMessage = '无法自动复制，请长按私钥手动复制。'"
      >
        <template #notice><LoginNotice /></template>
      </CreateBackupStep>

      <LoginMethodsScreen
        v-else-if="step === 'methods'"
        :google-available="googleRecoveryEnabled"
        :device-pair-path="DEVICE_PAIR_PATH"
        :loading="loading"
        @back="back"
        @scan="openDevicePair"
        @google="beginGoogleRecovery"
        @private-key="go('private-key')"
        @create="startRegistration"
      >
        <template #notice><LoginNotice /></template>
      </LoginMethodsScreen>

      <PrivateKeyScreen
        v-else-if="step === 'private-key'"
        v-model="nsecInput"
        :biometric-name="biometricLabel"
        :loading="loading"
        @back="back"
        @paste="pastePrivateKey"
        @submit="doLoginNsec"
      >
        <template #notice><LoginNotice /></template>
      </PrivateKeyScreen>

      <AccountListScreen
        v-else
        :accounts="ks.accounts"
        :biometric-name="biometricLabel"
        :has-biometric="pubkey => ks.hasBiometricUnlock(pubkey)"
        :loading="loading"
        @enter="selectAccount"
        @add="go('methods')"
        @forget="removeAccount"
        @delete="deleteDeviceData"
      >
        <template #notice><LoginNotice /></template>
      </AccountListScreen>

      <GoogleRecoveryPanel
        v-if="googleRecoveryEnabled && step === 'methods'"
        ref="recoveryPanel"
        :client-id="googleClientId"
        hide-trigger
        @complete="finishGoogleRecovery"
        @error="message => errorMessage = message"
      />
      <GoogleRecoveryPanel
        v-if="googleRecoveryEnabled && step === 'create-backup' && pendingSecretHex"
        ref="backupPanel"
        :client-id="googleClientId"
        mode="backup"
        :backup-secret-hex="pendingSecretHex"
        hide-trigger
        @backed-up="finishRegistration"
        @error="message => errorMessage = message"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import "@/components/login/loginScreens.css";
import { computed, defineAsyncComponent, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { generateSecretKey, nip19 } from "nostr-tools";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { accountColor, accountDisplayName, accountInitial } from "@/services/accountRegistry";
import { saveNewAccountProfile } from "@/services/newAccountProfile";
import { createAvatarThumb } from "@/utils/avatarThumb";
import { biometricMethodLabel } from "@/utils/biometricLabel";
import WelcomeScreen from "@/components/login/WelcomeScreen.vue";
import CreateNameStep from "@/components/login/CreateNameStep.vue";
import CreateBackupStep from "@/components/login/CreateBackupStep.vue";
import LoginMethodsScreen from "@/components/login/LoginMethodsScreen.vue";
import PrivateKeyScreen from "@/components/login/PrivateKeyScreen.vue";
import AccountListScreen from "@/components/login/AccountListScreen.vue";
// Only used when adding/recovering an account; keep it out of the startup
// bundle that every cold start (including the unlock screen) has to parse.
const GoogleRecoveryPanel = defineAsyncComponent(() => import("@/components/GoogleRecoveryPanel.vue"));
import { logger } from "@/utils/logger";

type LoginMethod = "private-key" | "unlock" | "switch" | "register" | "google";
type LoginStep = "welcome" | "create-name" | "create-backup" | "methods" | "private-key" | "accounts";
type GooglePanel = { begin?: () => Promise<void> };

const LOGIN_STEPS: readonly LoginStep[] = ["welcome", "create-name", "create-backup", "methods", "private-key", "accounts"];
const CREATE_STEPS: readonly LoginStep[] = ["create-name", "create-backup"];
/** Where an already signed-in phone starts device pairing. Keep in sync with SystemSettings.vue. */
const DEVICE_PAIR_PATH = "我的 › 设置 › 账户 › 添加设备";

const ks = useKeyStore();
const route = useRoute();
const router = useRouter();

const loading = ref(false);
const errorMessage = ref("");
const loginStatus = ref("");
const nsecInput = ref("");
const unlockPassword = ref("");
const unlockInProgress = ref(false);
const passwordFallbackVisible = ref(false);
const autoBiometricAccount = ref("");
const googleClientId = (import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID || "").trim();
const nativeContainer = (window as Window & {
  Capacitor?: { isNativePlatform?: () => boolean };
}).Capacitor?.isNativePlatform?.() === true;
const googleRecoveryEnabled = !!googleClientId && !nativeContainer;

// Sign-up keeps the new key in memory only; nothing is stored until "进入".
const pendingSecretHex = ref("");
const generatedNsec = ref("");
const registrationName = ref("");
const registrationAvatar = ref<File | null>(null);
const registrationAvatarPreview = ref("");

const unlockPasswordEl = ref<HTMLInputElement | null>(null);
const recoveryPanel = ref<GooglePanel | null>(null);
const backupPanel = ref<GooglePanel | null>(null);

const needsUnlock = computed(() => !!ks.pkHex && ks.isEncrypted && !ks.isUnlocked);
const biometricEnabled = computed(() => !!ks.pkHex && ks.hasBiometricUnlock(ks.pkHex));
const hasPasswordFallback = computed(() => ks.credentialMode === "password");
const biometricLabel = computed(() => biometricMethodLabel());
const addingAccount = computed(() => route.query.mode === "add");
const pageMode = computed<"restoring" | "unlock" | "login">(() => {
  if (ks.isRestoring) return "restoring";
  if (needsUnlock.value || unlockInProgress.value) return "unlock";
  return "login";
});
const currentAccount = computed(() => ks.accounts.find(account => account.pubkey === ks.pkHex));
const currentAccountName = computed(() => currentAccount.value ? accountDisplayName(currentAccount.value) : "这台手机上的账号");

const defaultStep = computed<LoginStep>(() => {
  if (addingAccount.value) return "methods";
  return ks.accounts.length ? "accounts" : "welcome";
});
const step = computed<LoginStep>(() => {
  const requested = route.query.step;
  if (typeof requested !== "string" || !LOGIN_STEPS.includes(requested as LoginStep)) return defaultStep.value;
  if (requested === "accounts" && !ks.accounts.length) return defaultStep.value;
  // A reload drops the in-memory key; restart sign-up instead of showing an empty backup step.
  if (requested === "create-backup" && !pendingSecretHex.value) return "create-name";
  return requested as LoginStep;
});

const LoginNotice = defineComponent({
  name: "LoginNotice",
  setup() {
    return () => [
      loginStatus.value ? h("p", { class: "hn-notice hn-notice-status", role: "status", "aria-live": "polite" }, loginStatus.value) : null,
      errorMessage.value ? h("p", { class: "hn-notice hn-notice-error", role: "alert", "aria-live": "polite" }, errorMessage.value) : null,
    ];
  },
});

function go(next: LoginStep) {
  errorMessage.value = "";
  void router.push({ path: "/login", query: { ...route.query, step: next } });
}

function historyBack(): string {
  const back = router.options.history.state.back;
  return typeof back === "string" ? back : "";
}

function back() {
  if (loading.value) return;
  errorMessage.value = "";
  const previous = historyBack();
  if (previous.startsWith("/login")) {
    router.back();
    return;
  }
  if (addingAccount.value && step.value === defaultStep.value) {
    // Adding an account started from Settings while still signed in: go back there.
    if (previous) router.back();
    else void router.replace(isSafeInternalRedirect(route.query.redirect) ? route.query.redirect : "/settings/system");
    return;
  }
  const { step: _step, ...query } = route.query;
  void router.replace({ path: "/login", query });
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
  await presentUnlockMethod();
});

watch(pageMode, async (mode) => {
  if (mode !== "unlock") return;
  await presentUnlockMethod();
});

watch(step, current => {
  // Leaving the sign-up flow must not leave a half-made account behind.
  if (!CREATE_STEPS.includes(current)) clearRegistration();
});

onBeforeUnmount(() => {
  clearRegistration();
});

function clearRegistration() {
  pendingSecretHex.value = "";
  generatedNsec.value = "";
  registrationName.value = "";
  setRegistrationAvatar(null);
}

function setRegistrationAvatar(file: File | null) {
  if (registrationAvatarPreview.value) URL.revokeObjectURL(registrationAvatarPreview.value);
  registrationAvatar.value = file;
  registrationAvatarPreview.value = file ? URL.createObjectURL(file) : "";
}

function clearSensitiveInputs() {
  nsecInput.value = "";
  unlockPassword.value = "";
  passwordFallbackVisible.value = false;
  clearRegistration();
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

function openDevicePair() {
  // While signed in (adding an account), this phone is the new device.
  void router.push(addingAccount.value ? { path: "/device-pair", query: { role: "receive" } } : "/device-pair");
}

async function beginGoogleRecovery() {
  errorMessage.value = "";
  if (!recoveryPanel.value?.begin) {
    errorMessage.value = "Google 恢复正在加载，请稍后再试。";
    return;
  }
  await recoveryPanel.value.begin();
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

  loading.value = true;
  loginStatus.value = "正在登录…";
  try {
    // Kept signed in on this device; local password / session-only live in Settings › 账号安全.
    await ks.loginWithNsec(privateKey);
    await finishLogin();
  } catch (error) {
    logLoginFailure("private-key", "login", error);
    errorMessage.value = "无法在这台手机上安全保存登录凭据，请重试。";
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

function startRegistration() {
  if (loading.value) return;
  clearRegistration();
  go("create-name");
}

function continueToBackup() {
  if (loading.value || !registrationName.value.trim()) return;
  if (!pendingSecretHex.value) {
    const secret = generateSecretKey();
    pendingSecretHex.value = Array.from(secret, byte => byte.toString(16).padStart(2, "0")).join("");
    generatedNsec.value = nip19.nsecEncode(secret);
    secret.fill(0);
  }
  go("create-backup");
}

async function beginRegistrationBackup() {
  errorMessage.value = "";
  if (!backupPanel.value?.begin) {
    errorMessage.value = "Google 备份正在加载，请稍后再试。";
    return;
  }
  await backupPanel.value.begin();
}

async function finishRegistration() {
  if (loading.value || !pendingSecretHex.value) return;
  const secretHex = pendingSecretHex.value;
  const nickname = registrationName.value.trim();
  const avatar = registrationAvatar.value;
  loading.value = true;
  errorMessage.value = "";
  loginStatus.value = "正在加密并创建账号…";
  try {
    const avatarThumb = avatar ? await createAvatarThumb(avatar).catch(() => "") : "";
    await ks.loginWithNsec(secretHex);
    const account = ks.pkHex;
    await ks.setAccountPresentation(account, { displayName: nickname, avatarThumb });
    void saveNewAccountProfile(account, nickname, avatar).catch(error => logLoginFailure("register", "save-profile", error));
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
.login-root {
  min-height: 100dvh;
  background: var(--hn-bg);
}

.restoring-panel {
  justify-content: center;
}

.unlock-body {
  align-items: center;
  padding-top: 12vh;
  text-align: center;
}

.unlock-avatar {
  width: 88px;
  height: 88px;
  font-size: 34px;
}

.unlock-title { margin-top: 20px; }
.unlock-name { margin-top: 6px; font-size: 17px; font-weight: 600; color: var(--hn-text); }

.unlock-field {
  width: 100%;
  margin-top: 32px;
  text-align: left;
}

.unlock-hint { margin-top: 24px; }

#unlock-password:-webkit-autofill {
  animation-name: hainei-password-autofill;
  animation-duration: 0.01s;
}

@keyframes hainei-password-autofill {
  from { opacity: 0.99; }
  to { opacity: 1; }
}
</style>
