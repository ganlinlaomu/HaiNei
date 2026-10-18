import { reactive } from "vue";
import { useUIStore } from "@/stores/ui";
import { onAppResume } from "@/services/appResumeCoordinator";
import {
  NEARBY_MAX_BATCH_BYTES,
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
  direction: "in" | "out";
  peerName: string;
  files: NearbyFileMeta[];
  progress: number[];
  received: (File | undefined)[];
  state: "waiting" | "active" | "done" | "declined" | "failed";
};

export type PendingOffer = { offer: NearbyOffer; peerName: string; resolve: (ok: boolean) => void };

export const nearbyState = reactive({
  deviceName: defaultDeviceName(),
  ownAccount: "",
  ownJoined: false,
  ownPeers: {} as Record<string, string>,
  ownError: "",
  pairKey: null as NearbyRoomKey | null,
  pairPeers: {} as Record<string, string>,
  pairError: "",
  transfers: [] as NearbyTransferRecord[],
  pendingOffer: null as PendingOffer | null,
});

const rooms: Partial<Record<RoomKind, NearbyRoom>> = {};
let stopResumeWatch: (() => void) | null = null;
let discoveryRefresh: Promise<void> | null = null;

export function refreshNearbyDiscovery() {
  if (!rooms.own && !rooms.pair) return Promise.resolve();
  if (discoveryRefresh) return discoveryRefresh;
  lastRefreshAt = Date.now();
  const current = { ...rooms };
  discoveryRefresh = (async () => {
    await refreshNearbyRelaySockets();
    for (const kind of ["own", "pair"] as const) {
      const room = current[kind];
      const error = kind === "own" ? nearbyState.ownError : nearbyState.pairError;
      if (!room || rooms[kind] !== room || !error.includes("could not connect to peer") || Object.keys(peersFor(kind)).length) continue;
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
  useUIStore().addToast(`${pending.peerName} 想发送 ${pending.offer.files.length} 个文件，请打开「我的 › 附近传输」确认`, 6_000, "info");
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
    onPeers: next => {
      if (kind === "own") nearbyState.ownPeers = next;
      else nearbyState.pairPeers = next;
    },
    onError: message => {
      if (kind === "own") nearbyState.ownError = message;
      else nearbyState.pairError = message;
    },
    onOffer: offer => new Promise<boolean>(resolve => {
      const peerName = peersFor(kind)[offer.from] || "附近的设备";
      const transfer: NearbyTransferRecord = {
        id: `${kind}:${offer.id}`, direction: "in", peerName, files: offer.files,
        progress: offer.files.map(() => 0), received: offer.files.map(() => undefined), state: "waiting",
      };
      nearbyState.transfers.unshift(transfer);
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        updateTransfer(transfer.id, item => { item.state = ok ? "active" : "declined"; });
        if (nearbyState.pendingOffer?.offer.id === offer.id) nearbyState.pendingOffer = null;
        const queued = offerQueue.findIndex(item => item.offer.id === offer.id);
        if (queued >= 0) offerQueue.splice(queued, 1);
        showNextOffer();
        resolve(ok);
      };
      // Answer before the sender's request times out.
      const timer = setTimeout(() => finish(false), NEARBY_OFFER_TIMEOUT_MS - 5_000);
      const pending: PendingOffer = { offer, peerName, resolve: finish };
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
  await leaveOwnDevicesRoom();
  const room = makeRoom("own");
  rooms.own = room;
  nearbyState.ownAccount = normalized;
  nearbyState.ownError = "";
  try {
    const key = await ownDevicesRoom(privateKeyHex);
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
  const room = rooms.own;
  rooms.own = undefined;
  nearbyState.ownAccount = "";
  nearbyState.ownJoined = false;
  nearbyState.ownPeers = {};
  nearbyState.ownError = "";
  ownRoomId = "";
  updateRelayResumeWatch();
  if (room) await room.leave();
}

export async function startPairRoom(key: NearbyRoomKey) {
  if (nearbyState.pairKey?.roomId === key.roomId && rooms.pair) return;
  await stopPairRoom();
  const room = makeRoom("pair");
  rooms.pair = room;
  nearbyState.pairKey = key;
  nearbyState.pairError = "";
  try {
    await room.join(key);
    updateRelayResumeWatch();
  } catch (error) {
    await stopPairRoom();
    throw error;
  }
}

export async function stopPairRoom() {
  const room = rooms.pair;
  rooms.pair = undefined;
  nearbyState.pairKey = null;
  nearbyState.pairPeers = {};
  nearbyState.pairError = "";
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

export async function sendNearbyFiles(kind: RoomKind, peerId: string, files: File[]) {
  const room = rooms[kind];
  if (!room) throw new Error("nearby_not_joined");
  if (batchBytes(files) > NEARBY_MAX_BATCH_BYTES) throw new Error("nearby_batch_too_large");
  const transfer: NearbyTransferRecord = {
    id: `out:${Date.now()}:${Math.random()}`, direction: "out", peerName: peersFor(kind)[peerId] || "附近的设备",
    files: files.map(file => ({ name: file.name, size: file.size, type: file.type })),
    progress: files.map(() => 0), received: files.map(() => undefined), state: "waiting",
  };
  nearbyState.transfers.unshift(transfer);
  try {
    const accepted = await room.send(peerId, files, (index, percent) => {
      updateTransfer(transfer.id, item => { item.state = "active"; item.progress[index] = percent; });
    });
    updateTransfer(transfer.id, item => { item.state = accepted ? "done" : "declined"; });
  } catch {
    updateTransfer(transfer.id, item => { item.state = "failed"; });
  }
}
