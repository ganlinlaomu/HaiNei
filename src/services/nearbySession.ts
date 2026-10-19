import { reactive } from "vue";
import { useUIStore } from "@/stores/ui";
import { onAppResume } from "@/services/appResumeCoordinator";
import { requestNearbyCameraAccess } from "@/services/nearbyCameraAccess";
import {
  NEARBY_MAX_BATCH_BYTES,
  NEARBY_MAX_TEXT_LENGTH,
  NEARBY_OFFER_TIMEOUT_MS,
  NEARBY_UNNAMED_PEER,
  NearbyRoom,
  batchBytes,
  defaultDeviceName,
  nearbyRelayStates,
  ownDevicesRoom,
  refreshNearbyRelaySockets,
  roomFingerprint,
  type NearbyFileMeta,
  type NearbyOffer,
  type NearbyRoomKey,
} from "@/services/nearbyTransfer";

/**
 * App-lifetime 附近传输 state. Rooms are joined once and kept while the app
 * runs: Trystero shares peer connections across rooms with a per-page peer
 * id, and leaving/rejoining the same room on every page visit left the other
 * device unable to see the one that came back. Rooms are left only on
 * 结束配对, account switch or logout.
 */

export type RoomKind = "own" | "pair";

export type NearbyTransferRecord = {
  id: string;
  kind: RoomKind;
  peerId: string;
  direction: "in" | "out";
  peerName: string;
  localDeviceName?: string;
  createdAt?: number;
  saveState?: "system" | "download" | "saved";
  files: NearbyFileMeta[];
  text?: string;
  progress: number[];
  received: (File | undefined)[];
  source?: File[];
  wireId?: string;
  resumable?: boolean;
  deliveryConfirmed?: boolean;
  state: "queued" | "waiting" | "active" | "verifying" | "paused" | "canceled" | "done" | "declined" | "failed";
};

export type PendingOffer = { transferId: string; offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void };

export const nearbyState = reactive({
  deviceName: defaultDeviceName(),
  ownAccount: "",
  ownJoined: false,
  ownPeers: {} as Record<string, string>,
  ownTextPeers: {} as Record<string, boolean>,
  ownChunkPeers: {} as Record<string, boolean>,
  ownError: "",
  pairKey: null as NearbyRoomKey | null,
  pairPeers: {} as Record<string, string>,
  pairTextPeers: {} as Record<string, boolean>,
  pairChunkPeers: {} as Record<string, boolean>,
  pairError: "",
  transfers: [] as NearbyTransferRecord[],
  pendingOffer: null as PendingOffer | null,
});

const rooms: Partial<Record<RoomKind, NearbyRoom>> = {};
type SendTask = { record: NearbyTransferRecord; room: NearbyRoom; controller: AbortController | null; canceled: boolean; finish: () => void };
const sendTasks = new Map<string, SendTask>();
const sendQueue: SendTask[] = [];
let queueRunning = false;
const inFlight = (state: NearbyTransferRecord['state']) => ["queued", "waiting", "active", "verifying"].includes(state);
let ownGeneration = 0;
let pairGeneration = 0;
let stopResumeWatch: (() => void) | null = null;
let discoveryRefresh: Promise<void> | null = null;

/** Only called by the explicitly labelled camera-permission button. */
export async function retryNearbyWithCamera(signal: AbortSignal) {
  const current = { ...rooms };
  if (!current.own && !current.pair) return false;
  if (!await requestNearbyCameraAccess(signal)) return false;
  // An earlier search may already be rebuilding a PC with the pre-permission
  // candidate policy. Finish it before creating a fresh post-permission PC.
  if (discoveryRefresh) await discoveryRefresh;
  if (signal.aborted || rooms.own !== current.own || rooms.pair !== current.pair) return false;
  await refreshNearbyDiscovery(true);
  return true;
}

export function refreshNearbyDiscovery(restartUnconnected = false) {
  if (!rooms.own && !rooms.pair) return Promise.resolve();
  if (discoveryRefresh) return discoveryRefresh;
  lastRefreshAt = Date.now();
  const current = { ...rooms };
  discoveryRefresh = (async () => {
    await refreshNearbyRelaySockets();
    for (const kind of ["own", "pair"] as const) {
      const room = current[kind];
      const error = kind === "own" ? nearbyState.ownError : nearbyState.pairError;
      if (!room || rooms[kind] !== room || (!restartUnconnected && !error.includes("could not connect to peer")) || Object.keys(peersFor(kind)).length) continue;
      if (kind === "own") nearbyState.ownError = "";
      else nearbyState.pairError = "";
      await room.restart();
    }
  })().finally(() => { discoveryRefresh = null; });
  return discoveryRefresh;
}

