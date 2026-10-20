import { reactive, watch } from "vue";
import { useUIStore } from "@/stores/ui";
import { useKeyStore } from "@/stores/keys";
import { canStoreHistory, deleteHistory, loadHistory, loadHistoryFile, putHistoryFile, putHistoryRecord, toStored } from "@/services/nearbyHistory";
import { onAppResume } from "@/services/appResumeCoordinator";
import { requestNearbyCameraAccess } from "@/services/nearbyCameraAccess";
import { clearNearbyUnread, markNearbyUnread, nearbyPresence } from "@/services/nearbyUnread";
import {
  NEARBY_MAX_BATCH_BYTES,
  NEARBY_MAX_TEXT_LENGTH,
  NEARBY_OFFER_TIMEOUT_MS,
  NEARBY_UNNAMED_PEER,
  NearbyRoom,
  batchBytes,
  defaultDeviceName,
  nearbyDeviceId,
  pairAccountTag,
  pairDeviceTag,
  pairIdentitySecret,
  saveDeviceName,
  savedDeviceName,
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
  /** Stable id of an own device, so a reloaded receiver can be found again. */
  peerDevice?: string;
  localDeviceName?: string;
  createdAt?: number;
  saveState?: "system" | "download" | "saved";
  files: NearbyFileMeta[];
  text?: string;
  progress: number[];
  received: (File | undefined)[];
  source?: File[];
  wireId?: string;
  /** Per file: a sealed copy exists in this account's history. */
  stored?: boolean[];
  /** Restored from history; the original send can no longer be retried. */
  restored?: boolean;
  state: "queued" | "waiting" | "active" | "verifying" | "paused" | "canceled" | "done" | "declined" | "failed";
};

export type PendingOffer = { transferId: string; offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void };

