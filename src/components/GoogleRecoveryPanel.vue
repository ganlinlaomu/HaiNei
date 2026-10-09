<template>
  <button
    v-if="phase === 'idle' && googleWebSupported"
    class="google-login-button"
    type="button"
    :disabled="busy"
    @click="beginGoogle"
  >
    <span class="google-mark" aria-hidden="true">G</span>
    <span>使用Google登录</span>
  </button>
  <p v-if="phase === 'idle' && errorMessage" class="inline-google-error" role="alert">{{ errorMessage }}</p>

  <div v-if="phase !== 'idle'" class="recovery-overlay" role="dialog" aria-modal="true" aria-labelledby="google-recovery-title">
    <section class="recovery-sheet">
      <button class="close-button" type="button" :disabled="busy" aria-label="关闭" @click="close">×</button>
      <div class="provider-heading">
        <span class="google-mark large" aria-hidden="true">G</span>
        <div>
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
        <p>确认后会生成新的 Nostr 私钥，并把加密备份保存到你的 Google Drive。</p>
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
        <button class="primary-action" type="submit" :disabled="busy || !pinValid">创建并进入海内</button>
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
      <p class="recovery-footnote">Google 只用于恢复入口；进入海内后仍使用本地 Nostr 私钥签名。</p>
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

const props = defineProps<{ clientId: string }>();
const emit = defineEmits<{
  complete: [payload: { skHex: string; backupId: string; isNewAccount: boolean }];
}>();

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
    phase.value = backups.value.length ? "restore-pin" : "setup-pin";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      phase.value = "idle";
      return;
    }
    errorMessage.value = error instanceof Error ? error.message : "Google 登录失败，请重试";
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
    await createAndUploadAccount(true);
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
</script>

<style scoped>
.google-login-button{display:flex;width:100%;min-height:48px;align-items:center;justify-content:center;gap:10px;padding:0 18px;border:1px solid #3b4657;border-radius:12px;background:#fff;color:#1f2937;font-size:.94rem;font-weight:650;cursor:pointer}
.google-login-button:active{transform:scale(.99)}
.google-login-button:disabled{opacity:.55;cursor:not-allowed}
.inline-google-error{margin:0;padding:8px 10px;border:1px solid #5b3138;border-radius:9px;background:#26171b;color:#f0b7bd;font-size:.76rem;line-height:1.4}
.google-mark{display:grid;width:22px;height:22px;place-items:center;border-radius:50%;background:#fff;color:#4285f4;font-family:Arial,sans-serif;font-size:18px;font-weight:800;line-height:1}
.google-mark.large{width:36px;height:36px;flex:0 0 36px;border:1px solid #dbe2ea;font-size:24px}
.recovery-overlay{position:fixed;inset:0;z-index:14000;display:flex;align-items:flex-end;justify-content:center;background:rgba(2,6,23,.72);backdrop-filter:blur(4px)}
.recovery-sheet{position:relative;width:min(100%,460px);max-height:min(86dvh,720px);box-sizing:border-box;overflow-y:auto;padding:26px 22px calc(24px + env(safe-area-inset-bottom));border-radius:24px 24px 0 0;background:#0f1620;color:#e5e9f0;box-shadow:0 -18px 50px rgba(0,0,0,.34)}
.close-button{position:absolute;top:12px;right:14px;width:38px;height:38px;border:0;border-radius:50%;background:#1b2430;color:#aeb8c7;font-size:26px;line-height:1;cursor:pointer}
.provider-heading{display:flex;align-items:flex-start;gap:12px;padding:4px 42px 20px 0}
.provider-heading h2{margin:0;color:#f2f5f8;font-size:1.15rem}
.provider-heading p{margin:6px 0 0;color:#8491a3;font-size:.78rem;line-height:1.55}
.working-state{display:grid;min-height:170px;place-items:center;align-content:center;gap:14px;color:#c7d0dc;text-align:center}
.spinner{width:28px;height:28px;border:3px solid #334155;border-top-color:#93a4ba;border-radius:50%;animation:spin .8s linear infinite}
.recovery-form,.choose-state{display:grid;gap:12px}
.recovery-form h3,.choose-state h3{margin:0;color:#e4e9f0;font-size:1rem}
.recovery-form p{margin:0;color:#8794a6;font-size:.8rem;line-height:1.55}
.recovery-form label{color:#aab5c4;font-size:.82rem}
.recovery-input{width:100%;min-height:48px;box-sizing:border-box;padding:0 14px;border:1px solid #334155;border-radius:12px;outline:none;background:#111b27;color:#f1f5f9;font-size:17px;letter-spacing:.08em}
.recovery-input:focus{border-color:#64748b;box-shadow:0 0 0 3px rgba(100,116,139,.14)}
.primary-action,.secondary-action{width:100%;min-height:48px;border-radius:12px;font-size:.9rem;font-weight:700;cursor:pointer}
.primary-action{border:0;background:#e8edf4;color:#172033}
.secondary-action{border:1px solid #3b4657;background:#16202c;color:#d5dde8}
.text-action{min-height:40px;border:0;background:transparent;color:#98a6b8;cursor:pointer}
.primary-action:disabled,.secondary-action:disabled,.text-action:disabled{opacity:.5;cursor:not-allowed}
.backup-list{display:grid;gap:9px}
.backup-account{display:grid;gap:4px;min-height:64px;padding:10px 12px;border:1px solid #303b4d;border-radius:12px;background:#111a25;color:#e4e9f0;text-align:left;cursor:pointer}
.backup-account strong{overflow:hidden;font: .8rem ui-monospace,SFMono-Regular,Menlo,monospace;text-overflow:ellipsis;white-space:nowrap}
.backup-account span{color:#77859a;font-size:.72rem}
.recovery-error{margin:14px 0 0;padding:10px 12px;border:1px solid #5b3138;border-radius:10px;background:#26171b;color:#f0b7bd;font-size:.8rem;line-height:1.45}
.recovery-footnote{margin:18px 0 0;color:#667386;font-size:.7rem;line-height:1.5;text-align:center}
@keyframes spin{to{transform:rotate(360deg)}}
@media(min-width:700px){.recovery-overlay{align-items:center}.recovery-sheet{border-radius:22px;padding-bottom:26px}}
</style>