function updateRelayResumeWatch() {
  const active = !!(rooms.own || rooms.pair);
  if (active && !stopResumeWatch) {
    stopResumeWatch = onAppResume(() => refreshNearbyDiscovery().catch(() => undefined));
  } else if (!active && stopResumeWatch) {
    stopResumeWatch?.();
    stopResumeWatch = null;
  }
}
const offerQueue: PendingOffer[] = [];
let offerListener: ((offer: PendingOffer) => void) | null = pending => {
  // Rooms stay joined after leaving the page; point people back to it.
  if (typeof location !== "undefined" && location.hash.startsWith("#/nearby")) return;
  if (!pending.offer.files.length) {
    useUIStore().addToast(`${pending.peerName} 想发送文字，请打开「私信 › 文件传输助手」确认`, 6_000, "info");
    return;
  }
  useUIStore().addToast(`${pending.peerName} 想发送 ${pending.offer.files.length} 个文件，请打开「私信 › 文件传输助手」确认`, 6_000, "info");
};

/** Lets the app tell people about an offer while they are on another page. */
export function onNearbyOffer(listener: ((offer: PendingOffer) => void) | null) {
  offerListener = listener;
}

function updateTransfer(id: string, patch: (transfer: NearbyTransferRecord) => void) {
  const transfer = nearbyState.transfers.find(item => item.id === id);
  if (transfer) patch(transfer);
}

function showNextOffer() {
  if (!nearbyState.pendingOffer) nearbyState.pendingOffer = offerQueue.shift() || null;
}

function peersFor(kind: RoomKind) {
  return kind === "own" ? nearbyState.ownPeers : nearbyState.pairPeers;
}

