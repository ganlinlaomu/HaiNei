<template>
  <main class="nearby-page" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <header class="assistant-header">
      <button type="button" class="header-icon" aria-label="返回私信列表" @click="router.push(keys.isLoggedIn ? '/conversations' : '/login')"><svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg></button>
      <span class="assistant-avatar" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" /></svg></span>
      <strong>文件传输助手</strong>
      <button type="button" class="header-icon" aria-label="设备与连接" :aria-expanded="pairingOpen" @click="pairingOpen = true"><svg viewBox="0 0 24 24"><path d="M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM20 15v6h-5" /></svg></button>
    </header>
    <div ref="chatBody" class="assistant-body">
    <p v-if="!transfers.length" class="empty-chat">发送文字、图片或文件到你的设备</p>
    <div v-if="showCameraRetry" class="connection-notice"><span>暂时无法连接设备</span><button class="link-button" type="button" @click="pairingOpen = true">启用设备直传</button></div>

    <section v-if="transfers.length" class="transfer-history" aria-label="传输记录" aria-live="polite">
      <ul class="transfer-list">
        <li v-for="transfer in transfers" :key="transfer.id" class="transfer-row" :class="{ outgoing: transfer.direction === 'out' }">
          <div class="transfer-head">
            <strong>{{ transfer.direction === 'out' ? `${transfer.localDeviceName || deviceName} → ${transfer.peerName}` : `${transfer.peerName} → ${transfer.localDeviceName || deviceName}` }}</strong>
            <span>{{ transferStatus(transfer) }}</span>
          </div>
          <time v-if="transfer.createdAt" class="transfer-time" :datetime="new Date(transfer.createdAt).toISOString()">{{ transfer.direction === 'out' ? '发送于' : '接收于' }} {{ new Date(transfer.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</time>
          <p v-if="transfer.text" class="transfer-text">{{ transfer.text }}</p>
          <p v-if="transfer.files.length" class="batch-summary">{{ transfer.files.length }} 个文件 · {{ formatBytes(batchBytes(transfer.files)) }}</p>
          <progress v-if="transfer.files.length && ['queued', 'active', 'waiting', 'verifying', 'paused'].includes(transfer.state)" class="batch-progress" :value="batchProgress(transfer)" max="1" :aria-label="transferStatus(transfer)"></progress>
          <div v-if="transfer.files.length" class="batch-files file-cards">
          <div v-for="(file, index) in transfer.files" :key="index" class="file-row">
            <button v-if="canPreview(fileFor(transfer, index))" class="file-thumbnail" type="button" :aria-label="`预览 ${file.name}`" @click="imagePreview = fileFor(transfer, index) || null"><img :src="objectUrl(fileFor(transfer, index)!)" :alt="file.name" loading="lazy" /></button>
            <span v-else class="file-symbol" aria-hidden="true">▤</span>
            <span class="file-description"><span class="file-name">{{ file.name }}</span><span class="file-size">{{ formatBytes(file.size) }}</span></span>
            <template v-if="transfer.state !== 'done' && transfer.received[index]">
              <a class="file-action" :href="objectUrl(transfer.received[index])" :download="file.name">保存</a>
            </template>
          </div>
          </div>
          <div class="batch-actions">
            <button v-if="transfer.direction === 'in' && transfer.state === 'done' && !hasAllFiles(transfer) && transfer.stored?.some(Boolean)" class="file-action load-history" type="button" :disabled="loadingHistory === transfer.id" @click="loadStoredFiles(transfer)">{{ loadingHistory === transfer.id ? '正在载入…' : '载入文件' }}</button>
            <button v-if="transfer.direction === 'in' && transfer.files.length && transfer.state === 'done' && hasAllFiles(transfer)" class="file-action batch-save" type="button" :disabled="savingBatch === transfer.id" @click="saveAll(transfer)">{{ savingBatch === transfer.id ? '正在准备…' : transfer.saveState ? (transfer.files.length > 1 ? '再次保存全部' : '再次保存') : (transfer.files.length > 1 ? '保存全部' : '保存') }}</button>
            <button v-if="transfer.saveState === 'system' || transfer.saveState === 'download'" class="file-action confirm-saved" type="button" :disabled="savingBatch === transfer.id" @click="transfer.saveState = 'saved'">确认已保存</button>
            <button v-if="transfer.text" class="file-action" type="button" @click="copyText(transfer.text)">复制文字</button>
            <a v-if="zipDownloads[transfer.id]" class="file-action" :href="zipDownloads[transfer.id]" download="海内文件.zip">下载 ZIP</a>
            <button v-if="['queued', 'active', 'waiting', 'verifying', 'paused'].includes(transfer.state)" class="file-action cancel-transfer" type="button" @click="cancelNearbyTransfer(transfer.id)">取消传输</button>
            <button v-if="transfer.direction === 'out' && !transfer.restored && ['failed', 'paused', 'declined'].includes(transfer.state)" class="file-action retry-transfer" type="button" @click="retryTransfer(transfer.id)">{{ transfer.state !== 'declined' ? '继续传输' : '重新发送' }}</button>
            <button v-if="!['queued', 'active', 'waiting', 'verifying'].includes(transfer.state)" class="clear-transfer" type="button" :disabled="savingBatch === transfer.id" @click="clearTransfer(transfer)">{{ transfer.direction === 'in' && transfer.files.length ? '移除文件' : '清除记录' }}</button>
          </div>
          <p v-if="transfer.direction === 'in' && transfer.files.length && transfer.state === 'done' && saveHint(transfer)" class="save-hint" role="status">{{ saveHint(transfer) }}</p>
        </li>
      </ul>
    </section>
    </div>

    <div v-if="pairingOpen" class="offer-overlay" @click.self="pairingOpen = false">
    <section ref="devicePanel" class="offer-sheet connection-sheet" role="dialog" aria-modal="true" aria-labelledby="devices-title" tabindex="-1">
    <header class="sheet-header"><h2 id="devices-title">设备与连接</h2><button class="header-icon" type="button" aria-label="关闭设备与连接" @click="pairingOpen = false">×</button></header>
    <form v-if="renaming" class="rename-form" @submit.prevent="saveRename">
      <input ref="renameInput" v-model="nameDraft" :maxlength="NEARBY_MAX_DEVICE_NAME" aria-label="本机名称" placeholder="例如：书房电脑" enterkeyhint="done" />
      <button class="link-button" type="submit">保存</button>
      <button class="link-button" type="button" @click="renaming = false">取消</button>
    </form>
    <p v-else class="nearby-hint device-name-row">本机：{{ deviceName }}<button class="link-button rename-device" type="button" @click="startRename">改名</button></p>

    <section v-if="ownDevicesAvailable" class="nearby-card device-card">
      <h2>我的设备</h2>
      <ul v-if="ownPeerList.length" class="peer-list">
        <li v-for="peer in ownPeerList" :key="peer.id" class="peer-row">
          <span class="peer-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2.5" /><path d="M10.5 17.5h3" /></svg></span>
          <span class="peer-name">{{ peer.name }}<small>{{ peerStatus(peer, `可发送 · 同账号自动接收${routeSuffix(nearbyState.ownRoutes[peer.id])}`) }}</small></span>
          <button class="peer-send" type="button" :disabled="!peer.ready" @click="selectDevice('own', peer.id)">选择此设备</button>
        </li>
      </ul>
      <p v-else class="nearby-empty">{{ ownStatus }}</p>
      <button class="link-button" type="button" :disabled="searching || requestingCamera" @click="searchAgain">{{ searching ? "正在重新搜索…" : "重新搜索" }}</button>
      <div v-if="showCameraRetry" class="camera-retry">
        <p class="nearby-hint">iPhone / iPad 的浏览器可能限制局域网直连。可短暂启用相机后重试，相机会立即关闭，不拍照、不录音、不上传。</p>
        <button class="pair-button" type="button" :disabled="searching || requestingCamera" @click="retryWithCamera">{{ requestingCamera ? "正在启用并重新连接…" : "启用设备直传" }}</button>
      </div>
    </section>
    <section v-else-if="keys.isLoggedIn" class="nearby-card">
      <h2>我的设备</h2>
      <p class="nearby-empty">远程签名器账号无法自动发现自己的设备，请使用扫码配对。</p>
    </section>

    <section class="nearby-card">
      <h2>不同账号配对</h2>
      <div v-if="!pairKey" class="pair-actions">
        <button class="pair-button" type="button" @click="startPairing">显示二维码</button>
        <button class="pair-button scan-device" type="button" @click="openScanner">扫码</button>
      </div>
      <template v-else>
        <div v-if="pairQr && pairPeerList.length === 0" class="pair-qr">
          <div class="qr-holder" v-html="pairQr"></div>
          <p class="nearby-hint">用另一台设备的「文件传输助手」扫码，或相机扫码打开。</p>
          <button class="link-button" type="button" @click="copyPairLink">{{ copied ? "已复制链接" : "复制链接" }}</button>
        </div>
        <ul v-if="pairPeerList.length" class="peer-list">
          <li v-for="peer in pairPeerList" :key="peer.id" class="peer-row">
            <span class="peer-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 20h8" /></svg></span>
            <span class="peer-name">{{ peer.name }}<small>{{ peerStatus(peer, `可发送${routeSuffix(nearbyState.pairRoutes[peer.id])}`) }}</small></span>
            <button class="peer-send" type="button" :disabled="!peer.ready" @click="selectDevice('pair', peer.id)">选择此设备</button>
          </li>
        </ul>
        <p v-if="nearbyState.pairError" class="nearby-empty">{{ joinErrorText(nearbyState.pairError) }}</p>
        <p v-else-if="!pairQr && !pairPeerList.length" class="nearby-empty">正在连接…</p>
        <button class="link-button" type="button" @click="stopPairing">结束配对</button>
      </template>
    </section>

    <button class="link-button copy-diagnostics" type="button" @click="copyDiagnostics">复制诊断信息</button>
    </section>
    </div>

    <footer class="assistant-composer">
      <div class="target-chips" role="group" aria-label="接收设备">
        <button v-for="peer in availableTargets" :key="`${peer.kind}:${peer.id}`" class="target-chip" :class="{ selected: isSelected(peer) }" type="button" :aria-pressed="isSelected(peer)" :disabled="!peer.ready" @click="selectDevice(peer.kind, peer.id)"><span class="chip-dot" :class="{ ready: peer.ready }" aria-hidden="true"></span>{{ peer.ready ? peer.name : peer.name === NEARBY_UNNAMED_PEER ? '连接中…' : `${peer.name}（需更新海内）` }}</button>
        <span v-if="selectedTarget && !selectedPeer" class="target-chip lost" role="status">设备已断开，请重新选择</span>
        <button class="target-chip connect-device" type="button" :aria-label="availableTargets.length ? '连接更多设备' : '连接设备'" @click="openConnections"><span aria-hidden="true">＋</span>{{ availableTargets.length ? '' : '连接设备' }}</button>
      </div>
      <p v-if="!availableTargets.length" class="recipient-hint">{{ nearbyState.ownError || nearbyState.pairError ? '连接未完成，请检查设备与网络；点击「连接设备」重试' : ownDevicesAvailable ? '在另一台设备上打开海内并登录同一账号，它会出现在这里' : '点击「连接设备」显示或扫描配对二维码' }}</p>
      <p v-else-if="!selectedTarget" class="recipient-hint">选择要发送到的设备</p>
      <p v-else class="recipient-hint">{{ routeHint }}</p>
      <div v-if="selectedFiles.length" class="selected-batch"><span>已选 {{ selectedFiles.length }} 个文件 · {{ formatBytes(batchBytes(selectedFiles)) }}</span><button type="button" @click="removeStaged()">全部移除</button></div>
      <ul v-if="selectedFiles.length" class="staged-files" aria-label="待发送的文件">
        <li v-for="(file, index) in selectedFiles" :key="stagedKey(file)" class="staged-file">
          <img v-if="canPreview(file)" :src="objectUrl(file)" alt="" />
          <span v-else class="staged-symbol" aria-hidden="true">▤</span>
          <span class="staged-name">{{ file.name }}</span>
          <button type="button" class="staged-remove" :aria-label="`移除 ${file.name}`" @click="removeStaged(index)">×</button>
        </li>
      </ul>
      <div class="file-composer">
        <textarea ref="textInput" v-model="draftText" rows="1" enterkeyhint="enter" autocomplete="off" placeholder="输入消息……" aria-label="输入消息" :maxlength="NEARBY_MAX_TEXT_LENGTH" @focus="resizeTextInput" @input="resizeTextInput"></textarea>
        <div class="composer-actions">
          <button type="button" class="composer-icon attachment-button" aria-label="添加图片或文件" @click="chooseFiles"><span><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></span></button>
          <button type="button" class="composer-icon send-button" aria-label="发送" :disabled="!hasContent || !canSendToTarget" @click="requestSend"><span><svg viewBox="0 0 24 24"><path d="m5 12 14-8-5 16-3-7-6-1Z" /></svg></span></button>
        </div>
      </div>
    </footer>

    <div v-if="dragActive" class="drop-overlay" aria-hidden="true"><span>松开以添加文件</span></div>
    <input ref="fileInput" class="hidden-input" type="file" multiple @change="onFilesPicked" @cancel="filePickerGeneration = -1" />
    <QrScannerSheet :open="scannerOpen" title="扫描配对二维码" @close="closeScanner" @scanned="onScanned" />

    <div v-if="imagePreview" class="offer-overlay image-overlay" @click.self="imagePreview = null">
      <section ref="imagePanel" class="image-preview" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1"><button class="header-icon" type="button" aria-label="关闭图片预览" @click="imagePreview = null">×</button><img :src="objectUrl(imagePreview)" :alt="imagePreview.name" /><a class="file-action" :href="objectUrl(imagePreview)" :download="imagePreview.name">保存图片</a></section>
    </div>
    <div v-if="pendingOffer && !scannerOpen" class="offer-overlay" role="dialog" aria-modal="true" aria-labelledby="offer-title">
      <section class="offer-sheet">
        <h2 id="offer-title">{{ pendingOffer.peerName }} 想发送{{ pendingOffer.offer.files.length ? ` ${pendingOffer.offer.files.length} 个文件` : '文字' }}</h2>
        <p v-if="pendingOffer.offer.text" class="text-preview">{{ pendingOffer.offer.text }}</p>
        <p v-if="pendingOffer.offer.files.length" class="nearby-hint">共 {{ formatBytes(batchBytes(pendingOffer.offer.files)) }}</p>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { APP_VERSION } from "@/db/dexie";
import { useRoute, useRouter } from "vue-router";
import qrcode from "qrcode-generator";
import QrScannerSheet from "@/components/QrScannerSheet.vue";
import { useKeyStore } from "@/stores/keys";
import { useUIStore } from "@/stores/ui";
import { useDialogFocus } from "@/composables/useDialogFocus";
import { canShareTransfer, createTransferZip } from "@/services/transferBatchSave";
import { resizeComposerTextarea } from "@/utils/composerTextarea";
import { clearNearbyUnread } from "@/services/nearbyUnread";
import { deviceStorage } from "@/services/deviceStorage";
import {
  NEARBY_MAX_BATCH_BYTES,
  NEARBY_MAX_DEVICE_NAME,
  NEARBY_MAX_TEXT_LENGTH,
  NEARBY_UNNAMED_PEER,
  batchBytes,
  defaultDeviceName,
  formatBytes,
  pairingLink,
  parsePairing,
  randomPairingRoom,
  type NearbyRoomKey,
  type NearbyRoute,
} from "@/services/nearbyTransfer";
import {
  answerPendingOffer,
  clearNearbyTransfer,
  cancelNearbyTransfer,
  ensureOwnDevicesRoom,
  nearbyDiagnostics,
  nearbyState,
  refreshNearbyDiscovery,
  retryNearbyWithCamera,
  queueNearbyFiles,
  loadNearbyHistoryFiles,
  refreshNearbyRoutes,
  renameNearbyDevice,
  restoreNearbyHistory,
  retryNearbyTransfer,
  startPairRoom,
  stopPairRoom,
  type NearbyTransferRecord,
  type RoomKind,
} from "@/services/nearbySession";

const keys = useKeyStore();
const ui = useUIStore();
const route = useRoute();
const router = useRouter();
const deviceName = computed(() => nearbyState.deviceName);
/** Platform, not the editable name: decides WebKit-only connection help. */
const platformName = defaultDeviceName();
const renaming = ref(false);
const nameDraft = ref("");
const renameInput = ref<HTMLInputElement | null>(null);
const LAST_TARGET_KEY = "hainei_nearby_last_device";
const rememberedDevice = () => deviceStorage.getItem(LAST_TARGET_KEY) || "";

const pairQr = ref("");
const copied = ref(false);
const scannerOpen = ref(false);
const pairingOpen = ref(false);
const selectedFiles = ref<File[]>([]);
const draftText = ref("");
const textInput = ref<HTMLTextAreaElement | null>(null);
const selectedTarget = ref<{ kind: RoomKind; peerId: string; device?: string } | null>(null);
const hasContent = computed(() => !!draftText.value.trim() || selectedFiles.value.length > 0);
const devicePanel = ref<HTMLElement | null>(null);
const chatBody = ref<HTMLElement | null>(null);
const savingBatch = ref("");
const imagePreview = ref<File | null>(null);
const imagePanel = ref<HTMLElement | null>(null);
const zipDownloads = ref<Record<string, string>>({});
let pageActive = true;
let saveGeneration = 0;
let saveAbort: AbortController | null = null;
const fileInput = ref<HTMLInputElement | null>(null);
let pickerGeneration = 0;
let filePickerGeneration = -1;
const objectUrls = new Map<File, string>();
const searching = ref(false);
const requestingCamera = ref(false);
let cameraRequest: AbortController | null = null;
/** Plain-text connection report for troubleshooting; no addresses or keys. */
async function diagnosticsText() {
  const d = await nearbyDiagnostics();
  return [
    `版本：v${APP_VERSION} · ${deviceName.value}`,
    `账号：${d.account ? `${d.account.slice(0, 6)}…${d.account.slice(-6)}` : "未登录"}`,
    `房间指纹：${d.ownRoom || "—"}（两台设备应一致）`,
    `房间状态：${d.ownJoined ? "已加入" : "未加入"} · 本机 ID ${d.selfId || "—"}`,
    `Relay：${d.relays.map(relay => `${relay.host} ${relay.state}${relay.rejection ? `（${relay.rejection}）` : ""}`).join("；") || "尚未连接"}`,
    `设备连接：${Object.entries(d.ownPeers).map(([id, state]) => `${id.slice(0, 6)} ${nearbyState.ownPeers[id] || ""} ${state}`).join("；") || "无"}`,
    ...(d.ownError ? [`连接错误：${joinErrorText(d.ownError)}`, `原始错误：${d.ownError}`] : []),
    ...d.negotiations.map(attempt => `协商 ${attempt.id}：SDP ${attempt.localDescription}/${attempt.remoteDescription}；ICE ${attempt.ice}；连接 ${attempt.connection}；收集 ${attempt.gathering}；`
      + `本机候选 ${attempt.localCandidates}（${attempt.candidateTypes.join(", ") || "无"}）；远端候选 ${attempt.remoteCandidates}${attempt.iceErrors.length ? `；STUN 错误 ${attempt.iceErrors.join(", ")}` : ""}`),
    `上次搜索：${d.lastRefreshAt ? `${Math.round((Date.now() - d.lastRefreshAt) / 1000)} 秒前` : "—"}`,
  ].join("\n");
}

async function copyDiagnostics() {
  try {
    // Safari only allows the write inside the tap; hand it a pending blob.
    if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": diagnosticsText().then(text => new Blob([text], { type: "text/plain" })) })]);
    } else {
      await navigator.clipboard.writeText(await diagnosticsText());
    }
    ui.addToast("诊断信息已复制", 1_600, "success");
  } catch {
    ui.addToast("无法复制诊断信息", 2_400, "error");
  }
}

/** Check relay liveness, then rebuild failed rooms without disturbing live peers. */
async function searchAgain() {
  if (searching.value || requestingCamera.value) return;
  searching.value = true;
  try {
    await joinOwnRoom();
    await refreshNearbyDiscovery();
  } catch {
    ui.addToast("无法重新搜索附近设备，请检查网络", 2_400, "error");
  } finally {
    searching.value = false;
  }
}

async function retryWithCamera() {
  if (searching.value || requestingCamera.value) return;
  const request = new AbortController();
  cameraRequest = request;
  requestingCamera.value = true;
  try {
    await retryNearbyWithCamera(request.signal);
  } catch {
    if (!request.signal.aborted) ui.addToast("无法启用相机并重试，请检查海内的相机权限和网络", 3_000, "error");
  } finally {
    requestingCamera.value = false;
    if (cameraRequest === request) cameraRequest = null;
  }
}

onBeforeUnmount(() => {
  document.removeEventListener("paste", onPaste);
  pageActive = false;
  releaseUrls();
  cameraRequest?.abort();
});

const pairKey = computed(() => nearbyState.pairKey);
const pendingOffer = computed(() => nearbyState.pendingOffer);
const transfers = computed(() => [...nearbyState.transfers].reverse());
const ownDevicesAvailable = computed(() => keys.isLoggedIn && keys.loginMethod === "private-key" && /^[0-9a-f]{64}$/.test(keys.skHex));
const ownPeerList = computed(() => Object.entries(nearbyState.ownPeers).map(([id, name]) => ({ id, name, ready: isReady(name, nearbyState.ownCompatible[id]) })));
const showCameraRetry = computed(() => ["iPhone", "iPad"].includes(platformName)
  && !ownPeerList.value.length && nearbyState.ownError.includes("could not connect to peer"));
// A QR peer that is already listed under 我的设备 is the same device: show it once.
const pairPeerList = computed(() => Object.entries(nearbyState.pairPeers).filter(([id]) => !nearbyState.pairDuplicates[id]).map(([id, name]) => ({ id, name, ready: isReady(name, nearbyState.pairCompatible[id]) })));
const availableTargets = computed(() => [
  ...ownPeerList.value.map(peer => ({ ...peer, kind: "own" as const, device: nearbyState.ownDevices[peer.id] || "", route: nearbyState.ownRoutes[peer.id] })),
  ...pairPeerList.value.map(peer => ({ ...peer, kind: "pair" as const, device: "", route: nearbyState.pairRoutes[peer.id] })),
]);
const selectedPeer = computed(() => availableTargets.value.find(peer => peer.kind === selectedTarget.value?.kind && peer.id === selectedTarget.value?.peerId));
const ROUTE_LABELS: Record<NearbyRoute, string> = { lan: "局域网直连", internet: "互联网直连", relay: "经中继" };
// Always one line under the chips once a device is chosen, so the composer never jumps.
const routeHint = computed(() => {
  const peer = selectedPeer.value;
  if (!peer) return "所选设备已断开";
  if (!peer.ready) return "正在连接…";
  // Keep each variant to one line on a phone; a wrapping hint would jump too.
  if (peer.route === "lan") return "经局域网直连 · 不消耗流量";
  if (peer.route === "internet") return "经互联网直连 · 使用手机网络时会消耗流量";
  if (peer.route === "relay") return "经中继服务器 · 使用手机网络时会消耗流量";
  return "正在检测连接方式…";
});
const routeSuffix = (route?: NearbyRoute) => route ? ` · ${ROUTE_LABELS[route]}` : "";
function isReady(name: string, compatible?: boolean) { return name !== NEARBY_UNNAMED_PEER && compatible === true; }
function peerStatus(peer: { name: string; ready: boolean }, ready: string) {
  return peer.ready ? ready : peer.name === NEARBY_UNNAMED_PEER ? '连接中…' : '版本过旧，请更新海内';
}
const isSelected = (peer: { kind: RoomKind; id: string }) => selectedTarget.value?.kind === peer.kind && selectedTarget.value?.peerId === peer.id;
const canSendToTarget = computed(() => !!selectedPeer.value?.ready);
watch(availableTargets, peers => {
  const current = selectedTarget.value;
  // Never silently redirect an existing recipient to another device. The same
  // own device returning under a new connection id is still that recipient.
  if (current && !peers.some(peer => peer.kind === current.kind && peer.id === current.peerId)) {
    const same = current.device && peers.find(peer => peer.kind === current.kind && peer.device === current.device && peer.ready);
    if (same) selectedTarget.value = { ...current, peerId: same.id };
    return;
  }
  if (current) return;
  const remembered = rememberedDevice();
  const pick = (remembered && peers.find(peer => peer.ready && peer.device === remembered))
    || (peers.length === 1 && peers[0].ready ? peers[0] : null);
  if (pick) selectedTarget.value = { kind: pick.kind, peerId: pick.id, ...(pick.device ? { device: pick.device } : {}) };
}, { immediate: true });
useDialogFocus(devicePanel, () => pairingOpen.value && !scannerOpen.value && !pendingOffer.value, () => { pairingOpen.value = false; });
useDialogFocus(imagePanel, () => !!imagePreview.value && !pendingOffer.value, () => { imagePreview.value = null; });
function joinErrorText(error: string) {
  if (error.includes("incorrect room password")) return "已发现设备，但房间密码不一致";
  if (error.includes("could not connect to peer")) return "已发现设备，但本次连接协商未完成；请点「重新搜索」";
  return error;
}

const ownStatus = computed(() => nearbyState.ownError
  ? joinErrorText(nearbyState.ownError)
  : nearbyState.ownJoined
    ? "在你的其他设备上打开海内并登录同一账号，它们会出现在这里。"
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
  pairingOpen.value = true;
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
  pairingOpen.value = true;
  const key = parsePairing(value);
  if (!key) {
    ui.addToast("这不是附近传输的配对二维码", 2_000, "error");
    return;
  }
  void joinPairRoom(key, false);
}

function openScanner() {
  pairingOpen.value = false;
  imagePreview.value = null;
  scannerOpen.value = true;
}
function closeScanner() {
  scannerOpen.value = false;
  pairingOpen.value = true;
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

function chooseFiles() {
  filePickerGeneration = pickerGeneration;
  pairingOpen.value = false;
  fileInput.value?.click();
}

function selectDevice(kind: RoomKind, peerId: string) {
  const peer = availableTargets.value.find(item => item.kind === kind && item.id === peerId && item.ready);
  if (!peer) return;
  selectedTarget.value = { kind, peerId, ...(peer.device ? { device: peer.device } : {}) };
  if (peer.device) deviceStorage.setItem(LAST_TARGET_KEY, peer.device);
  pairingOpen.value = false;
}

async function startRename() {
  nameDraft.value = nearbyState.deviceName;
  renaming.value = true;
  await nextTick();
  renameInput.value?.select();
}

function saveRename() {
  renameNearbyDevice(nameDraft.value);
  renaming.value = false;
}

function openConnections() {
  textInput.value?.blur();
  pairingOpen.value = true;
}

function onFilesPicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = "";
  const current = filePickerGeneration === pickerGeneration;
  filePickerGeneration = -1;
  if (current) addFiles(files);
}

const stagedKey = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;

/** Picking, dropping and pasting all add to one staged batch. */
function addFiles(incoming: File[]) {
  const known = new Set(selectedFiles.value.map(stagedKey));
  const fresh = incoming.filter(file => !known.has(stagedKey(file)) && known.add(stagedKey(file)));
  if (!fresh.length) return;
  const next = [...selectedFiles.value, ...fresh];
  if (next.length > 200) { ui.addToast("一次最多发送 200 个文件，请分批发送", 2_600, "error"); return; }
  if (batchBytes(next) > NEARBY_MAX_BATCH_BYTES) {
    ui.addToast(`一次最多发送 ${formatBytes(NEARBY_MAX_BATCH_BYTES)}，请分批发送`, 2_600, "error");
    return;
  }
  selectedFiles.value = next;
}

/** Without an index, drop the whole batch. */
function removeStaged(index?: number) {
  const removed = index === undefined ? selectedFiles.value : selectedFiles.value.slice(index, index + 1);
  selectedFiles.value = index === undefined ? [] : selectedFiles.value.filter((_, item) => item !== index);
  for (const file of removed) {
    const url = objectUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(file);
  }
}

const dragActive = ref(false);
let dragDepth = 0;
const acceptsDrop = (event: DragEvent) => !!event.dataTransfer?.types.includes("Files") && !pendingOffer.value && !scannerOpen.value;

function onDragEnter(event: DragEvent) {
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  dragDepth++;
  dragActive.value = true;
}

function onDragOver(event: DragEvent) {
  if (!acceptsDrop(event)) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
}

function onDragLeave() {
  if (dragDepth && --dragDepth === 0) dragActive.value = false;
}

function onDrop(event: DragEvent) {
  const accepted = acceptsDrop(event);
  dragDepth = 0;
  dragActive.value = false;
  if (!accepted) return;
  event.preventDefault();
  const items = [...event.dataTransfer!.items].filter(item => item.kind === "file");
  const files: File[] = [];
  let folders = 0;
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!items.length) files.push(...event.dataTransfer!.files);
  if (folders) ui.addToast("暂不支持发送文件夹，请压缩后发送或选择其中的文件", 2_600, "error");
  addFiles(files);
}

/** Pasted images or copied files become attachments; plain text pastes as usual. */
function onPaste(event: ClipboardEvent) {
  if (pendingOffer.value || scannerOpen.value) return;
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
}

function resizeTextInput() {
  resizeComposerTextarea(textInput.value, false, { minHeight: 36, maxHeight: 108 });
}

function requestSend() {
  if (!hasContent.value || !canSendToTarget.value) return;
  textInput.value?.blur();
  const target = selectedTarget.value;
  if (target && availableTargets.value.some(peer => peer.kind === target.kind && peer.id === target.peerId && peer.ready)) {
    void sendSelected(target.kind, target.peerId);
  }
}

function sendSelected(kind: RoomKind, peerId: string) {
  if (!hasContent.value) return;
  const files = selectedFiles.value;
  const text = draftText.value;
  try {
    queueNearbyFiles(kind, peerId, files, text);
    pairingOpen.value = false;
    selectedFiles.value = [];
    draftText.value = "";
  } catch (error) {
    ui.addToast((error as Error)?.message === 'nearby_queue_full' ? '传输队列已满，请移除已完成的记录后再发送' : '设备暂不可发送，请检查连接', 2_400, "error");
  }
}

function retryTransfer(id: string) {
  try { retryNearbyTransfer(id); }
  catch { ui.addToast('接收设备尚未连接，请在接收设备上打开海内', 2_600, 'error'); }
}
const hasAllFiles = (transfer: NearbyTransferRecord) => transfer.files.every((_, index) => !!transfer.received[index]);
const loadingHistory = ref("");

/** Never imply the files are saved before the person saves them to Photos or Files. */
function saveHint(transfer: NearbyTransferRecord) {
  if (transfer.saveState === "saved") return "✓ 已保存";
  if (transfer.saveState === "system") return "已交给系统，请在完成保存后确认已保存";
  if (transfer.saveState === "download") return "已开始下载，请检查下载完成后确认已保存";
  if (transfer.restored && !hasAllFiles(transfer) && !transfer.stored?.some(Boolean)) return "文件未能保存在本机，已失效";
  // A sealed copy survives a reload, so only warn when there is none.
  return transfer.stored?.length && transfer.stored.every(Boolean) ? "" : "请保存后再关闭海内";
}

async function loadStoredFiles(transfer: NearbyTransferRecord) {
  if (loadingHistory.value) return;
  loadingHistory.value = transfer.id;
  try {
    if (!await loadNearbyHistoryFiles(transfer.id)) ui.addToast("部分文件无法载入，可能已过期或被系统清理", 2_600, "error");
  } catch {
    ui.addToast("无法载入文件，请确认账号已解锁", 2_600, "error");
  } finally {
    loadingHistory.value = "";
  }
}

function fileFor(transfer: NearbyTransferRecord, index: number) { return transfer.direction === 'out' ? transfer.source?.[index] : transfer.received[index]; }
function canPreview(file?: File) { return !!file && /^image\/(jpeg|png|gif|webp|avif)$/.test(file.type); }

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); ui.addToast("已复制", 1_400, "success"); }
  catch { ui.addToast("无法复制，请长按文字复制", 2_400, "error"); }
}

