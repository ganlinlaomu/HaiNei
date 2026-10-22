import { useCallStore, type CallEndReason } from "@/stores/call";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { sendDirectMessage } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { prepareNearbyRelaySession } from "@/services/nearbyTransfer";
import { turnIceServers } from "@/services/relaySession";
import { debugLog } from "@/utils/debugLog";
import {
  CALL_LOG_TYPE, CALL_MISSED_TYPE, CALL_RING_WINDOW_SECONDS, callControlTags, randomHex, serializeCallSignal, type CallSignal,
} from "@/nostr/messaging/callControl";
import { DIRECT_MESSAGE_TYPE } from "@/nostr/messaging/messageRouting";

/**
 * One-to-one voice calls between accepted friends. Signaling travels as
 * NIP-17 control messages; the invite carries a one-time Trystero room and
 * password, so only the callee's devices can join. Audio goes over WebRTC
 * (DTLS-SRTP), with Cloudflare TURN only as an encrypted relay.
 */
const CALL_APP_ID = "hainei-call-v1";
const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 25_000;
const PEER_LOSS_GRACE_MS = 8_000;
const STUN: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

type Room = {
  leave(): Promise<void> | void;
  addStream(stream: MediaStream, target?: string | string[]): unknown;
  onPeerJoin(handler: (peerId: string) => void): void;
  onPeerLeave(handler: (peerId: string) => void): void;
  onPeerStream(handler: (stream: MediaStream, peerId: string) => void): void;
  makeAction<T>(name: string): [(data: T, target?: string | string[]) => unknown, (handler: (data: T, peerId: string) => void) => void];
};

let room: Room | null = null;
let localStream: MediaStream | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let mediaPeer = "";
let timers: Array<ReturnType<typeof setTimeout>> = [];
let peerLossTimer: ReturnType<typeof setTimeout> | null = null;
let ringtone: { stop(): void } | null = null;
let wakeLock: { release(): Promise<void> } | null = null;
let sendTaken: ((data: true, target?: string) => unknown) | null = null;

function account() {
  return useKeyStore().pkHex.toLowerCase();
}

function later(ms: number, run: () => void) {
  const timer = setTimeout(run, ms);
  timers.push(timer);
}

function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  if (peerLossTimer) clearTimeout(peerLossTimer);
  peerLossTimer = null;
}

function closeCallNotification() {
  try { navigator.serviceWorker?.controller?.postMessage({ type: "CLOSE_CALL_NOTIFICATION" }); } catch { /* best effort */ }
}

