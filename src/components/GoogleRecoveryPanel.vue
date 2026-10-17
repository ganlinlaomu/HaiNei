<template>
  <button
    v-if="phase === 'idle' && googleWebSupported && !hideTrigger"
    class="google-login-button"
    type="button"
    :disabled="busy"
    @click="beginGoogle"
  >
    <span class="google-mark" aria-hidden="true">G</span>
    <span>使用Google登录</span>
  </button>
  <p v-if="phase === 'idle' && errorMessage && !hideTrigger" class="inline-google-error" role="alert">{{ errorMessage }}</p>

  <div v-if="phase !== 'idle'" class="recovery-overlay" role="dialog" aria-modal="true" aria-labelledby="google-recovery-title">
    <section class="recovery-sheet">
      <button class="close-button" type="button" :disabled="busy" aria-label="关闭" @click="close">×</button>
      <div class="provider-heading">
        <span class="google-mark large" aria-hidden="true">G</span>
        <div v-if="isBackup">
          <h2 id="google-recovery-title">备份到 Google 账号</h2>
          <p>先在这台手机上加密，再保存到 Google Drive 应用数据区，Google 和海内都看不到内容。</p>
        </div>
        <div v-else>
          <h2 id="google-recovery-title">使用Google登录</h2>
          <p>私钥只会以加密形式保存到 Google Drive 应用数据区。</p>
        </div>
      </div>

      <div v-if="phase === 'signing-in' || phase === 'checking' || phase === 'working'" class="working-state">
        <span class="spinner" aria-hidden="true"></span>
        <strong>{{ workingLabel }}</strong>
      </div>

      <form v-else-if="phase === 'setup-pin'" class="recovery-form" @submit.prevent="submitSetupPin">
        <h3>设置恢复 PIN</h3>
        <p>这是新设备恢复海内账号时使用的 6–8 位数字。Google 不会知道这个 PIN。</p>
        <p v-if="isBackup && backups.length" class="recovery-hint">这个 Google 账号里已有海内备份，建议使用和之前相同的 PIN，恢复时可以一次看到全部账号。</p>
        <label for="google-recovery-pin">恢复 PIN</label>
        <input
          id="google-recovery-pin"
          v-model="pin"
          class="recovery-input"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          maxlength="8"
          placeholder="6–8 位数字"
          :disabled="busy"
        />
        <button class="primary-action" type="submit" :disabled="busy || !pinValid">继续</button>
      </form>

      <form v-else-if="phase === 'confirm-pin'" class="recovery-form" @submit.prevent="confirmSetupPin">
        <h3>再次输入恢复 PIN</h3>
        <p v-if="isBackup">确认后会把加密备份保存到你的 Google Drive。请记住这个 PIN，恢复时需要用到。</p>
        <p v-else>确认后会生成新的 Nostr 私钥，并把加密备份保存到你的 Google Drive。</p>
        <label for="google-recovery-pin-confirm">确认 PIN</label>
        <input
          id="google-recovery-pin-confirm"
          v-model="pin"
          class="recovery-input"
          type="password"
          inputmode="numeric"
          autocomplete="new-password"
          maxlength="8"
          placeholder="再次输入"
          :disabled="busy"
        />
        <button class="primary-action" type="submit" :disabled="busy || !pinValid">{{ isBackup ? backupActionLabel : "创建并进入海内" }}</button>
        <button class="text-action" type="button" :disabled="busy" @click="backToSetupPin">返回修改 PIN</button>
      </form>

      <form v-else-if="phase === 'restore-pin'" class="recovery-form" @submit.prevent="restoreBackups">
        <h3>输入恢复 PIN</h3>
        <p>已找到 {{ backups.length }} 个海内加密备份。PIN 正确后会显示可恢复的账号。</p>
        <label for="google-restore-pin">恢复 PIN</label>
        <input
          id="google-restore-pin"
          v-model="pin"
          class="recovery-input"
          type="password"
          inputmode="numeric"
          autocomplete="current-password"
          maxlength="8"
          placeholder="6–8 位数字"
          :disabled="busy"
        />
        <button class="primary-action" type="submit" :disabled="busy || !pinValid">查看我的账号</button>
      </form>

      <div v-else-if="phase === 'choose'" class="choose-state">
        <h3>选择要进入的账号</h3>
        <div class="backup-list">
          <button
            v-for="account in recoveredAccounts"
            :key="account.backupId"
            class="backup-account"
            type="button"
            :disabled="busy"
            @click="complete(account)"
          >
            <strong>{{ shortNpub(account.npub) }}</strong>
            <span>Google Drive 加密备份</span>
          </button>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="createAnotherAccount">
          创建新的海内账号
        </button>
      </div>

      <p v-if="errorMessage" class="recovery-error" role="alert">{{ errorMessage }}</p>
      <p class="recovery-footnote">Google 只用于保存加密备份；进入海内后仍只在本机使用你的账号钥匙。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import {
  decryptRecoveryPrivateKey,
  deriveRecoveryKey,
  encryptRecoveryPrivateKey,
  isValidRecoveryPin,
} from "@/services/recovery/backupCrypto";
import { preloadGoogleIdentityServices } from "@/services/recovery/googleAuth";
import { beginRecovery } from "@/services/recovery/recoveryService";
import type { RecoveryBackup, RecoveryProviderAdapter } from "@/services/recovery/types";

