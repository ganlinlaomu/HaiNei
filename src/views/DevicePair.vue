<template>
  <main class="pair-page">
    <header class="pair-header">
      <button type="button" class="back" :disabled="busy" @click="router.push(keys.isLoggedIn ? '/settings/system' : '/login')">‹ 返回</button>
      <h1>扫描登录新设备</h1>
    </header>
    <p class="description">只在两台设备都由你本人操作时使用。私钥在设备之间端对端加密传送，不会以明文存放在服务器。</p>

    <section v-if="mode === 'receive'" class="pair-panel">
      <h2>新设备</h2>
      <p>用已登录的海内扫描下面的二维码，核对两端的 6 位验证码。</p>
      <div v-if="qrMarkup" class="qr-holder" v-html="qrMarkup"></div>
      <button v-if="!session" type="button" class="primary" :disabled="busy" @click="startReceiving">{{ busy ? '正在创建…' : '生成一次性登录二维码' }}</button>
      <template v-if="session">
        <p class="expires">二维码有效期 5 分钟，过期自动作废</p>
        <p v-if="!verificationCode" class="wait">等待旧设备扫描和发起配对…</p>
        <div v-else class="confirm">
          <p>请核对旧设备上显示的验证码</p>
          <strong class="digits">{{ verificationCode }}</strong>
          <p class="identity">来源账号：{{ identityLabel }}</p>
          <label class="check"><input type="checkbox" v-model="receiverVerified" /> 两台设备显示的验证码相同，且确认为我的旧设备</label>
          <button type="button" class="primary" :disabled="busy || !receiverVerified || !snapshot?.ciphertext" @click="finishReceiving">{{ busy ? '正在安全登录…' : snapshot?.ciphertext ? '确认并在此设备登录' : '等待旧设备授权…' }}</button>
        </div>
        <button type="button" class="secondary" :disabled="busy" @click="resetSession">取消此次配对</button>
      </template>
    </section>

    <section v-else class="pair-panel">
      <h2>旧设备</h2>
      <p v-if="!canSend">请先用本机私钥登入并解锁旧设备。远程签名器不支持私钥接力。</p>
      <template v-else>
        <p>请扫描新设备的登录二维码。核对验证码后，才会开始加密交接。</p>
        <button v-if="!verificationCode" type="button" class="primary" :disabled="busy" @click="scannerOpen = true">扫描新设备二维码</button>
        <template v-if="verificationCode">
          <strong class="digits">{{ verificationCode }}</strong>
          <p>请确认新设备显示的六位数字完全相同；否则立即取消。</p>
          <label class="check"><input type="checkbox" v-model="senderVerified" /> 我亲自核对了新设备验证码</label>
          <button type="button" class="primary" :disabled="busy || !senderVerified" @click="approveTransfer">{{ busy ? '正在授权…' : '授权这台新设备登录' }}</button>
          <button type="button" class="secondary" :disabled="busy" @click="clearSender">取消</button>
        </template>
      </template>
      <p v-if="transferSent" class="success">加密登录凭据已送往新设备，请在新设备点击确认登录。</p>
    </section>
    <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p>
    <QrScannerSheet :open="scannerOpen" title="扫描新设备登录二维码" @close="scannerOpen = false" @scanned="handleScan" />
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getPublicKey, utils } from "nostr-tools";
import qrcode from "qrcode-generator";
import { useRoute, useRouter } from "vue-router";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { completeDevicePairLogin } from "@/services/devicePairCompletion";
import QrScannerSheet from "@/components/QrScannerSheet.vue";
import {
  createPair, deliverPair, endPair, makePairKeys, offerPair, openKey, pairLink,
  pairingCode, parsePairLink, pollPair, sealKey,
  type PairKeys, type PairSession, type PairSnapshot,
} from "@/services/devicePairing";