export const nearbyState = reactive({
  deviceName: savedDeviceName() || defaultDeviceName(),
  ownAccount: "",
  ownJoined: false,
  ownPeers: {} as Record<string, string>,
  /** Peers on 海内 0.1.66+; older ones are listed but cannot be used. */
  ownCompatible: {} as Record<string, boolean>,
  /** Trystero peer id -> stable device id, own devices only. */
  ownDevices: {} as Record<string, string>,
  ownError: "",
  pairKey: null as NearbyRoomKey | null,
  pairPeers: {} as Record<string, string>,
  pairCompatible: {} as Record<string, boolean>,
  /** QR peers proven to be this account's devices: peer id -> per-room device tag. */
  pairDevices: {} as Record<string, string>,
  /** QR peers that are already connected under 我的设备; hidden as duplicates. */
  pairDuplicates: {} as Record<string, boolean>,
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

function onAssistantPage() {
  return typeof location !== "undefined" && location.hash.startsWith("#/nearby");
}

function openAssistant() {
  void import("@/router").then(({ default: router }) => router.push("/nearby")).catch(() => undefined);
}

/** Rooms stay joined on every page; tell people when something arrives elsewhere. */
function announceIncoming(peerName: string, offer: NearbyOffer, needsAnswer: boolean) {
  if (onAssistantPage()) return 0;
  markNearbyUnread();
  const content = offer.files.length ? ` ${offer.files.length} 个文件` : "文字";
  return useUIStore().addToast(
    needsAnswer ? `${peerName} 想发送${content}` : `${peerName} 发来${content}`,
    needsAnswer ? NEARBY_OFFER_TIMEOUT_MS - 5_000 : 6_000,
    "info",
    { label: needsAnswer ? "去确认" : "查看", run: openAssistant },
  );
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

function compatibleFor(kind: RoomKind) {
  return kind === "own" ? nearbyState.ownCompatible : nearbyState.pairCompatible;
}

/**
 * A reloaded own device comes back under a new peer id. Point unfinished
 * outgoing records at it, so they resume (or can be retried) automatically.
 */
function rebindOwnDevices(next: Record<string, string>, devices: Record<string, string>) {
  for (const item of nearbyState.transfers) {
    if (item.kind !== "own" || item.direction !== "out" || item.restored || !item.peerDevice || next[item.peerId]) continue;
    if (!["paused", "failed", "declined"].includes(item.state) || sendTasks.get(item.id)?.controller) continue;
    const peerId = Object.keys(devices).find(id => devices[id] === item.peerDevice && next[id] && next[id] !== NEARBY_UNNAMED_PEER);
    if (!peerId) continue;
    item.peerId = peerId;
    item.peerName = next[peerId];
  }
}

function makeRoom(kind: RoomKind, deviceId = "", accountTag = "") {
  return new NearbyRoom(nearbyState.deviceName, {
    onPeers: (next, compatible = {}, devices = {}) => {
      if (kind === "own") { nearbyState.ownPeers = next; nearbyState.ownCompatible = compatible; nearbyState.ownDevices = devices; }
      else { nearbyState.pairPeers = next; nearbyState.pairCompatible = compatible; nearbyState.pairDevices = devices; }
      void refreshPairDuplicates();
      for (const item of nearbyState.transfers) {
        if (item.kind === kind && !next[item.peerId] && inFlight(item.state)) {
          const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === item.id);
          pending?.resolve(false);
          item.state = pending ? "failed" : "paused";
          sendTasks.get(item.id)?.controller?.abort(new Error("nearby_disconnected"));
        }
      }
      if (kind === "own") rebindOwnDevices(next, devices);
      for (const task of sendTasks.values()) {
        const item = task.record;
        if (item.kind === kind && item.state === "paused" && compatible[item.peerId] && !task.controller && rooms[kind] === task.room) {
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
          || ['paused', 'failed'].includes(item.state);
        return sum + batchBytes(keepsPartial ? item.files : item.received.filter((file): file is File => !!file));
      }, 0);
      if (nearbyState.transfers.length >= 100 || nearbyState.transfers.some(item => item.id === id)
        || reserved + batchBytes(offer.files) > NEARBY_MAX_BATCH_BYTES) { resolve(false); return; }
      const peerName = peersFor(kind)[offer.from] || "附近的设备";
      const transfer: NearbyTransferRecord = {
        id, kind, peerId: offer.from, direction: "in", peerName, files: offer.files, text: offer.text,
        localDeviceName: nearbyState.deviceName, createdAt: Date.now(),
        wireId: offer.id,
        progress: offer.files.map(() => 0), received: offer.files.map(() => undefined), state: "waiting",
      };
      nearbyState.transfers.unshift(transfer);
      // Only possession of this account's private key derives the own room's
      // secret and encrypted signaling password. QR rooms never get this trust.
      if (kind === "own") {
        transfer.state = offer.files.length ? "active" : "done";
        resolve(true);
        announceIncoming(peerName, offer, false);
        return;
      }
      let settled = false;
      let toastId = 0;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // An answered or expired request must not leave a stale 去确认 prompt.
        if (toastId) useUIStore().removeToast(toastId);
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
      toastId = announceIncoming(peerName, offer, true);
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
        storeReceivedFile(item, index, file);
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
  }, deviceId, accountTag);
}

/** Join (once) the room shared by every device of this account. */
export async function ensureOwnDevicesRoom(account: string, privateKeyHex: string) {
  const normalized = account.toLowerCase();
  if (rooms.own && nearbyState.ownAccount === normalized) return;
  const leaving = leaveOwnDevicesRoom();
  const generation = ownGeneration;
  await leaving;
  if (generation !== ownGeneration) return;
  const [deviceId, identity] = await Promise.all([nearbyDeviceId(), pairIdentitySecret(privateKeyHex)]);
  if (generation !== ownGeneration || rooms.own) return;
  pairSecret = identity;
  const room = makeRoom("own", deviceId);
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
  nearbyState.ownCompatible = {};
  nearbyState.ownDevices = {};
  pairSecret = "";
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
  const secret = pairSecret;
  const [deviceTag, accountTag] = secret
    ? await Promise.all([nearbyDeviceId().then(id => pairDeviceTag(secret, key.roomId, id)), pairAccountTag(secret, key.roomId)])
    : ["", ""];
  if (generation !== pairGeneration) return;
  const room = makeRoom("pair", deviceTag, accountTag);
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
  nearbyState.pairCompatible = {};
  nearbyState.pairDevices = {};
  nearbyState.pairDuplicates = {};
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
  clearNearbyUnread();
  resetHistory();
  await Promise.all([leaveOwnDevicesRoom(), stopPairRoom()]);
}

let ownRoomId = "";
const usable = (name: string, compatible?: boolean) => name !== NEARBY_UNNAMED_PEER && compatible === true;
// Feeds the 私信 row without loading this module there.
watch(() => Object.entries(nearbyState.ownPeers).filter(([id, name]) => usable(name, nearbyState.ownCompatible[id])).length
  + Object.entries(nearbyState.pairPeers).filter(([id, name]) => usable(name, nearbyState.pairCompatible[id]) && !nearbyState.pairDuplicates[id]).length,
count => { nearbyPresence.online = count; }, { immediate: true });
/** Derived from the private key while the own room is joined; tags QR rooms. */
let pairSecret = "";
let duplicateCheck = 0;

/**
 * Scanning a QR shown by one of this account's devices that is already
 * connected only duplicates it. Hide such peers, and end a QR session that
 * holds nothing else (unless something is still being sent over it).
 */
async function refreshPairDuplicates() {
  const roomId = nearbyState.pairKey?.roomId;
  const secret = pairSecret;
  const run = ++duplicateCheck;
  if (!roomId || !secret || !Object.keys(nearbyState.pairDevices).length) {
    if (Object.keys(nearbyState.pairDuplicates).length) nearbyState.pairDuplicates = {};
    return;
  }
  const connected = Object.entries(nearbyState.ownDevices).filter(([peer]) => nearbyState.ownCompatible[peer]);
  const ownTags = new Set(await Promise.all(connected.map(([, device]) => pairDeviceTag(secret, roomId, device))));
  if (run !== duplicateCheck || nearbyState.pairKey?.roomId !== roomId) return;
  const duplicates = Object.fromEntries(Object.entries(nearbyState.pairDevices).filter(([, tag]) => ownTags.has(tag)).map(([peer]) => [peer, true]));
  nearbyState.pairDuplicates = duplicates;
  const peers = Object.keys(nearbyState.pairPeers);
  const busy = nearbyState.transfers.some(item => item.kind === "pair" && (inFlight(item.state) || item.state === "paused"));
  if (peers.length && peers.every(peer => duplicates[peer]) && !busy) {
    useUIStore().addToast("这台设备已在「我的设备」中，已结束扫码配对", 3_000, "info");
    await stopPairRoom();
  }
}
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

/** Persist a custom name for this device and tell connected peers. */
export function renameNearbyDevice(name: string) {
  nearbyState.deviceName = saveDeviceName(name);
  rooms.own?.setDeviceName(nearbyState.deviceName);
  rooms.pair?.setDeviceName(nearbyState.deviceName);
  return nearbyState.deviceName;
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
  forgetHistory(id);
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
  if (!compatibleFor(kind)[peerId]) throw new Error("nearby_peer_outdated");
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error("nearby_batch_too_large");
  if (nearbyState.transfers.length >= 100 || nearbyState.transfers.reduce((sum, item) => sum + batchBytes(item.source || []), 0) + batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error('nearby_queue_full');
  const wireId = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  const transfer: NearbyTransferRecord = {
    id: `out:${wireId}`, wireId, kind, peerId, direction: "out", peerName: peersFor(kind)[peerId] || "附近的设备",
    ...(kind === "own" && nearbyState.ownDevices[peerId] ? { peerDevice: nearbyState.ownDevices[peerId] } : {}),
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
      item.state = 'waiting';
      task.controller = new AbortController();
      try {
        const accepted = await task.room.send(item.peerId, item.source || [], (index, percent) => {
          if (!task.canceled && !task.controller?.signal.aborted) { item.state = 'active'; item.progress[index] = percent; }
        }, item.text, { id: item.wireId, signal: task.controller.signal, onVerifying: () => { if (!task.canceled) item.state = 'verifying'; } });
        if (!task.canceled && !task.controller.signal.aborted) {
          item.state = accepted ? 'done' : 'declined';
        }
      } catch {
        if (!task.canceled) item.state = peersFor(item.kind)[item.peerId] ? 'failed' : 'paused';
      } finally {
        task.controller = null; task.finish();
        // A peer can reconnect while the failed request is still unwinding.
        if (!task.canceled && item.state === 'paused' && rooms[item.kind] === task.room
          && compatibleFor(item.kind)[item.peerId]) {
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
  if (item.state === 'declined') {
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

/* ---- Encrypted history (文件传输助手 records survive reloads for 7 days) ---- */

const historyAccount = () => (useKeyStore().pkHex || "").toLowerCase();
const savedSnapshots = new Map<string, string>();
let historyGeneration = 0;
let restoredFor = "";
let fileWrites: Promise<unknown> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let quotaWarned = false;
/** Restored files are decrypted into memory up to this budget; the rest on demand. */
const RESTORE_BUDGET_BYTES = 256 * 1024 * 1024;

function resetHistory() {
  historyGeneration++;
  restoredFor = "";
  savedSnapshots.clear();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}

function forgetHistory(id: string) {
  const account = historyAccount();
  savedSnapshots.delete(id);
  if (canStoreHistory(account)) void deleteHistory(account, [id]).catch(() => undefined);
}

function warnStorageFailure(error: unknown) {
  if (quotaWarned || (error as Error)?.message === "local_vault_locked") return;
  quotaWarned = true;
  useUIStore().addToast("无法在本机保存传输记录，文件仅保留到关闭页面，请及时保存", 4_000, "error");
}

function flushHistory() {
  saveTimer = null;
  const account = historyAccount();
  if (!canStoreHistory(account)) return;
  const generation = historyGeneration;
  for (const record of nearbyState.transfers) {
    const snapshot = toStored(record);
    const json = JSON.stringify(snapshot);
    if (savedSnapshots.get(record.id) === json) continue;
    savedSnapshots.set(record.id, json);
    void putHistoryRecord(account, snapshot).catch(error => {
      if (generation === historyGeneration) { savedSnapshots.delete(record.id); warnStorageFailure(error); }
    });
  }
}

// Progress ticks are excluded: only states and names are worth a write.
watch(() => nearbyState.transfers.map(item => [item.id, item.state, item.saveState, item.peerName, item.stored?.join()].join("|")).join("\n"), () => {
  if (!saveTimer) saveTimer = setTimeout(flushHistory, 800);
});

function storeReceivedFile(record: NearbyTransferRecord, index: number, file: File) {
  const account = historyAccount();
  if (!canStoreHistory(account)) return;
  const generation = historyGeneration;
  fileWrites = fileWrites.then(async () => {
    if (generation !== historyGeneration || !nearbyState.transfers.includes(record)) return;
    try {
      if (!await putHistoryFile(account, record.id, index, file)) return;
      // Removed while sealing: drop the copy rather than leaving orphans.
      if (generation !== historyGeneration || !nearbyState.transfers.includes(record)) { await deleteHistory(account, [record.id]); return; }
      const stored = record.stored?.slice() || record.files.map(() => false);
      stored[index] = true;
      record.stored = stored;
    } catch (error) {
      if (generation === historyGeneration) warnStorageFailure(error);
    }
  });
}

function restoredState(record: Pick<NearbyTransferRecord, "state">): NearbyTransferRecord["state"] {
  return ["done", "declined", "canceled"].includes(record.state) ? record.state : "failed";
}

/** Bring back this account's recent records once per session. */
export async function restoreNearbyHistory() {
  const account = historyAccount();
  if (!canStoreHistory(account) || restoredFor === account) return;
  restoredFor = account;
  const generation = historyGeneration;
  const stored = await loadHistory(account).catch(() => []);
  if (generation !== historyGeneration) return;
  const known = new Set(nearbyState.transfers.map(item => item.id));
  for (const item of stored) {
    if (known.has(item.id) || nearbyState.transfers.length >= 100) continue;
    nearbyState.transfers.push({
      ...item, peerId: "", restored: true, state: restoredState(item),
      progress: item.files.map((_, index) => item.direction === "out" || item.stored?.[index] ? 1 : 0),
      received: item.files.map(() => undefined),
    });
    savedSnapshots.set(item.id, JSON.stringify(item));
  }
  nearbyState.transfers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  let budget = RESTORE_BUDGET_BYTES;
  for (const record of nearbyState.transfers) {
    if (!record.restored || record.direction !== "in" || !record.stored?.some(Boolean)) continue;
    const size = batchBytes(record.files.filter((_, index) => record.stored?.[index]));
    if (size > budget) continue;
    budget -= size;
    await loadNearbyHistoryFiles(record.id);
    if (generation !== historyGeneration) return;
  }
}

/** Decrypt a restored record's files into memory so they can be previewed and saved. */
export async function loadNearbyHistoryFiles(id: string) {
  const account = historyAccount();
  const record = nearbyState.transfers.find(item => item.id === id);
  if (!record || !canStoreHistory(account)) return false;
  const generation = historyGeneration;
  for (const [index, meta] of record.files.entries()) {
    if (record.received[index] || !record.stored?.[index]) continue;
    const file = await loadHistoryFile(account, id, index, meta.name, meta.type);
    if (generation !== historyGeneration) return false;
    if (file) record.received[index] = file;
  }
  return record.files.every((_, index) => !!record.received[index]);
}