function answerOffer(accept: boolean) {
  answerPendingOffer(accept);
}

function transferStatus(transfer: NearbyTransferRecord) {
  if (transfer.state === 'queued') return '排队中';
  if (transfer.state === 'verifying') return '正在确认送达…';
  if (transfer.state === 'paused') return '连接中断，等待重连';
  if (transfer.state === 'canceled') return '已取消';
  if (transfer.state === "waiting") return transfer.direction === "out" ? "正在连接接收设备…" : "等待你确认";
  if (transfer.state === "declined") return transfer.direction === "out" ? "对方暂时无法接收" : "已拒绝";
  if (transfer.state === "failed") return "传输中断";
  if (transfer.state === "done") return transfer.direction === "out" ? '已送达' : "已接收";
  return `${Math.floor(batchProgress(transfer) * 100)}%`;
}

function batchProgress(transfer: NearbyTransferRecord) {
  const total = batchBytes(transfer.files);
  if (!total) return transfer.state === "done" ? 1 : 0;
  const done = transfer.files.reduce((sum, file, index) => sum + file.size * (transfer.progress[index] || 0), 0);
  return done / total;
}

function objectUrl(file: File) {
  let url = objectUrls.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    objectUrls.set(file, url);
  }
  return url;
}

function releaseUrls() {
  saveGeneration++;
  saveAbort?.abort();
  saveAbort = null;
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  for (const url of Object.values(zipDownloads.value)) URL.revokeObjectURL(url);
  objectUrls.clear();
  zipDownloads.value = {};
  savingBatch.value = "";
}

