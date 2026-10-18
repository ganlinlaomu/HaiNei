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
          <button class="peer-send" type="button" :disabled="!!activeSend" @click="pickFiles('own', peer.id, peer.name)">发送文件</button>
        </li>
      </ul>
      <p v-else class="nearby-empty">{{ ownStatus }}</p>
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
            <button class="peer-send" type="button" :disabled="!!activeSend" @click="pickFiles('pair', peer.id, peer.name)">发送文件</button>
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
import { useRoute } from "vue-router";
import qrcode from "qrcode-generator";
import SecondaryPageHeader from "@/components/SecondaryPageHeader.vue";
import QrScannerSheet from "@/components/QrScannerSheet.vue";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import {
  NEARBY_MAX_BATCH_BYTES,
  NEARBY_OFFER_TIMEOUT_MS,
  NearbyRoom,
  batchBytes,
  defaultDeviceName,
  formatBytes,
  ownDevicesRoom,
  pairingLink,
  parsePairing,
  randomPairingRoom,
  type NearbyFileMeta,
  type NearbyOffer,
  type NearbyRoomKey,
} from "@/services/nearbyTransfer";

type RoomKind = "own" | "pair";
type Transfer = {
  id: string;
  direction: "in" | "out";
  peerName: string;
  files: NearbyFileMeta[];
  progress: number[];
  received: (File | undefined)[];
  state: "waiting" | "active" | "done" | "declined" | "failed";
};

const keys = useKeyStore();
const ui = useUIStore();
const route = useRoute();
const deviceName = defaultDeviceName();

const rooms: Partial<Record<RoomKind, NearbyRoom>> = {};
const ownPeers = ref<Record<string, string>>({});
const pairPeers = ref<Record<string, string>>({});
const ownJoined = ref(false);
const pairKey = ref<NearbyRoomKey | null>(null);
const pairQr = ref("");
const copied = ref(false);
const scannerOpen = ref(false);
const transfers = ref<Transfer[]>([]);
const pendingOffer = ref<{ offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void } | null>(null);
const offerQueue: Array<{ offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void }> = [];
const activeSend = ref<{ kind: RoomKind; peerId: string; peerName: string } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const objectUrls = new Map<File, string>();

const ownDevicesAvailable = computed(() => keys.isLoggedIn && keys.loginMethod === "private-key" && /^[0-9a-f]{64}$/.test(keys.skHex));
const ownPeerList = computed(() => Object.entries(ownPeers.value).map(([id, name]) => ({ id, name })));
const pairPeerList = computed(() => Object.entries(pairPeers.value).map(([id, name]) => ({ id, name })));
const ownStatus = computed(() => ownJoined.value
  ? "在你的其他设备上打开「附近传输」，它们会出现在这里。"
  : "正在寻找你的其他设备…");

function transferFor(kind: RoomKind, offer: NearbyOffer, peerName: string): Transfer {
  const transfer: Transfer = {
    id: `${kind}:${offer.id}`, direction: "in", peerName, files: offer.files,
    progress: offer.files.map(() => 0), received: offer.files.map(() => undefined), state: "waiting",
  };
  transfers.value = [transfer, ...transfers.value];
  return transfer;
}

function updateTransfer(id: string, patch: (transfer: Transfer) => void) {
  const index = transfers.value.findIndex(item => item.id === id);
  if (index < 0) return;
  const next = { ...transfers.value[index], progress: [...transfers.value[index].progress], received: [...transfers.value[index].received] };
  patch(next);
  transfers.value.splice(index, 1, next);
}

function showNextOffer() {
  if (!pendingOffer.value) pendingOffer.value = offerQueue.shift() || null;
}