function makeRoom(kind: RoomKind) {
  return new NearbyRoom(nearbyState.deviceName, {
    onPeers: (next, textPeers = {}, chunkPeers = {}) => {
      if (kind === "own") { nearbyState.ownPeers = next; nearbyState.ownTextPeers = textPeers; nearbyState.ownChunkPeers = chunkPeers; }
      else { nearbyState.pairPeers = next; nearbyState.pairTextPeers = textPeers; nearbyState.pairChunkPeers = chunkPeers; }
      for (const item of nearbyState.transfers) {
        if (item.kind === kind && !next[item.peerId] && inFlight(item.state)) {
          const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === item.id);
          pending?.resolve(false);
          item.state = item.resumable && !pending ? "paused" : "failed";
          sendTasks.get(item.id)?.controller?.abort(new Error("nearby_disconnected"));
        }
      }
      for (const task of sendTasks.values()) {
        const item = task.record;
        if (item.kind === kind && item.state === "paused" && chunkPeers[item.peerId] && !task.controller && rooms[kind] === task.room) {
          item.state = "queued";
          if (!sendQueue.includes(task)) sendQueue.push(task);
        }
      }
      void pumpSendQueue();
    },
    onError: message => {
      if (kind === "own") nearbyState.ownError = message;
      else nearbyState.pairError = message;
    },
    onOffer: offer => new Promise<boolean>(resolve => {
      const id = `${kind}:${offer.id}`;
      // Reserve memory for the entire batch, including files not received yet.
      // A trusted device must not fill the receiver with unlimited queued data.
      const reserved = nearbyState.transfers.reduce((sum, item) => {
        if (item.direction !== 'in') return sum;
        const keepsPartial = item.state === 'active' || item.state === 'waiting'
          || (item.resumable && ['paused', 'failed'].includes(item.state));
        return sum + batchBytes(keepsPartial ? item.files : item.received.filter((file): file is File => !!file));
      }, 0);
      if (nearbyState.transfers.length >= 100 || nearbyState.transfers.some(item => item.id === id)
        || reserved + batchBytes(offer.files) > NEARBY_MAX_BATCH_BYTES) { resolve(false); return; }
      const peerName = peersFor(kind)[offer.from] || "附近的设备";
      const transfer: NearbyTransferRecord = {
        id, kind, peerId: offer.from, direction: "in", peerName, files: offer.files, text: offer.text,
        localDeviceName: nearbyState.deviceName, createdAt: Date.now(),
        wireId: offer.id, resumable: offer.protocol === 2,
        progress: offer.files.map(() => 0), received: offer.files.map(() => undefined), state: "waiting",
      };
      nearbyState.transfers.unshift(transfer);
      // Only possession of this account's private key derives the own room's
      // secret and encrypted signaling password. QR rooms never get this trust.
      if (kind === "own") {
        transfer.state = offer.files.length ? "active" : "done";
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        updateTransfer(transfer.id, item => { item.state = ok ? (offer.files.length ? "active" : "done") : "declined"; });
        if (nearbyState.pendingOffer?.transferId === transfer.id) nearbyState.pendingOffer = null;
        const queued = offerQueue.findIndex(item => item.transferId === transfer.id);
        if (queued >= 0) offerQueue.splice(queued, 1);
        showNextOffer();
        resolve(ok);
      };
      // Answer before the sender's request times out.
      const timer = setTimeout(() => finish(false), NEARBY_OFFER_TIMEOUT_MS - 5_000);
      const pending: PendingOffer = { transferId: transfer.id, offer, peerName, resolve: finish };
      offerQueue.push(pending);
      showNextOffer();
      offerListener?.(pending);
    }),
    onReceiveProgress: (offerId, index, percent) => {
      updateTransfer(`${kind}:${offerId}`, item => { if (item.state !== 'canceled') { item.state = 'active'; item.progress[index] = percent; } });
    },
    onFile: (offerId, index, file) => {
      updateTransfer(`${kind}:${offerId}`, item => {
        if (item.state === 'canceled') return;
        item.received[index] = file;
        item.progress[index] = 1;
        if (item.received.every(Boolean)) item.state = "done";
      });
    },
    onResume: (id, peerId) => {
      updateTransfer(`${kind}:${id}`, item => { if (item.peerId === peerId && !['done', 'canceled'].includes(item.state)) item.state = item.files.length ? 'active' : 'done'; });
    },
    onFailure: (id, peerId) => {
      updateTransfer(`${kind}:${id}`, item => { if (item.peerId === peerId && item.state !== 'canceled') item.state = 'failed'; });
    },
    onCancel: (id, peerId) => {
      const outgoing = [...sendTasks.values()].find(task => task.record.kind === kind && task.record.wireId === id && task.record.peerId === peerId);
      if (outgoing && outgoing.record.state !== 'done') { cancelNearbyTransfer(outgoing.record.id); return; }
      const record = nearbyState.transfers.find(item => item.id === `${kind}:${id}` && item.peerId === peerId);
      if (!record || record.state === 'done') return;
      const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === record.id);
      pending?.resolve(false);
      record.state = 'canceled';
    },
  });
}

/** Join (once) the room shared by every device of this account. */
export async function ensureOwnDevicesRoom(account: string, privateKeyHex: string) {
  const normalized = account.toLowerCase();
  if (rooms.own && nearbyState.ownAccount === normalized) return;
  const leaving = leaveOwnDevicesRoom();
  const generation = ownGeneration;
  await leaving;
  if (generation !== ownGeneration) return;
  const room = makeRoom("own");
  rooms.own = room;
  nearbyState.ownAccount = normalized;
  nearbyState.ownError = "";
  try {
    const key = await ownDevicesRoom(privateKeyHex);
    if (generation !== ownGeneration || rooms.own !== room) return;
    ownRoomId = key.roomId;
    await room.join(key);
    if (rooms.own === room) nearbyState.ownJoined = true;
    updateRelayResumeWatch();
  } catch (error) {
    if (rooms.own === room) {
      rooms.own = undefined;
      nearbyState.ownAccount = "";
    }
    throw error;
  }
}

export async function leaveOwnDevicesRoom() {
  ownGeneration++;
  const room = rooms.own;
  rooms.own = undefined;
  nearbyState.ownAccount = "";
  nearbyState.ownJoined = false;
  nearbyState.ownPeers = {};
  nearbyState.ownTextPeers = {};
  nearbyState.ownChunkPeers = {};
  nearbyState.ownError = "";
  ownRoomId = "";
  failRoomTransfers("own");
  updateRelayResumeWatch();
  if (room) await room.leave();
}