function clearTransfer(transfer: NearbyTransferRecord) {
  if (savingBatch.value === transfer.id) return;
  for (const file of [...transfer.received, ...(transfer.source || [])]) {
    if (!file) continue;
    const url = objectUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    objectUrls.delete(file);
  }
  if (zipDownloads.value[transfer.id]) URL.revokeObjectURL(zipDownloads.value[transfer.id]);
  delete zipDownloads.value[transfer.id];
  if (imagePreview.value && [...transfer.received, ...(transfer.source || [])].includes(imagePreview.value)) imagePreview.value = null;
  clearNearbyTransfer(transfer.id);
}

async function saveAll(transfer: NearbyTransferRecord) {
  const files = transfer.received.filter((file): file is File => !!file);
  if (files.length !== transfer.files.length || savingBatch.value) return;
  if (zipDownloads.value[transfer.id]) {
    download(zipDownloads.value[transfer.id], "海内文件.zip");
    if (transfer.saveState !== 'saved') transfer.saveState = 'download';
    return;
  }
  savingBatch.value = transfer.id;
  const abort = new AbortController();
  saveAbort = abort;
  const generation = saveGeneration;
  try {
    if (canShareTransfer(files)) {
      // Invoke in the click handler, before any await, to keep iOS user activation.
      await navigator.share({ files });
      if (pageActive && generation === saveGeneration && transfer.saveState !== 'saved') transfer.saveState = 'system';
    } else if (files.length === 1) {
      download(objectUrl(files[0]), files[0].name);
      if (transfer.saveState !== 'saved') transfer.saveState = 'download';
    } else {
      const zip = await createTransferZip(files, abort.signal);
      if (!pageActive || generation !== saveGeneration) return;
      const url = URL.createObjectURL(zip);
      zipDownloads.value[transfer.id] = url;
      // A persistent download link remains if the browser blocks this async click.
      download(url, "海内文件.zip");
      if (transfer.saveState !== 'saved') transfer.saveState = 'download';
    }
  } catch (error) {
    if ((error as Error)?.name !== "AbortError" && generation === saveGeneration) {
      ui.addToast("无法批量保存，请展开文件分别保存", 2_600, "error");
    }
  } finally {
    if (generation === saveGeneration) { savingBatch.value = ""; saveAbort = null; }
  }
}