function makeRoom(kind: RoomKind) {
  const peers = kind === "own" ? ownPeers : pairPeers;
  return new NearbyRoom(deviceName, {
    onPeers: next => { peers.value = next; },
    onOffer: offer => new Promise<boolean>(resolve => {
      const peerName = peers.value[offer.from] || "附近的设备";
      const transfer = transferFor(kind, offer, peerName);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        updateTransfer(transfer.id, item => { item.state = ok ? "active" : "declined"; });
        if (pendingOffer.value?.offer.id === offer.id) pendingOffer.value = null;
        showNextOffer();
        resolve(ok);
      };
      // Answer before the sender's request times out.
      const timer = setTimeout(() => finish(false), NEARBY_OFFER_TIMEOUT_MS - 5_000);
      offerQueue.push({ offer, peerName, resolve: finish });
      showNextOffer();
    }),
    onReceiveProgress: (offerId, index, percent) => {
      updateTransfer(`${kind}:${offerId}`, item => { item.progress[index] = percent; });
    },
    onFile: (offerId, index, file) => {
      updateTransfer(`${kind}:${offerId}`, item => {
        item.received[index] = file;
        item.progress[index] = 1;
        if (item.received.every(Boolean)) item.state = "done";
      });
    },
  });
}

async function joinOwnRoom() {
  if (rooms.own || !ownDevicesAvailable.value) return;
  const room = makeRoom("own");
  rooms.own = room;
  try {
    await room.join(await ownDevicesRoom(keys.skHex));
    ownJoined.value = true;
  } catch {
    rooms.own = undefined;
    ui.addToast("无法连接附近传输服务，请检查网络", 2_400, "error");
  }
}

async function joinPairRoom(key: NearbyRoomKey, showQr: boolean) {
  await stopPairing();
  const room = makeRoom("pair");
  rooms.pair = room;
  pairKey.value = key;
  if (showQr) {
    const qr = qrcode(0, "M");
    qr.addData(pairingLink(key, window.location.origin), "Byte");
    qr.make();
    pairQr.value = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  }
  try {
    await room.join(key);
  } catch {
    ui.addToast("无法连接附近传输服务，请检查网络", 2_400, "error");
    await stopPairing();
  }
}

function startPairing() {
  void joinPairRoom(randomPairingRoom(), true);
}

async function stopPairing() {
  const room = rooms.pair;
  rooms.pair = undefined;
  pairKey.value = null;
  pairQr.value = "";
  pairPeers.value = {};
  copied.value = false;
  if (room) await room.leave();
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

function pickFiles(kind: RoomKind, peerId: string, peerName: string) {
  activeSend.value = { kind, peerId, peerName };
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
  const room = rooms[target.kind];
  if (!room) {
    activeSend.value = null;
    return;
  }
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) {
    ui.addToast(`一次最多发送 ${formatBytes(NEARBY_MAX_BATCH_BYTES)}，请分批发送`, 2_600, "error");
    activeSend.value = null;
    return;
  }
  const transfer: Transfer = {
    id: `out:${Date.now()}:${Math.random()}`, direction: "out", peerName: target.peerName,
    files: files.map(file => ({ name: file.name, size: file.size, type: file.type })),
    progress: files.map(() => 0), received: files.map(() => undefined), state: "waiting",
  };
  transfers.value = [transfer, ...transfers.value];
  try {
    const accepted = await room.send(target.peerId, files, (index, percent) => {
      updateTransfer(transfer.id, item => { item.state = "active"; item.progress[index] = percent; });
    });
    updateTransfer(transfer.id, item => { item.state = accepted ? "done" : "declined"; });
  } catch {
    updateTransfer(transfer.id, item => { item.state = "failed"; });
  } finally {
    activeSend.value = null;
  }
}

function answerOffer(accept: boolean) {
  pendingOffer.value?.resolve(accept);
}

function transferStatus(transfer: Transfer) {
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
  void joinOwnRoom();
  const pair = typeof route.query.pair === "string" ? parsePairing(route.query.pair) : null;
  if (pair) void joinPairRoom(pair, false);
});

watch(ownDevicesAvailable, available => { if (available) void joinOwnRoom(); });

onBeforeUnmount(() => {
  for (const item of [pendingOffer.value, ...offerQueue]) item?.resolve(false);
  void rooms.own?.leave();
  void rooms.pair?.leave();
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
});
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
