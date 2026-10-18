<template>
  <main class="nearby-page app-page">
    <SecondaryPageHeader title="附近传输" :back-to="keys.isLoggedIn ? '/settings' : '/login'" back-label="返回" />

    <p class="nearby-intro">在同一个 Wi-Fi 下，文件直接在设备之间传输，不经过服务器。本机名称：<strong>{{ deviceName }}</strong></p>

    <section v-if="ownDevicesAvailable" class="nearby-card">
      <h2>我的设备</h2>
      <ul v-if="ownPeerList.length" class="peer-list">
        <li v-for="peer in ownPeerList" :key="peer.id" class="peer-row">
          <span class="peer-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2.5" /><path d="M10.5 17.5h3" /></svg></span>
          <span class="peer-name">{{ peer.name }}</span>
          <button class="peer-send" type="button" :disabled="!!activeSend" @click="pickFiles('own', peer.id)">发送文件</button>
        </li>
      </ul>
      <p v-else class="nearby-empty">{{ ownStatus }}</p>
      <button class="link-button" type="button" @click="searchAgain">{{ searching ? "正在重新搜索…" : "重新搜索" }}</button>
    </section>
    <section v-else-if="keys.isLoggedIn" class="nearby-card">
      <h2>我的设备</h2>
      <p class="nearby-empty">远程签名器账号无法自动发现自己的设备，请使用下方的扫码配对。</p>
    </section>

    <section class="nearby-card">
      <h2>和其他设备配对</h2>
      <p class="nearby-hint">没登录海内的电脑、或别人的设备：一方显示二维码，另一方扫码或打开链接。</p>
      <div v-if="!pairKey" class="pair-actions">
        <button class="pair-button" type="button" @click="startPairing">显示二维码</button>
        <button class="pair-button" type="button" @click="scannerOpen = true">扫码</button>
      </div>
      <template v-else>
        <div v-if="pairQr && pairPeerList.length === 0" class="pair-qr">
          <div class="qr-holder" v-html="pairQr"></div>
          <p class="nearby-hint">用另一台设备的海内「附近传输 › 扫码」，或相机扫码打开。</p>
          <button class="link-button" type="button" @click="copyPairLink">{{ copied ? "已复制链接" : "复制链接" }}</button>
        </div>
        <ul v-if="pairPeerList.length" class="peer-list">
          <li v-for="peer in pairPeerList" :key="peer.id" class="peer-row">
            <span class="peer-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg></span>
            <span class="peer-name">{{ peer.name }}</span>
            <button class="peer-send" type="button" :disabled="!!activeSend" @click="pickFiles('pair', peer.id)">发送文件</button>
          </li>
        </ul>
        <p v-else-if="!pairQr" class="nearby-empty">正在连接…</p>
        <button class="link-button" type="button" @click="stopPairing">结束配对</button>
      </template>
    </section>

    <section v-if="transfers.length" class="nearby-card">
      <h2>传输记录</h2>
      <ul class="transfer-list">
        <li v-for="transfer in transfers" :key="transfer.id" class="transfer-row">
          <div class="transfer-head">
            <strong>{{ transfer.direction === "out" ? `发给 ${transfer.peerName}` : `来自 ${transfer.peerName}` }}</strong>
            <span>{{ transferStatus(transfer) }}</span>
          </div>
          <div v-for="(file, index) in transfer.files" :key="index" class="file-row">
            <span class="file-name">{{ file.name }}</span>
            <span class="file-size">{{ formatBytes(file.size) }}</span>
            <progress v-if="transfer.state === 'active' && !transfer.received[index]" :value="transfer.progress[index] || 0" max="1"></progress>
            <template v-if="transfer.received[index]">
              <a class="file-action" :href="objectUrl(transfer.received[index])" :download="file.name">保存</a>
              <button v-if="canShare(transfer.received[index])" class="file-action" type="button" @click="shareFiles([transfer.received[index]])">分享</button>
            </template>
          </div>
        </li>
      </ul>
    </section>

    <details class="nearby-card diagnostics" @toggle="onDiagnosticsToggle">
      <summary>诊断信息</summary>
      <dl v-if="diagnostics" class="diag-list">
        <dt>版本</dt><dd>v{{ APP_VERSION }} · {{ deviceName }}</dd>
        <dt>账号</dt><dd>{{ diagnostics.account ? `${diagnostics.account.slice(0, 6)}…${diagnostics.account.slice(-6)}` : "未登录" }}</dd>
        <dt>房间指纹</dt><dd>{{ diagnostics.ownRoom || "—" }}（两台设备应一致）</dd>
        <dt>房间状态</dt><dd>{{ diagnostics.ownJoined ? "已加入" : "未加入" }} · 本机 ID {{ diagnostics.selfId || "—" }}</dd>
        <dt>Relay</dt><dd><span v-for="relay in diagnostics.relays" :key="relay.host" class="diag-item">{{ relay.host }}：{{ relay.state }}</span><span v-if="!diagnostics.relays.length">尚未连接</span></dd>
        <dt>设备连接</dt><dd><span v-for="(state, id) in diagnostics.ownPeers" :key="id" class="diag-item">{{ String(id).slice(0, 6) }} {{ nearbyState.ownPeers[id] || "" }}：{{ state }}</span><span v-if="!Object.keys(diagnostics.ownPeers).length">无</span></dd>
        <dt>上次重连</dt><dd>{{ diagnostics.lastRefreshAt ? `${Math.round((Date.now() - diagnostics.lastRefreshAt) / 1000)} 秒前` : "—" }}</dd>
      </dl>
    </details>

    <input ref="fileInput" class="hidden-input" type="file" multiple @change="onFilesPicked" />
    <QrScannerSheet :open="scannerOpen" title="扫描配对二维码" @close="scannerOpen = false" @scanned="onScanned" />

    <div v-if="pendingOffer" class="offer-overlay" role="dialog" aria-modal="true" aria-labelledby="offer-title">
      <section class="offer-sheet">
        <h2 id="offer-title">{{ pendingOffer.peerName }} 想发送 {{ pendingOffer.offer.files.length }} 个文件</h2>
        <p class="nearby-hint">共 {{ formatBytes(batchBytes(pendingOffer.offer.files)) }}</p>
        <ul class="offer-files">
          <li v-for="(file, index) in pendingOffer.offer.files.slice(0, 5)" :key="index">{{ file.name }} · {{ formatBytes(file.size) }}</li>
          <li v-if="pendingOffer.offer.files.length > 5">等 {{ pendingOffer.offer.files.length }} 个文件</li>
        </ul>
        <div class="offer-actions">
          <button class="offer-reject" type="button" @click="answerOffer(false)">拒绝</button>
          <button class="offer-accept" type="button" @click="answerOffer(true)">接收</button>
        </div>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { APP_VERSION } from "@/db/dexie";