type Phase =
  | "idle"
  | "signing-in"
  | "checking"
  | "setup-pin"
  | "confirm-pin"
  | "restore-pin"
  | "choose"
  | "working";

type RecoveredAccount = {
  backupId: string;
  npub: string;
  pubkey: string;
  skHex: string;
};

const props = withDefaults(defineProps<{
  clientId: string;
  /** "backup" encrypts backupSecretHex instead of creating or restoring an account. */
  mode?: "recover" | "backup";
  backupSecretHex?: string;
  backupActionLabel?: string;
  /** Hide the built-in Google button; the parent calls the exposed begin(). */
  hideTrigger?: boolean;
}>(), { mode: "recover", backupSecretHex: "", backupActionLabel: "备份并进入", hideTrigger: false });
const emit = defineEmits<{
  complete: [payload: { skHex: string; backupId: string; isNewAccount: boolean }];
  "backed-up": [payload: { backupId: string }];
  error: [message: string];
}>();
const isBackup = computed(() => props.mode === "backup");

const phase = ref<Phase>("idle");
const nativeContainer = (window as Window & {
  Capacitor?: { isNativePlatform?: () => boolean };
}).Capacitor?.isNativePlatform?.() === true;
const googleWebSupported = computed(() => !!props.clientId && !nativeContainer);
const busy = computed(() => phase.value === "signing-in" || phase.value === "checking" || phase.value === "working");
const pin = ref("");
const setupPin = ref("");
const errorMessage = ref("");
const backups = ref<RecoveryBackup[]>([]);
const recoveredAccounts = ref<RecoveredAccount[]>([]);

let provider: RecoveryProviderAdapter | null = null;
let recoveryKey: Uint8Array | null = null;

const pinValid = computed(() => isValidRecoveryPin(pin.value));
const workingLabel = computed(() => {
  if (phase.value === "signing-in") return "正在连接 Google…";
  if (phase.value === "checking") return "正在检查 Google Drive 备份…";
  return "正在安全处理账号…";
});

onMounted(() => {
  if (googleWebSupported.value) void preloadGoogleIdentityServices().catch(() => undefined);
});

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function accountFromPrivateKey(skHex: string, backupId: string): RecoveredAccount {
  const pubkey = getPublicKey(hexToBytes(skHex));
  return {
    backupId,
    npub: nip19.npubEncode(pubkey),
    pubkey,
    skHex,
  };
}

function shortNpub(npub: string) {
  return npub.length > 24 ? `${npub.slice(0, 15)}…${npub.slice(-7)}` : npub;
}

async function beginGoogle() {
  if (!googleWebSupported.value || busy.value) return;
  errorMessage.value = "";
  phase.value = "signing-in";
  try {
    provider = await beginRecovery("google", { googleClientId: props.clientId });
    phase.value = "checking";
    backups.value = await provider.listBackups();
    pin.value = "";
    phase.value = backups.value.length && !isBackup.value ? "restore-pin" : "setup-pin";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      phase.value = "idle";
      return;
    }
    errorMessage.value = error instanceof Error ? error.message : "Google 登录失败，请重试";
    emit("error", errorMessage.value);
    phase.value = "idle";
  }
}

function submitSetupPin() {
  if (!pinValid.value) return;
  setupPin.value = pin.value;
  pin.value = "";
  errorMessage.value = "";
  phase.value = "confirm-pin";
}

function backToSetupPin() {
  pin.value = setupPin.value;
  setupPin.value = "";
  errorMessage.value = "";
  phase.value = "setup-pin";
}