export async function startPairRoom(key: NearbyRoomKey) {
  if (nearbyState.pairKey?.roomId === key.roomId && rooms.pair) return;
  const leaving = stopPairRoom();
  const generation = pairGeneration;
  await leaving;
  if (generation !== pairGeneration) return;
  const room = makeRoom("pair");
  rooms.pair = room;
  nearbyState.pairKey = key;
  nearbyState.pairError = "";
  try {
    await room.join(key);
    updateRelayResumeWatch();
  } catch (error) {
    if (rooms.pair === room) await stopPairRoom();
    throw error;
  }
}

export async function stopPairRoom() {
  pairGeneration++;
  const room = rooms.pair;
  rooms.pair = undefined;
  nearbyState.pairKey = null;
  nearbyState.pairPeers = {};
  nearbyState.pairTextPeers = {};
  nearbyState.pairChunkPeers = {};
  nearbyState.pairError = "";
  failRoomTransfers("pair");
  updateRelayResumeWatch();
  if (room) await room.leave();
}

/** Account switch / logout: drop every room and anything still in memory. */
export async function resetNearby() {
  for (const task of sendTasks.values()) { task.canceled = true; task.controller?.abort(); task.finish(); }
  sendQueue.length = 0;
  sendTasks.clear();
  for (const pending of [nearbyState.pendingOffer, ...offerQueue]) pending?.resolve(false);
  offerQueue.length = 0;
  nearbyState.pendingOffer = null;
  nearbyState.transfers = [];
  await Promise.all([leaveOwnDevicesRoom(), stopPairRoom()]);
}

let ownRoomId = "";
let lastRefreshAt = 0;

/** Everything needed to compare two devices from screenshots. */
export async function nearbyDiagnostics() {
  const relay = await nearbyRelayStates().catch(() => ({ selfId: "", relays: [] as Array<{ host: string; state: string; rejection: string }> }));
  return {
    account: nearbyState.ownAccount,
    ownRoom: ownRoomId ? await roomFingerprint(ownRoomId) : "",
    ownJoined: nearbyState.ownJoined,
    selfId: relay.selfId,
    relays: relay.relays,
    ownPeers: rooms.own?.peerConnections() || {},
    negotiations: rooms.own?.negotiations() || [],
    pairPeers: rooms.pair?.peerConnections() || {},
    ownError: nearbyState.ownError,
    pairError: nearbyState.pairError,
    lastRefreshAt,
  };
}

export function answerPendingOffer(accept: boolean) {
  nearbyState.pendingOffer?.resolve(accept);
}

export function clearNearbyTransfer(id: string) {
  const index = nearbyState.transfers.findIndex(item => item.id === id);
  if (index < 0 || inFlight(nearbyState.transfers[index].state)) return;
  const record = nearbyState.transfers[index];
  const task = sendTasks.get(id);
  if (task) { task.canceled = true; task.controller?.abort(); task.finish(); }
  if (record.direction === 'in' && record.wireId && record.state !== 'done') rooms[record.kind]?.cancelReceive(record.peerId, record.wireId);
  if (record.direction === 'out' && record.wireId && record.state !== 'done') rooms[record.kind]?.cancelSend(record.peerId, record.wireId);
  if (record.wireId) rooms[record.kind]?.forget(record.peerId, record.wireId);
  sendTasks.delete(id);
  nearbyState.transfers.splice(index, 1);
}

function failRoomTransfers(kind: RoomKind) {
  for (const item of nearbyState.transfers) {
    if (item.kind !== kind || (!inFlight(item.state) && item.state !== 'paused')) continue;
    const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === item.id);
    pending?.resolve(false);
    item.state = "failed";
    const task = sendTasks.get(item.id);
    if (task) { task.canceled = true; task.controller?.abort(); task.finish(); }
  }
}