import { useRoute } from "vue-router";
import qrcode from "qrcode-generator";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import QrScannerSheet from "@/components/QrScannerSheet.vue";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import {
  NEARBY_MAX_BATCH_BYTES,
  batchBytes,
  formatBytes,
  pairingLink,
  parsePairing,
  randomPairingRoom,
  type NearbyRoomKey,
} from "@/services/nearbyTransfer";
import {
  answerPendingOffer,
  ensureOwnDevicesRoom,
  nearbyDiagnostics,
  nearbyState,
  refreshNearbyDiscovery,
  sendNearbyFiles,
  startPairRoom,
  stopPairRoom,
  type NearbyTransferRecord,
  type RoomKind,
} from "@/services/nearbySession";

const keys = useKeyStore();
const ui = useUIStore();
const route = useRoute();
const deviceName = nearbyState.deviceName;

const pairQr = ref("");
const copied = ref(false);
const scannerOpen = ref(false);
const activeSend = ref<{ kind: RoomKind; peerId: string } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const objectUrls = new WeakMap<File, string>();
const searching = ref(false);
const diagnostics = ref<Awaited<ReturnType<typeof nearbyDiagnostics>> | null>(null);
let diagnosticsTimer: ReturnType<typeof setInterval> | null = null;

async function loadDiagnostics() {
  diagnostics.value = await nearbyDiagnostics();
}

function onDiagnosticsToggle(event: Event) {
  const open = (event.target as HTMLDetailsElement).open;
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
  diagnosticsTimer = null;
  if (!open) return;
  void loadDiagnostics();
  diagnosticsTimer = setInterval(() => { void loadDiagnostics(); }, 2_000);
}