function download(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

onMounted(() => {
  clearNearbyUnread();
  void restoreNearbyHistory().catch(() => undefined);
  refreshNearbyRoutes();
  document.addEventListener("paste", onPaste);
  // A page visit must not cut off an in-flight offer/answer/candidate exchange.
  void joinOwnRoom();
  const pair = typeof route.query.pair === "string" ? parsePairing(route.query.pair) : null;
  if (pair) void joinPairRoom(pair, false);
  // Returning to the page while still pairing: show the same QR again.
  else if (nearbyState.pairKey && Object.keys(nearbyState.pairPeers).length === 0) renderQr(nearbyState.pairKey);
});

watch(ownDevicesAvailable, available => { if (available) void joinOwnRoom(); });
watch(() => keys.pkHex, () => {
  pickerGeneration++;
  filePickerGeneration = -1;
  selectedFiles.value = [];
  draftText.value = "";
  selectedTarget.value = null;
  imagePreview.value = null;
  scannerOpen.value = false;
  pairingOpen.value = false;
  releaseUrls();
});
watch(draftText, () => { void nextTick(resizeTextInput); });
watch(pairingOpen, open => {
  if (!open) renaming.value = false;
});
watch(() => nearbyState.transfers.length, async () => {
  await nextTick();
  if (chatBody.value) chatBody.value.scrollTop = chatBody.value.scrollHeight;
});
</script>

<style scoped>
.nearby-page{position:fixed;inset:0;z-index:1000;display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr) auto;box-sizing:border-box;width:100%;margin:0;background:var(--bg-fff);color:var(--fg-172033)}
.assistant-header{display:grid;grid-template-columns:38px 34px minmax(0,1fr) 38px;align-items:center;gap:8px;min-height:54px;padding:0 12px;border-bottom:1px solid var(--bd-eff1f3);background:var(--bg-fff)}
.assistant-header strong{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-icon{display:grid;width:38px;height:44px;padding:8px;place-items:center;border:0;background:transparent;color:inherit;cursor:pointer}
.header-icon svg,.assistant-avatar svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.assistant-avatar{display:grid;width:34px;height:34px;place-items:center;border-radius:50%;background:var(--bg-f1f5f9)}
.assistant-avatar svg{width:21px;height:21px}
.assistant-body{box-sizing:border-box;width:100%;max-width:720px;margin:0 auto;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 16px 20px;overscroll-behavior:contain}
.empty-chat{margin:36px auto;color:var(--fg-64748b);font-size:13px;text-align:center}
.connection-notice{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--fg-64748b);font-size:12px}.connection-notice .link-button{margin:0;font-size:12px}
.sheet-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.sheet-header .header-icon{font-size:26px}
.device-name-row{display:flex;align-items:center;gap:4px;flex-wrap:wrap}.rename-device{min-height:32px;margin:0;padding:0 6px;font-size:14px}
.rename-form{display:flex;align-items:center;gap:4px;margin-top:8px}.rename-form input{flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid var(--bd-d8dee5);border-radius:10px;background:var(--bg-fff);color:inherit;font:inherit;font-size:16px}.rename-form .link-button{margin:0}
.connection-sheet{max-height:85dvh;overflow-y:auto;overscroll-behavior:contain;outline:0}
.assistant-composer{box-sizing:border-box;width:100%;max-width:720px;margin:0 auto;padding:6px 24px calc(24px + env(safe-area-inset-bottom));background:var(--bg-fff)}
.file-composer{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;min-height:48px;padding:2px 8px;border:1px solid var(--bd-d8dee5);border-radius:24px;box-shadow:0 4px 18px rgba(15,23,42,.11)}
.file-composer textarea{grid-column:2;grid-row:1;box-sizing:border-box;min-width:0;min-height:36px;max-height:108px;padding:7px 6px 6px;border:0;outline:0;resize:none;overflow-y:hidden;background:transparent;color:inherit;font:inherit;font-size:16px;line-height:22px}
.composer-actions{display:contents}.attachment-button{grid-column:1;grid-row:1}.send-button{grid-column:3;grid-row:1}
.composer-icon{display:grid;width:44px;height:44px;padding:5px;place-items:center;border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer}.composer-icon span{display:grid;width:34px;height:34px;place-items:center;border-radius:50%}.composer-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.send-button span{background:var(--bg-0f1419);color:#fff}.send-button svg{width:18px;height:18px}.composer-icon:disabled{opacity:.36;cursor:default}
.file-composer:focus-within{min-height:76px;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 34px;align-items:stretch;padding:6px 8px 4px}.file-composer:focus-within textarea{grid-column:1;grid-row:1;width:100%;padding:4px 6px 3px}.file-composer:focus-within .composer-actions{display:flex;grid-column:1;grid-row:2;align-items:center;justify-content:space-between}
.assistant-composer:has(textarea:focus){padding-right:16px;padding-left:16px;padding-bottom:calc(8px + env(safe-area-inset-bottom))}
.target-chips{display:flex;gap:8px;margin:0 -4px;padding:4px 4px 8px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}.target-chips::-webkit-scrollbar{display:none}
.target-chip{display:inline-flex;flex:0 0 auto;align-items:center;gap:6px;max-width:70vw;min-height:36px;padding:0 14px;overflow:hidden;border:1px solid var(--bd-d8dee5);border-radius:999px;background:var(--bg-fff);color:var(--fg-334155);font:inherit;font-size:13px;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.target-chip.selected{border-color:#1687e8;background:var(--bg-eff6ff);color:var(--fg-1687e8);font-weight:650}.target-chip:disabled{opacity:.55;cursor:default}
.target-chip.lost{border-style:dashed;color:var(--fg-64748b);cursor:default}.target-chip.connect-device{padding:0 12px;color:var(--fg-64748b)}
.chip-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--fg-94a3b8)}.chip-dot.ready{background:#16a34a}.recipient-hint{margin:0 4px 8px;overflow:hidden;color:var(--fg-64748b);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.transfer-text{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.5}.text-preview{max-height:120px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.5}
.selected-batch{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px;color:var(--fg-64748b)}
.staged-files{display:flex;gap:8px;margin:0 -4px;padding:0 4px 10px;overflow-x:auto;list-style:none;scrollbar-width:none}.staged-files::-webkit-scrollbar{display:none}
.staged-file{position:relative;display:flex;flex:0 0 auto;align-items:center;gap:6px;max-width:180px;height:48px;padding:4px 30px 4px 4px;box-sizing:border-box;border:1px solid var(--bd-e2e8f0);border-radius:12px;background:var(--bg-fff);font-size:12px}
.staged-file img{width:38px;height:38px;flex:0 0 38px;border-radius:8px;object-fit:cover}.staged-symbol{display:grid;width:38px;height:38px;flex:0 0 38px;place-items:center;border-radius:8px;background:var(--bg-f1f5f9);color:var(--fg-64748b);font-size:20px}
.staged-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.staged-remove{position:absolute;top:50%;right:2px;display:grid;width:28px;height:28px;padding:0;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--fg-64748b);font-size:18px;transform:translateY(-50%);cursor:pointer}
.drop-overlay{position:fixed;inset:12px;z-index:12000;display:grid;place-items:center;border:2px dashed #1687e8;border-radius:20px;background:rgba(22,135,232,.08);pointer-events:none}.drop-overlay span{padding:10px 18px;border-radius:999px;background:var(--bg-fff);color:var(--fg-1687e8);font-weight:650;box-shadow:0 4px 18px rgba(15,23,42,.12)}
.selected-batch span{flex:1}.selected-batch button{min-height:36px;border:0;background:transparent;color:var(--fg-1687e8)}
.peer-name small{display:block;margin-top:4px;color:var(--fg-64748b);font-size:11px;font-weight:400}
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
.transfer-row{box-sizing:border-box;max-width:88%;width:fit-content;min-width:min(290px,100%);margin:18px auto 18px 0;padding:14px;border-radius:16px 16px 16px 4px;background:var(--bg-f1f5f9)}
.transfer-row.outgoing{margin-right:0;margin-left:auto;border-radius:16px 16px 4px 16px;background:var(--bg-eff6ff)}
.batch-summary{margin:8px 0;color:var(--fg-64748b);font-size:13px}
.save-hint{margin:8px 0 0;color:var(--fg-64748b);font-size:11px}
.batch-progress{display:block;width:100%;height:6px;margin:10px 0;accent-color:#1687e8}
.batch-files summary{max-width:100%;overflow-wrap:anywhere;font-size:14px;cursor:pointer}
.batch-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px}
.clear-transfer{min-height:36px;padding:0;border:0;background:transparent;color:var(--fg-64748b);font-size:12px;cursor:pointer}
.transfer-row:first-child{border-top:0}
.transfer-head{display:flex;justify-content:space-between;gap:12px;font-size:14px}
.transfer-head span{color:var(--fg-64748b)}
.transfer-head strong{overflow-wrap:anywhere;min-width:0}
.transfer-time{display:block;margin-top:5px;color:var(--fg-64748b);font-size:11px}
.file-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;font-size:13px}
.file-name{display:block;min-width:0;overflow-wrap:anywhere}
.file-size{color:var(--fg-64748b)}
.file-description{flex:1;min-width:0}.file-description .file-size{display:block;margin-top:5px;font-size:11px}
.file-cards .file-row{flex-wrap:nowrap;padding:10px;border:1px solid var(--bd-e2e8f0);border-radius:12px;background:var(--bg-fff)}
.file-thumbnail{flex:0 0 60px;width:60px;height:60px;padding:0;overflow:hidden;border:0;border-radius:8px;background:var(--bg-f1f5f9);cursor:pointer}.file-thumbnail img{display:block;width:100%;height:100%;object-fit:cover}.file-symbol{display:grid;place-items:center;flex:0 0 40px;height:48px;font-size:30px;color:var(--fg-64748b)}
.image-overlay{align-items:center;padding:12px;box-sizing:border-box}.image-preview{position:relative;display:flex;flex-direction:column;align-items:center;gap:12px;width:min(720px,100%);max-height:90dvh;padding:12px;box-sizing:border-box;border-radius:16px;background:var(--bg-fff)}.image-preview .header-icon{align-self:flex-end;flex-shrink:0}.image-preview img{display:block;min-height:0;max-width:100%;object-fit:contain;flex:1}.image-preview a{padding:10px;flex-shrink:0}
.file-row progress{width:100%;height:6px}
.file-action{display:inline-flex;min-height:36px;align-items:center;padding:0 12px;border:1px solid var(--bd-cbd5e1);border-radius:10px;background:var(--bg-fff);color:var(--fg-334155);font-size:13px;text-decoration:none;cursor:pointer}
.hidden-input{display:none}
.copy-diagnostics{display:block;margin:8px auto 0;color:var(--fg-64748b);font-weight:500}
.offer-overlay{position:fixed;inset:0;z-index:13000;display:flex;align-items:flex-end;justify-content:center;background:rgba(15,23,42,.45)}
.offer-sheet{width:min(100%,480px);max-height:85dvh;overflow-y:auto;box-sizing:border-box;padding:20px 20px calc(20px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:var(--bg-fff);outline:0}
.offer-sheet h2{margin:0;font-size:18px}
.offer-files li{overflow:hidden;padding:4px 0;color:var(--fg-334155);font-size:14px;text-overflow:ellipsis;white-space:nowrap}
.offer-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.offer-reject,.offer-accept{min-height:50px;border:0;border-radius:14px;font-size:16px;font-weight:600;cursor:pointer}
.offer-reject{background:var(--bg-eef2f7);color:var(--fg-334155)}
.offer-accept{background:#1687e8;color:#fff}
@media(min-width:700px){.offer-overlay{align-items:center}.offer-sheet{border-radius:22px}}
</style>