async function confirmSetupPin() {
  if (!pinValid.value || !provider) return;
  if (pin.value !== setupPin.value) {
    errorMessage.value = "两次输入的恢复 PIN 不一致";
    return;
  }

  phase.value = "working";
  errorMessage.value = "";
  try {
    recoveryKey = await deriveRecoveryKey("google", provider.subject, pin.value);
    if (isBackup.value) await uploadExistingAccount();
    else await createAndUploadAccount(true);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "创建 Google 恢复备份失败";
    phase.value = "confirm-pin";
  }
}

async function restoreBackups() {
  if (!pinValid.value || !provider) return;
  phase.value = "working";
  errorMessage.value = "";
  clearRecoveredAccounts();

  try {
    recoveryKey?.fill(0);
    recoveryKey = await deriveRecoveryKey("google", provider.subject, pin.value);
    const recovered: RecoveredAccount[] = [];

    for (const backup of backups.value) {
      const payload = await provider.downloadBackup(backup.id);
      try {
        const skHex = decryptRecoveryPrivateKey(payload, recoveryKey, "google");
        const account = accountFromPrivateKey(skHex, backup.id);
        if (!recovered.some(item => item.pubkey === account.pubkey)) recovered.push(account);
      } catch {
        // A wrong PIN or an unrelated/corrupt backup is intentionally skipped.
      }
    }

    if (!recovered.length) {
      errorMessage.value = "恢复 PIN 不正确，或没有可用的海内备份";
      phase.value = "restore-pin";
      return;
    }

    recoveredAccounts.value = recovered;
    phase.value = "choose";
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "读取 Google 备份失败";
    phase.value = "restore-pin";
  }
}

async function createAndUploadAccount(isFirst: boolean) {
  if (!provider || !recoveryKey) throw new Error("Google 恢复会话已失效");
  const secret = generateSecretKey();
  const skHex = bytesToHex(secret);
  secret.fill(0);
  const payload = encryptRecoveryPrivateKey(skHex, recoveryKey, "google");
  const backup = await provider.uploadBackup(payload);
  emit("complete", { skHex, backupId: backup.id, isNewAccount: true });
  void isFirst;
  resetAfterComplete();
}

async function uploadExistingAccount() {
  if (!provider || !recoveryKey) throw new Error("Google 恢复会话已失效");
  if (!/^[0-9a-f]{64}$/i.test(props.backupSecretHex)) throw new Error("没有可备份的账号");
  const payload = encryptRecoveryPrivateKey(props.backupSecretHex.toLowerCase(), recoveryKey, "google");
  const backup = await provider.uploadBackup(payload);
  emit("backed-up", { backupId: backup.id });
  resetAfterComplete();
}

async function createAnotherAccount() {
  if (!recoveryKey || busy.value) return;
  phase.value = "working";
  errorMessage.value = "";
  try {
    await createAndUploadAccount(false);
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "创建新账号失败";
    phase.value = "choose";
  }
}

function complete(account: RecoveredAccount) {
  emit("complete", {
    skHex: account.skHex,
    backupId: account.backupId,
    isNewAccount: false,
  });
  resetAfterComplete();
}

function resetAfterComplete() {
  clearSensitiveState();
  provider = null;
  backups.value = [];
  errorMessage.value = "";
  phase.value = "idle";
}

function clearRecoveredAccounts() {
  recoveredAccounts.value = recoveredAccounts.value.map(item => ({ ...item, skHex: "" }));
  recoveredAccounts.value = [];
}

function clearSensitiveState() {
  recoveryKey?.fill(0);
  recoveryKey = null;
  clearRecoveredAccounts();
  setupPin.value = "";
  pin.value = "";
}

function close() {
  if (busy.value) return;
  clearSensitiveState();
  provider = null;
  backups.value = [];
  errorMessage.value = "";
  phase.value = "idle";
}

onBeforeUnmount(() => {
  clearSensitiveState();
  provider = null;
});

defineExpose({ begin: beginGoogle, supported: googleWebSupported });
</script>