/** Manual escape hatch: reconnect to the relays and announce again. */
function searchAgain() {
  searching.value = true;
  refreshNearbyDiscovery();
  void joinOwnRoom();
  setTimeout(() => { searching.value = false; }, 3_000);
}

onBeforeUnmount(() => {
  if (diagnosticsTimer) clearInterval(diagnosticsTimer);
});

const pairKey = computed(() => nearbyState.pairKey);
const pendingOffer = computed(() => nearbyState.pendingOffer);
const transfers = computed(() => nearbyState.transfers);
const ownDevicesAvailable = computed(() => keys.isLoggedIn && keys.loginMethod === "private-key" && /^[0-9a-f]{64}$/.test(keys.skHex));
const ownPeerList = computed(() => Object.entries(nearbyState.ownPeers).map(([id, name]) => ({ id, name })));
const pairPeerList = computed(() => Object.entries(nearbyState.pairPeers).map(([id, name]) => ({ id, name })));
const ownStatus = computed(() => nearbyState.ownJoined
  ? "在你的其他设备上打开「附近传输」，它们会出现在这里。"
  : "正在寻找你的其他设备…");

async function joinOwnRoom() {
  if (!ownDevicesAvailable.value) return;
  try {
    await ensureOwnDevicesRoom(keys.pkHex, keys.skHex);
  } catch {
    ui.addToast("无法连接附近传输服务，请检查网络", 2_400, "error");
  }
}

function renderQr(key: NearbyRoomKey) {
  const qr = qrcode(0, "M");
  qr.addData(pairingLink(key, window.location.origin), "Byte");
  qr.make();
  pairQr.value = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

async function joinPairRoom(key: NearbyRoomKey, showQr: boolean) {
  copied.value = false;
  pairQr.value = "";
  if (showQr) renderQr(key);
  try {
    await startPairRoom(key);
  } catch {
    ui.addToast("无法连接附近传输服务，请检查网络", 2_400, "error");
    pairQr.value = "";
  }
}

function startPairing() {
  void joinPairRoom(randomPairingRoom(), true);
}

async function stopPairing() {
  pairQr.value = "";
  copied.value = false;
  await stopPairRoom();
}

function onScanned(value: string) {
  scannerOpen.value = false;
  const key = parsePairing(value);
  if (!key) {
    ui.addToast("这不是附近传输的配对二维码", 2_000, "error");
    return;
  }
  void joinPairRoom(key, false);
}

async function copyPairLink() {
  if (!pairKey.value) return;
  try {
    await navigator.clipboard.writeText(pairingLink(pairKey.value, window.location.origin));
    copied.value = true;
  } catch {
    ui.addToast("无法自动复制链接", 2_000, "error");
  }
}

function pickFiles(kind: RoomKind, peerId: string) {
  activeSend.value = { kind, peerId };
  fileInput.value?.click();
}

async function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = "";
  const target = activeSend.value;
  if (!target || !files.length) {
    activeSend.value = null;
    return;
  }
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) {
    ui.addToast(`一次最多发送 ${formatBytes(NEARBY_MAX_BATCH_BYTES)}，请分批发送`, 2_600, "error");
    activeSend.value = null;
    return;
  }
  try {
    await sendNearbyFiles(target.kind, target.peerId, files);
  } finally {
    activeSend.value = null;
  }
}

function answerOffer(accept: boolean) {
  answerPendingOffer(accept);
}

function transferStatus(transfer: NearbyTransferRecord) {
  if (transfer.state === "waiting") return transfer.direction === "out" ? "等待对方接收…" : "等待你确认";
  if (transfer.state === "declined") return transfer.direction === "out" ? "对方已拒绝" : "已拒绝";
  if (transfer.state === "failed") return "传输中断";
  if (transfer.state === "done") return transfer.direction === "out" ? "已发送" : "已接收";
  const total = batchBytes(transfer.files) || 1;
  const done = transfer.files.reduce((sum, file, index) => sum + file.size * (transfer.progress[index] || 0), 0);
  return `${Math.floor((done / total) * 100)}%`;
}

function objectUrl(file: File) {
  let url = objectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    objectUrls.set(file, url);
  }
  return url;
}

function canShare(file: File) {
  return typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });
}

async function shareFiles(files: File[]) {
  try {
    await navigator.share({ files });
  } catch {
    // Cancelled from the share sheet.
  }
}

