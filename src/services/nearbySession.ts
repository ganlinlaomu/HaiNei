import { reactive } from "vue";
import { useUIStore } from "@/stores/ui";
import { onAppResume } from "@/services/appResumeCoordinator";
import { requestNearbyCameraAccess } from "@/services/nearbyCameraAccess";
import {
  NEARBY_MAX_BATCH_BYTES,
  NEARBY_MAX_TEXT_LENGTH,
  NEARBY_OFFER_TIMEOUT_MS,
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
  files: NearbyFileMeta[];
  text?: string;
  progress: number[];
  received: (File | undefined)[];
  state: "waiting" | "active" | "done" | "declined" | "failed";
};

export type PendingOffer = { transferId: string; offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void };

export const nearbyState = reactive({
  deviceName: defaultDeviceName(),
  ownAccount: "",
  ownJoined: false,
  ownPeers: {} as Record<string, string>,
  ownTextPeers: {} as Record<string, boolean>,
  ownError: "",
  pairKey: null as NearbyRoomKey | null,
  pairPeers: {} as Record<string, string>,
  pairTextPeers: {} as Record<string, boolean>,
  pairError: "",
  transfers: [] as NearbyTransferRecord[],
  pendingOffer: null as PendingOffer | null,
});

const rooms: Partial<Record<RoomKind, NearbyRoom>> = {};
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
    onPeers: (next, textPeers = {}) => {
      for (const item of nearbyState.transfers) {
        if (item.kind === kind && !next[item.peerId] && (item.state === "active" || item.state === "waiting")) {
          item.state = "failed";
          const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === item.id);
          pending?.resolve(false);
          item.state = "failed";
        }
      }
      if (kind === "own") { nearbyState.ownPeers = next; nearbyState.ownTextPeers = textPeers; }
      else { nearbyState.pairPeers = next; nearbyState.pairTextPeers = textPeers; }
    },
    onError: message => {
      if (kind === "own") nearbyState.ownError = message;
      else nearbyState.pairError = message;
    },
    onOffer: offer => new Promise<boolean>(resolve => {
      const id = `${kind}:${offer.id}`;
      // Reserve memory for the entire batch, including files not received yet.
      // A trusted device must not fill the receiver with unlimited queued data.
      const reserved = nearbyState.transfers.reduce((sum, item) => sum + (
        item.direction !== "in" ? 0 : item.state === "active" || item.state === "waiting"
          ? batchBytes(item.files) : batchBytes(item.received.filter((file): file is File => !!file))
      ), 0);
      if (nearbyState.transfers.length >= 100 || nearbyState.transfers.some(item => item.id === id)
        || reserved + batchBytes(offer.files) > NEARBY_MAX_BATCH_BYTES) { resolve(false); return; }
      const peerName = peersFor(kind)[offer.from] || "附近的设备";
      const transfer: NearbyTransferRecord = {
        id, kind, peerId: offer.from, direction: "in", peerName, files: offer.files, text: offer.text,
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
  nearbyState.pairError = "";
  failRoomTransfers("pair");
  updateRelayResumeWatch();
  if (room) await room.leave();
}

/** Account switch / logout: drop every room and anything still in memory. */
export async function resetNearby() {
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
  if (index < 0 || ["active", "waiting"].includes(nearbyState.transfers[index].state)) return;
  nearbyState.transfers.splice(index, 1);
}

function failRoomTransfers(kind: RoomKind) {
  for (const item of nearbyState.transfers) {
    if (item.kind !== kind || !["active", "waiting"].includes(item.state)) continue;
    const pending = [nearbyState.pendingOffer, ...offerQueue].find(offer => offer?.transferId === item.id);
    pending?.resolve(false);
    item.state = "failed";
  }
}

export async function sendNearbyFiles(kind: RoomKind, peerId: string, files: File[], text = "") {
  const room = rooms[kind];
  if (!room) throw new Error("nearby_not_joined");
  text = text.trim();
  if ((!files.length && !text) || text.length > NEARBY_MAX_TEXT_LENGTH || files.length > 200 || !peersFor(kind)[peerId]) throw new Error("nearby_invalid_target_or_files");
  if (text && !(kind === "own" ? nearbyState.ownTextPeers : nearbyState.pairTextPeers)[peerId]) throw new Error("nearby_text_unsupported");
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error("nearby_batch_too_large");
  const transfer: NearbyTransferRecord = {
    id: `out:${Date.now()}:${Math.random()}`, kind, peerId, direction: "out", peerName: peersFor(kind)[peerId] || "附近的设备",
    files: files.map(file => ({ name: file.name, size: file.size, type: file.type })), text,
    progress: files.map(() => 0), received: files.map(() => undefined), state: "waiting",
  };
  nearbyState.transfers.unshift(transfer);
  try {
    const accepted = await room.send(peerId, files, (index, percent) => {
      updateTransfer(transfer.id, item => { item.state = "active"; item.progress[index] = percent; });
    }, text);
    updateTransfer(transfer.id, item => { item.state = accepted ? "done" : "declined"; });
  } catch {
    updateTransfer(transfer.id, item => { item.state = "failed"; });
  }
}