const keys = useKeyStore();
const ui = useUIStore();
const route = useRoute();
const router = useRouter();
const busy = ref(false);
const scannerOpen = ref(false);
const errorMessage = ref("");
const mode = ref<"send" | "receive">("receive");
const verificationCode = ref("");
const receiverVerified = ref(false);
const senderVerified = ref(false);
const transferSent = ref(false);
const session = ref<PairSession | null>(null);
const snapshot = ref<PairSnapshot | null>(null);
const senderTarget = ref<{ id: string; receiverKey: string } | null>(null);
let receiverKeys: PairKeys | null = null;
let senderKeys: PairKeys | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let finished = false;
let handoffInProgress = false;
let disposed = false;
const canSend = computed(() => keys.isLoggedIn && keys.loginMethod === "private-key" && keys.isUnlocked && /^[0-9a-f]{64}$/.test(keys.skHex));
const identityLabel = computed(() => snapshot.value?.senderPubkey ? `${snapshot.value.senderPubkey.slice(0, 12)}…${snapshot.value.senderPubkey.slice(-8)}` : "");
const qrMarkup = computed(() => {
  if (!session.value) return "";
  const qr = qrcode(0, "M");
  qr.addData(pairLink(session.value), "Byte");
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
});
function message(error: unknown) {
  const code = error instanceof Error ? error.message : "unknown";
  if (code === "pair_expired") return "配对已过期，请重新生成二维码";
  if (code === "pair_already_claimed") return "二维码已被其他设备使用，请在新设备重新生成";
  if (code === "pair_identity_mismatch" || code === "OperationError") return "加密验证失败，请停止配对并重试";
  return "设备配对失败：" + code;
}
function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  generation++;
}
async function resetSession() {
  stopPolling();
  const previous = session.value;
  session.value = null; receiverKeys = null; snapshot.value = null;
  receiverVerified.value = false; verificationCode.value = ""; errorMessage.value = "";
  if (previous && !finished) void endPair(previous, true).catch(() => {});
}
async function startReceiving() {
  if (busy.value) return;
  await resetSession();
  mode.value = "receive";
  busy.value = true;
  try {
    const pair = await makePairKeys();
    const result = await createPair(pair.publicKey);
    receiverKeys = pair;
    session.value = result;
    finished = false;
    const run = ++generation;
    void pollUntilDone(run);
  } catch (error) {
    errorMessage.value = message(error);
  } finally { busy.value = false; }
}
async function pollUntilDone(run: number) {
  if (run !== generation || !session.value || !receiverKeys || finished) return;
  const current = session.value;
  if (Date.now() >= current.expiresAt * 1000) {
    errorMessage.value = "二维码已过期，请重新生成"; stopPolling(); return;
  }
  try {
    const state = await pollPair(current);
    if (run !== generation || !session.value || session.value.id !== current.id) return;
    // Once offered, the sender identity and ECDH key remain immutable on the Worker.
    if (state.senderKey && state.senderPubkey && !verificationCode.value) {
      verificationCode.value = await pairingCode(receiverKeys.privateKey, state.senderKey, current.id);
    }
    if (run !== generation) return;
    snapshot.value = state;
  } catch (error) {
    if (run !== generation) return;
    if (error instanceof Error && error.message === "pair_expired") {
      errorMessage.value = message(error); stopPolling(); return;
    }
    // A transient network failure must not discard the receiver's ephemeral key.
  }
  if (run === generation && !finished) pollTimer = setTimeout(() => void pollUntilDone(run), 2_500);
}
async function finishReceiving() {
  if (busy.value || !receiverVerified.value || !session.value || !receiverKeys || !snapshot.value?.ciphertext ||
      !snapshot.value.iv || !snapshot.value.senderKey || !snapshot.value.senderPubkey) return;

  // Preserve a fixed handoff snapshot: signing in changes App.vue's account-scoped
  // keep-alive key and unmounts this component before loginWithNsec resolves.
  const pairing = session.value;
  const ephemeral = receiverKeys;
  const envelope = snapshot.value;
  const expectedAccount = envelope.senderPubkey!.toLowerCase();
  handoffInProgress = true;
  busy.value = true;
  errorMessage.value = "";
  try {
    await completeDevicePairLogin({
      importAccount: async () => {
        const skHex = await openKey(ephemeral.privateKey, envelope.senderKey!, pairing.id,
          envelope.ciphertext!, envelope.iv!, expectedAccount);
        await keys.loginWithNsec(skHex);
      },
      accountReady: () => keys.isLoggedIn && keys.isUnlocked && keys.pkHex.toLowerCase() === expectedAccount,
      acknowledge: () => endPair(pairing),
      onSuccess: () => {
        finished = true;
        stopPolling();
        ui.addToast("新设备登录成功", 3_200, "success");
      },
      navigateHome: async () => {
        await router.replace("/");
        if (router.currentRoute.value.path !== "/") throw new Error("pair_home_navigation_failed");
      },
    });
  } catch (error) {
    const authenticated = keys.isLoggedIn && keys.isUnlocked && keys.pkHex.toLowerCase() === expectedAccount;
    const notice = authenticated
      ? "账号已登录，但自动跳转首页失败，请点击进入首页。"
      : message(error);
    if (!disposed) errorMessage.value = notice;
    else ui.addToast(notice, 4_000, "error");
    if (authenticated) void router.replace("/").catch(() => {});
  } finally {
    handoffInProgress = false;
    busy.value = false;
    if (disposed) {
      session.value = null;
      receiverKeys = null;
      snapshot.value = null;
    }
  }
}
function clearSender() {
  senderTarget.value = null; senderKeys = null; senderVerified.value = false;
  verificationCode.value = ""; errorMessage.value = ""; transferSent.value = false;
}
async function handleScan(raw: string) {
  scannerOpen.value = false;
  const target = parsePairLink(raw);
  if (!target) { errorMessage.value = "不是有效的海内设备配对二维码"; return; }
  if (!canSend.value) { errorMessage.value = "请先解锁旧设备上的私钥账号"; return; }
  clearSender();
  busy.value = true;
  try {
    const pair = await makePairKeys();
    await offerPair(keys, target.id, target.receiverKey, pair.publicKey);
    senderTarget.value = target; senderKeys = pair;
    verificationCode.value = await pairingCode(pair.privateKey, target.receiverKey, target.id);
  } catch (error) { errorMessage.value = message(error); }
  finally { busy.value = false; }
}
async function approveTransfer() {
  if (busy.value || !senderVerified.value || !senderTarget.value || !senderKeys || !canSend.value) return;
  busy.value = true;
  const account = keys.pkHex, generationAtStart = keys.sessionGeneration;
  try {
    // A fresh account/session check prevents authorizing an account switched mid-pair.
    const sk = keys.skHex;
    if (getPublicKey(utils.hexToBytes(sk)) !== account) throw new Error("account_changed");
    const sealed = await sealKey(senderKeys.privateKey, senderTarget.value.receiverKey, senderTarget.value.id, sk, account);
    if (keys.pkHex !== account || keys.sessionGeneration !== generationAtStart || !canSend.value) throw new Error("account_changed");
    await deliverPair(keys, senderTarget.value.id, sealed.ciphertext, sealed.iv);
    transferSent.value = true;
    clearSender();
    transferSent.value = true;
  } catch (error) { errorMessage.value = message(error); }
  finally { busy.value = false; }
}
onMounted(() => {
  const incoming = typeof route.query.pair === "string" ? route.query.pair : "";
  if (keys.isLoggedIn) {
    mode.value = "send";
    if (incoming) {
      const url = `${window.location.origin}${window.location.pathname}#/device-pair?pair=${incoming}`;
      void handleScan(url);
    }
  } else {
    mode.value = "receive";
  }
});
onBeforeUnmount(() => {
  disposed = true;
  stopPolling();
  // A successful account import remounts the route mid-await. Do not revoke
  // the one-time handoff or destroy its saved state until the login flow settles.
  if (handoffInProgress) return;
  const previous = session.value;
  if (previous && !finished) void endPair(previous, true).catch(() => {});
  session.value = null; receiverKeys = null; senderKeys = null;
});
</script>