async function sendSignal(peer: string, signal: CallSignal) {
  const keys = useKeyStore();
  await sendDirectMessage({
    recipientPubkeys: [peer],
    content: serializeCallSignal(signal),
    tags: callControlTags(signal),
    relays: getRelaysFromStorage("write"),
    context: { senderPubkey: keys.pkHex, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
  });
}

function sendSignalBestEffort(peer: string, signal: CallSignal) {
  void sendSignal(peer, signal).catch(error => {
    debugLog("system", "call_signal_failed", { action: signal.action, reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }, "warn");
  });
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}分${String(seconds % 60).padStart(2, "0")}秒` : `${seconds}秒`;
}

/** The caller leaves one ordinary DM as the call's record in both chats. */
function sendCallLog(peer: string, reason: CallEndReason, durationSeconds: number) {
  const missed = reason === "no_answer" || reason === "cancelled";
  const outcome = durationSeconds > 0 ? formatDuration(durationSeconds)
    : missed ? "未接听"
      : reason === "remote_declined" ? "已拒绝"
        : reason === "remote_busy" ? "对方忙"
          : reason === "answered_elsewhere" ? "已在其他设备接听"
            : "未接通";
  const keys = useKeyStore();
  void sendDirectMessage({
    recipientPubkeys: [peer],
    content: `📞 语音通话 · ${outcome}`,
    // A missed call notifies the callee like a message; other outcomes do not.
    tags: [["t", DIRECT_MESSAGE_TYPE], ["t", CALL_LOG_TYPE], ...(missed ? [["t", CALL_MISSED_TYPE]] : [])],
    relays: getRelaysFromStorage("write"),
    context: { senderPubkey: keys.pkHex, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
  }).catch(() => undefined);
}

function startTone(kind: "ring" | "ringback") {
  try {
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Context) return;
    const context: AudioContext = new Context();
    void context.resume?.().catch(() => undefined);
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    const oscillator = context.createOscillator();
    oscillator.frequency.value = kind === "ring" ? 660 : 440;
    oscillator.connect(gain);
    oscillator.start();
    // Ring: two short bursts every 2 s. Ringback: 1 s on, 3 s off.
    let on = false;
    let step = 0;
    const interval = setInterval(() => {
      step = (step + 1) % (kind === "ring" ? 8 : 16);
      on = kind === "ring" ? step === 0 || step === 2 : step < 4;
      gain.gain.setTargetAtTime(on ? 0.12 : 0, context.currentTime, 0.01);
    }, 250);
    ringtone = { stop() { clearInterval(interval); try { oscillator.stop(); void context.close(); } catch { /* closed */ } } };
  } catch {
    // Autoplay may be blocked until a tap (iOS); the call screen still shows.
  }
}

function stopTone() {
  ringtone?.stop();
  ringtone = null;
}

async function keepScreenOn() {
  try { wakeLock = await (navigator as any).wakeLock?.request?.("screen") || null; } catch { wakeLock = null; }
}

async function getMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}

function playRemote(stream: MediaStream) {
  if (!remoteAudio) {
    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;
    remoteAudio.setAttribute("playsinline", "");
    remoteAudio.style.display = "none";
    document.body.appendChild(remoteAudio);
  }
  remoteAudio.srcObject = stream;
  void remoteAudio.play().catch(() => undefined);
}

async function joinCallRoom(roomId: string, secret: string) {
  const [{ joinRoom }, , turn] = await Promise.all([
    import("trystero"),
    prepareNearbyRelaySession().catch(() => undefined),
    turnIceServers().catch(() => []),
  ]);
  const store = useCallStore();
  const joined = joinRoom({
    appId: CALL_APP_ID,
    password: secret,
    relayConfig: { urls: [...DEFAULT_RELAY_URLS], redundancy: DEFAULT_RELAY_URLS.length },
    rtcConfig: { iceServers: [...STUN, ...turn] },
  } as any, roomId) as unknown as Room;
  room = joined;
  const [takenSend, onTaken] = joined.makeAction<true>("taken");
  sendTaken = takenSend as typeof sendTaken;
  // A second device of the callee joined after another one answered.
  onTaken(() => finish("answered_elsewhere", false));
  joined.onPeerJoin(peerId => {
    if (mediaPeer && mediaPeer !== peerId) {
      void sendTaken?.(true, peerId);
      return;
    }
    mediaPeer = peerId;
    if (peerLossTimer) { clearTimeout(peerLossTimer); peerLossTimer = null; }
    if (localStream) joined.addStream(localStream, peerId);
  });
  joined.onPeerStream((stream, peerId) => {
    if (peerId !== mediaPeer) return;
    playRemote(stream);
    stopTone();
    if (store.phase !== "active") {
      store.phase = "active";
      store.connectedAt = Date.now();
      debugLog("system", "call_connected", { direction: store.direction }, "info");
    }
  });
  joined.onPeerLeave(peerId => {
    if (peerId !== mediaPeer || store.phase !== "active") return;
    // A brief network switch can drop and rejoin; give it a moment.
    peerLossTimer = setTimeout(() => finish("remote_hangup", false), PEER_LOSS_GRACE_MS);
  });
}

/** Tear everything down; `notify` sends the matching signal to the peer. */
async function finish(reason: CallEndReason, notify: boolean) {
  const store = useCallStore();
  if (store.phase === "idle" || store.phase === "ended") return;
  const peer = store.peer;
  const id = store.callId;
  const wasPhase = store.phase;
  const duration = store.connectedAt ? Math.round((Date.now() - store.connectedAt) / 1000) : 0;
  clearTimers();
  stopTone();
  closeCallNotification();
  store.phase = "ended";
  store.endReason = reason;
  if (notify && peer && id) {
    const action: CallSignal["action"] = wasPhase === "outgoing" ? "cancel"
      : wasPhase === "incoming" ? (reason === "busy" ? "busy" : "reject")
        : "end";
    sendSignalBestEffort(peer, { action, callId: id, ...(action === "end" ? { durationSeconds: duration } : {}) });
  }
  if (store.direction === "outgoing" && peer) sendCallLog(peer, reason, duration);
  debugLog("system", "call_ended", { reason, durationSeconds: duration, direction: store.direction }, "info");
  const leaving = room;
  room = null;
  sendTaken = null;
  mediaPeer = "";
  try { await leaving?.leave(); } catch { /* already gone */ }
  for (const track of localStream?.getTracks() || []) track.stop();
  localStream = null;
  if (remoteAudio) { remoteAudio.srcObject = null; remoteAudio.remove(); remoteAudio = null; }
  void wakeLock?.release().catch(() => undefined);
  wakeLock = null;
  // Leave the outcome on screen briefly, then close the overlay.
  setTimeout(() => { if (useCallStore().callId === id && useCallStore().phase === "ended") useCallStore().reset(); }, 1_800);
}

export async function startCall(peerPubkey: string) {
  const store = useCallStore();
  const peer = peerPubkey.toLowerCase();
  if (store.phase !== "idle" && store.phase !== "ended") throw new Error("正在通话中");
  if (!useFriendshipsStore().isAccepted(peer)) throw new Error("只能和已接受的好友通话");
  store.reset();
  const id = randomHex(16);
  const roomId = randomHex(16);
  const secret = randomHex(32);
  store.markSeen(id);
  Object.assign(store, { phase: "outgoing", peer, callId: id, direction: "outgoing" });
  try {
    localStream = await getMicrophone();
  } catch {
    store.phase = "ended";
    store.endReason = "microphone_denied";
    setTimeout(() => { if (store.callId === id) store.reset(); }, 2_500);
    return;
  }
  if (store.callId !== id) return;
  void keepScreenOn();
  startTone("ringback");
  await joinCallRoom(roomId, secret);
  try {
    await sendSignal(peer, { action: "invite", callId: id, room: roomId, secret });
  } catch {
    await finish("failed", false);
    return;
  }
  later(RING_TIMEOUT_MS, () => { if (store.callId === id && store.phase === "outgoing") void finish("no_answer", true); });
}

export async function acceptCall() {
  const store = useCallStore();
  if (store.phase !== "incoming" || !store.invite) return;
  const id = store.callId;
  stopTone();
  closeCallNotification();
  store.phase = "connecting";
  try {
    localStream = await getMicrophone();
  } catch {
    await finish("microphone_denied", true);
    return;
  }
  if (store.callId !== id) return;
  void keepScreenOn();
  // The self-copy of this accept stops our other devices from ringing.
  sendSignalBestEffort(store.peer, { action: "accept", callId: id });
  await joinCallRoom(store.invite.room, store.invite.secret);
  later(CONNECT_TIMEOUT_MS, () => { if (store.callId === id && store.phase === "connecting") void finish("failed", true); });
}

export function declineCall() {
  return finish("declined", true);
}

export function hangup() {
  const store = useCallStore();
  return finish(store.phase === "outgoing" ? "cancelled" : "hangup", true);
}

export function toggleMute() {
  const store = useCallStore();
  store.muted = !store.muted;
  for (const track of localStream?.getAudioTracks() || []) track.enabled = !store.muted;
}

/**
 * Apply a call signal from `sender` (a friend, or this account's own device).
 * `createdAt` is the rumor time in seconds.
 */
export async function handleCallSignal(sender: string, recipient: string, signal: CallSignal, createdAt: number) {
  const store = useCallStore();
  const me = account();
  const fromSelf = sender === me;
  const peer = fromSelf ? recipient : sender;
  if (signal.action === "invite") {
    // Our own outgoing invite seen on another of our devices: not a call for us.
    if (fromSelf || store.seen.has(signal.callId)) return;
    store.markSeen(signal.callId);
    if (Math.floor(Date.now() / 1000) - createdAt > CALL_RING_WINDOW_SECONDS) return;
    if (store.phase !== "idle" && store.phase !== "ended") {
      sendSignalBestEffort(peer, { action: "busy", callId: signal.callId });
      return;
    }
    store.reset();
    Object.assign(store, {
      phase: "incoming", peer, callId: signal.callId, direction: "incoming",
      invite: { room: signal.room!, secret: signal.secret! },
    });
    startTone("ring");
    const id = signal.callId;
    later(RING_TIMEOUT_MS, () => { if (store.callId === id && store.phase === "incoming") void finish("no_answer", false); });
    return;
  }
  if (store.callId !== signal.callId) return;
  if (fromSelf) {
    // Another of our devices answered or declined this incoming call.
    if (store.phase === "incoming" && (signal.action === "accept" || signal.action === "reject" || signal.action === "busy")) {
      await finish("answered_elsewhere", false);
    }
    return;
  }
  if (signal.action === "accept" && store.phase === "outgoing") {
    stopTone();
    store.phase = "connecting";
    later(CONNECT_TIMEOUT_MS, () => { if (store.callId === signal.callId && store.phase === "connecting") void finish("failed", true); });
  } else if (signal.action === "reject") await finish("remote_declined", false);
  else if (signal.action === "busy") await finish("remote_busy", false);
  else if (signal.action === "cancel") await finish("remote_cancelled", false);
  else if (signal.action === "end") await finish("remote_hangup", false);
}