<style scoped>
.google-login-button{display:flex;width:100%;min-height:54px;align-items:center;justify-content:center;gap:10px;padding:0 18px;border:1px solid var(--hn-border);border-radius:var(--hn-radius-btn);background:var(--hn-card);color:var(--hn-text);font-size:16px;font-weight:600;cursor:pointer}
.google-login-button:active{transform:scale(.99)}
.google-login-button:disabled{opacity:.55;cursor:not-allowed}
.inline-google-error{margin:0;padding:10px 12px;border-radius:12px;background:var(--hn-danger-bg);color:var(--hn-danger);font-size:13px;line-height:1.45}
.google-mark{display:grid;width:22px;height:22px;place-items:center;border-radius:50%;background:#fff;color:#4285f4;font-family:Arial,sans-serif;font-size:18px;font-weight:800;line-height:1}
.google-mark.large{width:40px;height:40px;flex:0 0 40px;border:1px solid var(--hn-border);font-size:24px}
.recovery-overlay{position:fixed;inset:0;z-index:14000;display:flex;align-items:flex-end;justify-content:center;background:rgba(18,22,32,.48)}
.recovery-sheet{position:relative;width:min(100%,460px);max-height:min(88dvh,720px);box-sizing:border-box;overflow-y:auto;padding:26px 24px calc(24px + env(safe-area-inset-bottom));border-radius:24px 24px 0 0;background:var(--hn-bg);color:var(--hn-text);font-family:var(--hn-font-sans);box-shadow:0 -18px 50px rgba(0,0,0,.18)}
.close-button{position:absolute;top:12px;right:14px;width:44px;height:44px;border:0;border-radius:50%;background:var(--hn-secondary-bg);color:var(--hn-text-2);font-size:24px;line-height:1;cursor:pointer}
.provider-heading{display:flex;align-items:flex-start;gap:12px;padding:4px 48px 20px 0}
.provider-heading h2{margin:0;color:var(--hn-text);font-size:19px;line-height:26px}
.provider-heading p{margin:6px 0 0;color:var(--hn-text-2);font-size:13px;line-height:1.55}
.working-state{display:grid;min-height:170px;place-items:center;align-content:center;gap:14px;color:var(--hn-text-2);text-align:center}
.spinner{width:28px;height:28px;border:3px solid var(--hn-secondary-bg);border-top-color:var(--hn-primary);border-radius:50%;animation:spin .8s linear infinite}
.recovery-form,.choose-state{display:grid;gap:12px}
.recovery-form h3,.choose-state h3{margin:0;color:var(--hn-text);font-size:17px}
.recovery-form p{margin:0;color:var(--hn-text-2);font-size:14px;line-height:1.55}
.recovery-form .recovery-hint{padding:10px 12px;border-radius:12px;background:var(--hn-card);color:var(--hn-text-3);font-size:13px}
.recovery-form label{color:var(--hn-text-2);font-size:14px}
.recovery-input{width:100%;min-height:54px;box-sizing:border-box;padding:0 16px;border:1px solid var(--hn-border);border-radius:var(--hn-radius-input);outline:none;background:var(--hn-card);color:var(--hn-text);font-size:17px;letter-spacing:.08em}
.recovery-input:focus{border-color:var(--hn-primary);box-shadow:0 0 0 3px var(--hn-focus-ring)}
.primary-action,.secondary-action{width:100%;min-height:54px;border-radius:var(--hn-radius-btn);font-size:16px;font-weight:600;cursor:pointer}
.primary-action{border:0;background:var(--hn-primary);color:var(--hn-on-primary)}
.secondary-action{border:0;background:var(--hn-secondary-bg);color:var(--hn-text)}
.text-action{min-height:44px;border:0;background:transparent;color:var(--hn-text-2);font-size:14px;cursor:pointer}
.primary-action:disabled,.secondary-action:disabled,.text-action:disabled{opacity:.5;cursor:not-allowed}
.backup-list{display:grid;gap:9px}
.backup-account{display:grid;gap:4px;min-height:64px;padding:10px 14px;border:1px solid var(--hn-border);border-radius:16px;background:var(--hn-card);color:var(--hn-text);text-align:left;cursor:pointer}
.backup-account strong{overflow:hidden;font: 13px ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.backup-account span{color:var(--hn-text-3);font-size:12px}
.recovery-error{margin:14px 0 0;padding:10px 12px;border-radius:12px;background:var(--hn-danger-bg);color:var(--hn-danger);font-size:14px;line-height:1.45}
.recovery-footnote{margin:18px 0 0;color:var(--hn-text-3);font-size:12px;line-height:1.5;text-align:center}
@keyframes spin{to{transform:rotate(360deg)}}
@media(min-width:700px){.recovery-overlay{align-items:center}.recovery-sheet{border-radius:22px;padding-bottom:26px}}
</style>