<style scoped>
.pair-page{box-sizing:border-box;max-width:530px;margin:0 auto;min-height:100dvh;padding:22px 18px calc(35px + env(safe-area-inset-bottom));background:var(--surface,#fff);color:var(--text,#172033)}
.pair-header{display:flex;align-items:center;gap:14px}.pair-header h1{font-size:20px;margin:0}.back{border:0;background:transparent;color:#1687e8;font-size:16px;padding:8px 0}
.description,.pair-panel p{color:#64748b;line-height:1.65;font-size:14px}
.pair-panel{border:1px solid #e2e8f0;border-radius:18px;padding:20px;margin-top:22px}.pair-panel h2{font-size:18px;margin:0}
.qr-holder{background:#fff;max-width:270px;margin:18px auto}.qr-holder :deep(svg){display:block;width:100%;height:auto}
.primary,.secondary{width:100%;min-height:46px;margin-top:16px;border:0;border-radius:12px;font-weight:700}
.primary{color:white;background:#1687e8}.primary:disabled{opacity:.5}.secondary{background:#eef2f7;color:#334155}
.expires,.wait{text-align:center}.digits{display:block;font-size:39px;letter-spacing:5px;text-align:center;color:#172033;margin:18px 0}
.check{display:flex;align-items:start;gap:10px;font-size:14px;color:#334155;line-height:1.6}.check input{width:19px;height:19px;flex-shrink:0}
.identity{text-align:center;word-break:break-all}.error{padding:12px;color:#b91c1c;background:#fef2f2;border-radius:10px;margin-top:14px}.success{color:#16803c!important}
</style>