onMounted(() => {
  // Rooms persist across visits; make sure this visit is announced on fresh sockets.
  refreshNearbyDiscovery();
  void joinOwnRoom();
  const pair = typeof route.query.pair === "string" ? parsePairing(route.query.pair) : null;
  if (pair) void joinPairRoom(pair, false);
  // Returning to the page while still pairing: show the same QR again.
  else if (nearbyState.pairKey && Object.keys(nearbyState.pairPeers).length === 0) renderQr(nearbyState.pairKey);
});

watch(ownDevicesAvailable, available => { if (available) void joinOwnRoom(); });
</script>

<style scoped>
.nearby-page{box-sizing:border-box;max-width:560px;min-height:100dvh;margin:0 auto;padding:0 16px calc(32px + env(safe-area-inset-bottom));background:var(--bg-fff);color:var(--fg-172033)}
.nearby-intro,.nearby-hint{margin:8px 0 0;color:var(--fg-64748b);font-size:14px;line-height:1.6}
.nearby-card{margin-top:16px;padding:16px;border:1px solid var(--bd-e2e8f0);border-radius:18px}
.nearby-card h2{margin:0;font-size:17px}
.nearby-empty{margin:10px 0 0;color:var(--fg-64748b);font-size:14px;line-height:1.6}
.peer-list,.transfer-list,.offer-files{margin:12px 0 0;padding:0;list-style:none}
.peer-row{display:flex;min-height:56px;align-items:center;gap:12px;border-top:1px solid var(--bd-eef2f7)}
.peer-row:first-child{border-top:0}
.peer-icon{display:grid;width:40px;height:40px;flex:0 0 40px;border-radius:12px;background:var(--bg-f1f5f9);color:var(--fg-334155);place-items:center}
.peer-icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.peer-name{flex:1;min-width:0;overflow:hidden;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.peer-send,.pair-button{min-height:44px;padding:0 16px;border:0;border-radius:12px;background:#1687e8;color:#fff;font-weight:600;cursor:pointer}
.peer-send:disabled{opacity:.5}
.pair-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
.pair-qr{display:grid;justify-items:center;margin-top:12px}
.qr-holder{width:min(240px,70vw);padding:8px;border-radius:12px;background:#fff}
.qr-holder :deep(svg){display:block;width:100%;height:auto}
.link-button{min-height:44px;margin-top:8px;padding:0 12px;border:0;background:transparent;color:var(--fg-1687e8);font-weight:600;cursor:pointer}
.transfer-row{padding:12px 0;border-top:1px solid var(--bd-eef2f7)}
.transfer-row:first-child{border-top:0}
.transfer-head{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.transfer-head span{color:var(--fg-64748b)}
.file-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;font-size:13px}
.file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-size{color:var(--fg-64748b)}
.file-row progress{width:100%;height:6px}
.file-action{display:inline-flex;min-height:36px;align-items:center;padding:0 12px;border:1px solid var(--bd-cbd5e1);border-radius:10px;background:var(--bg-fff);color:var(--fg-334155);font-size:13px;text-decoration:none;cursor:pointer}
.hidden-input{display:none}
.diagnostics summary{min-height:32px;color:var(--fg-64748b);font-size:14px;cursor:pointer}
.diag-list{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:10px 0 0;font-size:12px;line-height:1.5}
.diag-list dt{color:var(--fg-64748b)}
.diag-list dd{margin:0;overflow-wrap:anywhere;color:var(--fg-334155)}
.diag-item{display:block}
.offer-overlay{position:fixed;inset:0;z-index:13000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.45)}
.offer-sheet{width:min(100%,480px);box-sizing:border-box;padding:20px 20px calc(20px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:var(--bg-fff)}
.offer-sheet h2{margin:0;font-size:18px}
.offer-files li{overflow:hidden;padding:4px 0;color:var(--fg-334155);font-size:14px;text-overflow:ellipsis;white-space:nowrap}
.offer-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.offer-reject,.offer-accept{min-height:50px;border:0;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer}
.offer-reject{background:var(--bg-eef2f7);color:var(--fg-334155)}
.offer-accept{background:#1687e8;color:#fff}
@media(min-width:700px){.offer-overlay{align-items:center}.offer-sheet{border-radius:22px}}
</style>