function createSendTask(kind: RoomKind, peerId: string, files: File[], text = "") {
  const room = rooms[kind];
  if (!room) throw new Error("nearby_not_joined");
  text = text.trim();
  if ((!files.length && !text) || text.length > NEARBY_MAX_TEXT_LENGTH || files.length > 200 || !peersFor(kind)[peerId]) throw new Error("nearby_invalid_target_or_files");
  if (text && !(kind === "own" ? nearbyState.ownTextPeers : nearbyState.pairTextPeers)[peerId]) throw new Error("nearby_text_unsupported");
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error("nearby_batch_too_large");
  if (nearbyState.transfers.length >= 100 || nearbyState.transfers.reduce((sum, item) => sum + batchBytes(item.source || []), 0) + batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error('nearby_queue_full');
  const wireId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  const transfer: NearbyTransferRecord = {
    id: `out:${wireId}`, wireId, kind, peerId, direction: "out", peerName: peersFor(kind)[peerId] || "附近的设备",
    localDeviceName: nearbyState.deviceName, createdAt: Date.now(),
    files: files.map(file => ({ name: file.name, size: file.size, type: file.type })), text,
    progress: files.map(() => 0), received: files.map(() => undefined), source: files.slice(), state: "queued",
  };
  nearbyState.transfers.unshift(transfer);
  // Always mutate the reactive instance, rather than the original raw object.
  const record = nearbyState.transfers[0];
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const task: SendTask = { record, room, controller: null, canceled: false, finish };
  sendTasks.set(record.id, task);
  sendQueue.push(task);
  void pumpSendQueue();
  return { id: record.id, completed };
}

export function queueNearbyFiles(kind: RoomKind, peerId: string, files: File[], text = '') {
  return createSendTask(kind, peerId, files, text).id;
}

/** Compatibility helper for callers that need to await this attempt. */
export async function sendNearbyFiles(kind: RoomKind, peerId: string, files: File[], text = '') {
  await createSendTask(kind, peerId, files, text).completed;
}

async function pumpSendQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (sendQueue.length) {
      const task = sendQueue.shift()!;
      const item = task.record;
      if (task.canceled || sendTasks.get(item.id) !== task || item.state !== 'queued') { task.finish(); continue; }
      if (rooms[item.kind] !== task.room || !peersFor(item.kind)[item.peerId]) { item.state = 'paused'; task.finish(); continue; }
      const modern = (item.kind === 'own' ? nearbyState.ownChunkPeers : nearbyState.pairChunkPeers)[item.peerId] === true;
      item.resumable = modern;
      item.state = 'waiting';
      task.controller = new AbortController();
      try {
        const accepted = await task.room.send(item.peerId, item.source || [], (index, percent) => {
          if (!task.canceled && !task.controller?.signal.aborted) { item.state = 'active'; item.progress[index] = percent; }
        }, item.text, { id: item.wireId, signal: task.controller.signal, onVerifying: () => { if (!task.canceled) item.state = 'verifying'; } });
        if (!task.canceled && !task.controller.signal.aborted) {
          item.state = accepted ? 'done' : 'declined';
          item.deliveryConfirmed = accepted && (modern || !item.files.length);
        }
      } catch {
        if (!task.canceled) item.state = modern && !peersFor(item.kind)[item.peerId] ? 'paused' : 'failed';
      } finally {
        task.controller = null; task.finish();
        // A peer can reconnect while the failed request is still unwinding.
        if (!task.canceled && item.state === 'paused' && rooms[item.kind] === task.room
          && (item.kind === 'own' ? nearbyState.ownChunkPeers : nearbyState.pairChunkPeers)[item.peerId]) {
          item.state = 'queued'; sendQueue.push(task);
        }
      }
    }
  } finally { queueRunning = false; }
}

export function retryNearbyTransfer(id: string) {
  const task = sendTasks.get(id);
  if (!task || task.controller || task.canceled || !['failed', 'paused', 'declined'].includes(task.record.state)) return;
  const item = task.record;
  if (rooms[item.kind] !== task.room || !peersFor(item.kind)[item.peerId]) throw new Error('nearby_disconnected');
  if (item.state === 'declined' || !item.resumable) {
    if (item.wireId) task.room.forget(item.peerId, item.wireId);
    item.wireId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
    item.progress = item.files.map(() => 0);
  }
  item.state = 'queued';
  sendQueue.push(task);
  void pumpSendQueue();
}

export function cancelNearbyTransfer(id: string) {
  const item = nearbyState.transfers.find(record => record.id === id);
  if (!item || (!inFlight(item.state) && item.state !== 'paused')) return;
  const task = sendTasks.get(id);
  if (task) { task.canceled = true; task.controller?.abort(); task.finish(); }
  item.state = 'canceled';
  if (item.wireId) {
    if (item.direction === 'out') rooms[item.kind]?.cancelSend(item.peerId, item.wireId);
    else {
      const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === id);
      pending?.resolve(false);
      rooms[item.kind]?.cancelReceive(item.peerId, item.wireId);
      item.state = 'canceled';
    }
  }
}
