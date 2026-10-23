import { useCallStore, type CallEndReason } from "@/stores/call";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { sendDirectMessage, sendFastControl } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { refreshNearbyRelaySockets } from "@/services/nearbyTransfer";
import { turnIceServers } from "@/services/relaySession";
import { debugLog, startupMark } from "@/utils/debugLog";
import { reloadRingtoneElement, ringtoneElement, setRingAudioSession, sharedAudioContext } from "@/utils/audioUnlock";
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
// A network switch (Wi-Fi <-> cellular) drops the peer; Trystero re-discovers
// it through the relays. Show 重新连接中 and wait this long before ending.
const PEER_LOSS_GRACE_MS = 20_000;
const STATS_INTERVAL_MS = 4_000;
// Ending the call yourself closes the screen almost at once (a lingering
// screen looked frozen). When the other side or the network ended it, keep
// the reason and 回拨 / 重拨 visible a little longer.
const ENDED_BY_ME_MS = 500;
const ENDED_SCREEN_MS = 2_500;
const ENDED_BY_ME = new Set<CallEndReason>(["hangup", "declined", "cancelled", "answered_elsewhere"]);
const STUN: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

// Trystero 0.26: handlers are assigned properties, actions are objects.
type Room = import("trystero").Room;

type CallDirection = "outgoing" | "incoming";
type CallSession = {
  id: string;
  peer: string;
  direction: CallDirection;
  owner: string;
  room: Room | null;
  localStream: MediaStream | null;
  remoteAudio: HTMLAudioElement | null;
  mediaPeer: string;
  timers: Set<ReturnType<typeof setTimeout>>;
  peerLossTimer: ReturnType<typeof setTimeout> | null;
  ringtone: { stop(): void } | null;
  wakeLock: { release(): Promise<void> } | null;
  statsTimer: ReturnType<typeof setInterval> | null;
  /** Connection summary for the call's diagnostics. */
  quality: { route: string; rttMs: number; lost: number; received: number; poorSamples: number; samples: number };
};

let activeSession: CallSession | null = null;

function account() {
  return useKeyStore().pkHex.toLowerCase();
}

function createSession(id: string, peer: string, direction: CallDirection): CallSession {
  const session: CallSession = {
    id, peer, direction, owner: account(), room: null, localStream: null, remoteAudio: null,
    mediaPeer: "", timers: new Set(), peerLossTimer: null, ringtone: null, wakeLock: null,
    statsTimer: null, quality: { route: "", rttMs: 0, lost: 0, received: 0, poorSamples: 0, samples: 0 },
  };
  activeSession = session;
  return session;
}

function isCurrent(session: CallSession) {
  const store = useCallStore();
  return activeSession === session
    && store.callId === session.id
    && store.phase !== "idle"
    && store.phase !== "ended"
    && account() === session.owner;
}

function later(session: CallSession, ms: number, run: () => void) {
  if (!isCurrent(session)) return;
  const timer = setTimeout(() => {
    session.timers.delete(timer);
    if (isCurrent(session)) run();
  }, ms);
  session.timers.add(timer);
}

function clearTimers(session: CallSession) {
  for (const timer of session.timers) clearTimeout(timer);
  session.timers.clear();
  if (session.peerLossTimer) clearTimeout(session.peerLossTimer);
  session.peerLossTimer = null;
  if (session.statsTimer) clearInterval(session.statsTimer);
  session.statsTimer = null;
}

/**
 * Sample WebRTC stats while connected: the route (direct vs TURN relay),
 * round-trip time and packet loss. Flags 网络不佳 in the call screen and
 * leaves a summary in the call's diagnostics.
 */
function startQualitySampling(session: CallSession, room: Room) {
  if (session.statsTimer) return;
  let lastLost = 0;
  let lastReceived = 0;
  session.statsTimer = setInterval(async () => {
    const store = useCallStore();
    if (!isCurrent(session)) return;
    const connection = room.getPeers()[session.mediaPeer];
    if (!connection) return;
    try {
      const report: any = await connection.getStats();
      let pair: any = null;
      let inbound: any = null;
      report.forEach((entry: any) => {
        if (entry.type === "candidate-pair" && entry.state === "succeeded" && (entry.nominated || entry.selected)) pair = entry;
        if (entry.type === "inbound-rtp" && entry.kind === "audio") inbound = entry;
      });
      const rttMs = pair?.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : 0;
      const local = pair ? report.get(pair.localCandidateId)?.candidateType || "" : "";
      const remote = pair ? report.get(pair.remoteCandidateId)?.candidateType || "" : "";
      const route = local === "relay" || remote === "relay" ? "relay" : local ? "direct" : "";
      if (route && !session.quality.route) startupMark("call_route", { route, local, remote, rttMs });
      if (route) session.quality.route = route;
      const lost = Math.max(0, (inbound?.packetsLost || 0) - lastLost);
      const received = Math.max(0, (inbound?.packetsReceived || 0) - lastReceived);
      lastLost = inbound?.packetsLost || 0;
      lastReceived = inbound?.packetsReceived || 0;
      const lossPct = lost + received ? (lost / (lost + received)) * 100 : 0;
      const poor = lossPct > 5 || rttMs > 400 || (inbound?.jitter || 0) > 0.06;
      Object.assign(session.quality, {
        rttMs: rttMs || session.quality.rttMs, lost: session.quality.lost + lost, received: session.quality.received + received,
        poorSamples: session.quality.poorSamples + Number(poor), samples: session.quality.samples + 1,
      });
      store.quality = poor ? "poor" : "good";
    } catch { /* stats unavailable this round */ }
  }, STATS_INTERVAL_MS);
}

function closeCallNotification() {
  try { navigator.serviceWorker?.controller?.postMessage({ type: "CLOSE_CALL_NOTIFICATION" }); } catch { /* best effort */ }
}

// Signals take the fast path: all relays at once, first accept wins, and the
// invite's push leaves immediately with the encrypted wrap inside.
async function sendSignal(peer: string, signal: CallSignal) {
  const keys = useKeyStore();
  const started = Date.now();
  await sendFastControl({
    recipientPubkeys: [peer],
    content: serializeCallSignal(signal),
    tags: callControlTags(signal),
    relays: [...new Set([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage("write")])],
    context: { senderPubkey: keys.pkHex, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
    ...(signal.action === "invite" ? { push: "call" as const } : {}),
  });
  startupMark("call_signal_sent", { action: signal.action, ms: Date.now() - started });
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

/**
 * Call records in the chat. Only a missed call is sent to the peer (it counts
 * as unread and notifies). Every other outcome is a private note each side
 * keeps for itself: self-authored, it never adds to anyone's unread count.
 */
function recordCall(session: CallSession, reason: CallEndReason, durationSeconds: number) {
  const outgoing = session.direction === "outgoing";
  const missed = outgoing && (reason === "no_answer" || reason === "cancelled");
  const outcome = durationSeconds > 0 ? formatDuration(durationSeconds)
    : missed ? "未接听"
      : outgoing && reason === "remote_declined" ? "对方已拒绝"
        : outgoing && reason === "remote_busy" ? "对方忙"
          : !outgoing && reason === "declined" ? "已拒绝"
            : outgoing && (reason === "failed" || reason === "remote_hangup") ? "未接通"
              : "";
  // Incoming calls the caller records as missed, or another device handled.
  if (!outcome) return;
  const keys = useKeyStore();
  const options = {
    recipientPubkeys: [session.peer],
    content: `📞 语音通话 · ${outcome}`,
    tags: [["t", DIRECT_MESSAGE_TYPE], ["t", CALL_LOG_TYPE], ...(missed ? [["t", CALL_MISSED_TYPE]] : [])],
    relays: [...new Set([...DEFAULT_RELAY_URLS, ...getRelaysFromStorage("write")])],
    context: { senderPubkey: keys.pkHex, nip44Encrypt: keys.nip44Encrypt.bind(keys), signEvent: keys.signEvent.bind(keys) },
  };
  const sent = missed ? sendDirectMessage(options) : sendFastControl({ ...options, selfOnly: true });
  void sent.catch(() => undefined);
}

function startTone(session: CallSession, kind: "ring" | "ringback") {
  stopTone(session);
  // Android: vibrate with the ring (iOS web has no vibration).
  let vibration: ReturnType<typeof setInterval> | null = null;
  if (kind === "ring" && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate([400, 200, 400]);
    vibration = setInterval(() => navigator.vibrate?.([400, 200, 400]), 2_000);
  }
  // Preferred: the <audio> element primed by an earlier tap (works in the
  // standalone PWA, where Web Audio may stay silent after backgrounding).
  const first = ringtoneElement(kind);
  if (!first) {
    startWebAudioTone(session, kind, vibration);
    return;
  }
  const play = (element: HTMLAudioElement, attempt: number) => {
    element.currentTime = 0;
    element.muted = false;
    const playing = element.play();
    session.ringtone = { stop() {
      element.pause();
      element.currentTime = 0;
      if (vibration) { clearInterval(vibration); navigator.vibrate?.(0); }
    } };
    void playing.then(
      () => startupMark("call_ring_audio", { kind, via: "element", attempt }),
      error => {
        const name = error instanceof Error ? error.name : "unknown";
        startupMark("call_ring_audio_failed", { kind, via: "element", attempt, error: name, mediaError: element.error?.code ?? 0 });
        if (!session.ringtone || !isCurrent(session)) return;
        // The source failed to load (not a permission problem): rebuild it once.
        const retry = name === "NotSupportedError" && attempt === 1 ? reloadRingtoneElement(kind) : null;
        if (retry) play(retry, 2);
        else startWebAudioTone(session, kind, vibration);
      },
    );
  };
  play(first, 1);
}

function startWebAudioTone(session: CallSession, kind: "ring" | "ringback", vibration: ReturnType<typeof setInterval> | null) {
  try {
    // The shared context was unlocked by an earlier tap; a fresh one created
    // now (no gesture) would stay silent on iOS.
    const shared = sharedAudioContext();
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    const context: AudioContext | null = shared || (Context ? new Context() : null);
    if (!context) throw new Error("no_audio");
    setRingAudioSession(true);
    void context.resume?.().catch(() => undefined);
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(context.destination);
    const oscillator = context.createOscillator();
    oscillator.frequency.value = kind === "ring" ? 660 : 440;
    oscillator.connect(gain);
    oscillator.start();
    // Ring: two short bursts every 2 s. Ringback: 1 s on, 3 s off.
    let step = 0;
    const interval = setInterval(() => {
      step = (step + 1) % (kind === "ring" ? 8 : 16);
      const on = kind === "ring" ? step === 0 || step === 2 : step < 4;
      gain.gain.setTargetAtTime(on ? 0.12 : 0, context.currentTime, 0.01);
    }, 250);
    session.ringtone = { stop() {
      clearInterval(interval);
      if (vibration) { clearInterval(vibration); navigator.vibrate?.(0); }
      try { oscillator.stop(); oscillator.disconnect(); gain.disconnect(); } catch { /* stopped */ }
      setRingAudioSession(false);
      // Never close the shared context: later calls ring through it.
      if (context !== shared) void context.close().catch(() => undefined);
    } };
    if (context.state !== "running") startupMark("call_ring_audio_locked", { kind, state: context.state });
    else startupMark("call_ring_audio", { kind, via: "webaudio", shared: context === shared });
  } catch {
    session.ringtone = vibration ? { stop() { clearInterval(vibration!); navigator.vibrate?.(0); } } : null;
  }
}

function stopTone(session: CallSession) {
  session.ringtone?.stop();
  session.ringtone = null;
}

async function keepScreenOn(session: CallSession) {
  let lock: { release(): Promise<void> } | null = null;
  try { lock = await (navigator as any).wakeLock?.request?.("screen") || null; } catch { /* unavailable */ }
  if (!lock) return;
  if (!isCurrent(session)) {
    void lock.release().catch(() => undefined);
    return;
  }
  const previous = session.wakeLock;
  session.wakeLock = lock;
  void previous?.release().catch(() => undefined);
}

async function getMicrophone() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
}

function playRemote(session: CallSession, stream: MediaStream) {
  if (!session.remoteAudio) {
    session.remoteAudio = document.createElement("audio");
    session.remoteAudio.autoplay = true;
    session.remoteAudio.setAttribute("playsinline", "");
    session.remoteAudio.style.display = "none";
    document.body.appendChild(session.remoteAudio);
  }
  session.remoteAudio.srcObject = stream;
  void session.remoteAudio.play().catch(error => {
    if (isCurrent(session)) {
      debugLog("system", "call_remote_audio_blocked", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }, "warn");
    }
  });
}

async function joinCallRoom(session: CallSession, roomId: string, secret: string) {
  const [{ joinRoom }, , turn] = await Promise.all([
    import("trystero"),
    // Trystero deliberately reuses Nostr sockets between rooms. Probe them
    // before every call so a half-open socket left by suspension/earlier calls
    // cannot make later calls silently undiscoverable.
    refreshNearbyRelaySockets().catch(() => 0),
    turnIceServers().catch(() => []),
  ]);
  const store = useCallStore();
  // Relay/TURN preparation is asynchronous. The user may have cancelled or
  // another device may have handled the call while it was in flight.
  if (!isCurrent(session)) {
    throw new Error("call_cancelled");
  }
  let joined: Room | null = null;
  const created: Room = joinRoom({
    appId: CALL_APP_ID,
    password: secret,
    relayConfig: { urls: [...DEFAULT_RELAY_URLS], redundancy: DEFAULT_RELAY_URLS.length },
    rtcConfig: { iceServers: [...STUN, ...turn] },
  }, roomId, {
    onJoinError: ({ error }) => {
      // The callback can fire while joinRoom is still returning. Defer once so
      // the room reference is installed before deciding whether it is current.
      queueMicrotask(() => {
        if (!joined || session.room !== joined || !isCurrent(session) || store.phase === "active") return;
        startupMark("call_peer_connection_failed", { reason: error.slice(0, 120) });
        void finish(session, "failed", true);
      });
    },
  });
  joined = created;
  if (!isCurrent(session)) {
    void created.leave().catch(() => undefined);
    throw new Error("call_cancelled");
  }
  session.room = created;
  const currentRoom = created;
  const active = () => isCurrent(session) && session.room === currentRoom;
  const addLocalStream = (peerId: string) => {
    const stream = session.localStream;
    if (!stream || !active()) return;
    for (const sending of currentRoom.addStream(stream, { target: peerId })) {
      void sending.catch(error => {
        if (active()) debugLog("system", "call_stream_send_failed", {
          reason: error instanceof Error ? error.message.slice(0, 80) : "unknown",
        }, "warn");
      });
    }
  };
  // A second device of the callee joined after another one answered.
  const taken = currentRoom.makeAction<boolean>("taken", {
    onMessage: () => { if (active()) void finish(session, "answered_elsewhere", false); },
  });
  const sendTaken = (peerId: string) => { void taken.send(true, { target: peerId }).catch(() => undefined); };
  currentRoom.onPeerJoin = peerId => {
    if (!active()) return;
    if (session.mediaPeer && session.mediaPeer !== peerId) {
      // A reconnect can return with a new Trystero peer id. During the short
      // loss grace period, adopt it instead of mistaking it for another device.
      if (session.peerLossTimer) {
        clearTimeout(session.peerLossTimer);
        session.peerLossTimer = null;
        session.mediaPeer = peerId;
        store.reconnecting = false;
        startupMark("call_reconnected", { newPeer: true });
        addLocalStream(peerId);
        return;
      }
      // The caller is the room's arbiter. An answering device must not mark
      // another answering device as taken: in a near-simultaneous answer that
      // would make both callees dismiss each other. The caller joined before
      // sending the invite and keeps the first callee only.
      if (session.direction === "outgoing") sendTaken(peerId);
      return;
    }
    session.mediaPeer = peerId;
    if (session.peerLossTimer) {
      clearTimeout(session.peerLossTimer);
      session.peerLossTimer = null;
      store.reconnecting = false;
      startupMark("call_reconnected", { newPeer: false });
    }
    addLocalStream(peerId);
  };
  currentRoom.onPeerStream = (stream, peerId) => {
    if (!active() || peerId !== session.mediaPeer) return;
    playRemote(session, stream);
    stopTone(session);
    store.reconnecting = false;
    if (store.phase !== "active") {
      store.phase = "active";
      store.connectedAt = Date.now();
      startupMark("call_connected", { direction: session.direction });
      startQualitySampling(session, currentRoom);
    }
  };
  currentRoom.onPeerLeave = peerId => {
    if (!active() || peerId !== session.mediaPeer) return;
    if (store.phase !== "active") {
      session.mediaPeer = "";
      return;
    }
    // A brief network switch can drop and rejoin; give it a moment, and
    // re-check our relay sockets so the peer can be re-discovered.
    store.reconnecting = true;
    startupMark("call_peer_lost", {});
    void refreshNearbyRelaySockets().catch(() => 0);
    if (session.peerLossTimer) clearTimeout(session.peerLossTimer);
    session.peerLossTimer = setTimeout(() => {
      session.peerLossTimer = null;
      if (active()) void finish(session, "remote_hangup", false);
    }, PEER_LOSS_GRACE_MS);
  };
}

async function releaseSessionResources(session: CallSession) {
  clearTimers(session);
  stopTone(session);
  const leaving = session.room;
  session.room = null;
  if (leaving) {
    leaving.onPeerJoin = null;
    leaving.onPeerStream = null;
    leaving.onPeerLeave = null;
  }
  const stream = session.localStream;
  session.localStream = null;
  for (const track of stream?.getTracks() || []) track.stop();
  const audio = session.remoteAudio;
  session.remoteAudio = null;
  if (audio) {
    try { audio.pause(); } catch { /* unsupported test/browser shim */ }
    audio.srcObject = null;
    audio.remove();
  }
  const lock = session.wakeLock;
  session.wakeLock = null;
  void lock?.release().catch(() => undefined);
  session.mediaPeer = "";
  try { await leaving?.leave(); } catch { /* already gone */ }
}

function discardOrphanedSession() {
  const session = activeSession;
  if (!session) return;
  const store = useCallStore();
  if (store.callId === session.id && store.phase !== "idle" && store.phase !== "ended" && account() === session.owner) return;
  activeSession = null;
  closeCallNotification();
  void releaseSessionResources(session);
}

/** Tear everything down; `notify` sends the matching signal to the peer. */
async function finish(session: CallSession, reason: CallEndReason, notify: boolean, options: { log?: boolean } = {}) {
  const store = useCallStore();
  if (activeSession !== session) return;
  if (store.callId !== session.id || store.phase === "idle" || store.phase === "ended") {
    activeSession = null;
    await releaseSessionResources(session);
    return;
  }
  const peer = session.peer;
  const id = session.id;
  const wasPhase = store.phase;
  const duration = store.connectedAt ? Math.round((Date.now() - store.connectedAt) / 1000) : 0;
  // Invalidate every callback before any asynchronous room teardown. Old
  // rooms can no longer stop tracks or mutate the next call.
  activeSession = null;
  closeCallNotification();
  store.phase = "ended";
  store.endReason = reason;
  const releasing = releaseSessionResources(session);
  if (notify && peer && id) {
    const action: CallSignal["action"] = wasPhase === "outgoing" ? "cancel"
      : wasPhase === "incoming" ? (reason === "busy" ? "busy" : "reject")
        : "end";
    sendSignalBestEffort(peer, { action, callId: id, ...(action === "end" ? { durationSeconds: duration } : {}) });
  }
  if (peer && options.log !== false) recordCall(session, reason, duration);
  const q = session.quality;
  startupMark("call_ended", {
    reason, durationSeconds: duration, direction: session.direction,
    route: q.route, rttMs: q.rttMs, lossPct: q.lost + q.received ? Math.round((q.lost / (q.lost + q.received)) * 1000) / 10 : 0,
    poorPct: q.samples ? Math.round((q.poorSamples / q.samples) * 100) : 0,
  });
  await releasing;
  // Leave the outcome on screen briefly, then close the overlay.
  setTimeout(() => { if (useCallStore().callId === id && useCallStore().phase === "ended") useCallStore().reset(); },
    ENDED_BY_ME.has(reason) ? ENDED_BY_ME_MS : ENDED_SCREEN_MS);
}

export async function startCall(peerPubkey: string) {
  const store = useCallStore();
  const peer = peerPubkey.toLowerCase();
  discardOrphanedSession();
  if (store.phase !== "idle" && store.phase !== "ended") throw new Error("正在通话中");
  if (!useFriendshipsStore().isAccepted(peer)) throw new Error("只能和已接受的好友通话");
  store.reset();
  const id = randomHex(16);
  const roomId = randomHex(16);
  const secret = randomHex(32);
  store.markSeen(id);
  store.phase = "outgoing";
  store.peer = peer;
  store.callId = id;
  store.direction = "outgoing";
  const session = createSession(id, peer, "outgoing");
  let stream: MediaStream;
  try {
    stream = await getMicrophone();
  } catch {
    if (isCurrent(session)) await finish(session, "microphone_denied", false, { log: false });
    return;
  }
  // getUserMedia may resolve after the user has already cancelled. Never let
  // that late stream leak or replace the media belonging to a newer call.
  if (!isCurrent(session) || store.phase !== "outgoing") {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  session.localStream = stream;
  void keepScreenOn(session);
  startTone(session, "ringback");
  try {
    await joinCallRoom(session, roomId, secret);
    await sendSignal(peer, { action: "invite", callId: id, room: roomId, secret });
    // If cancellation raced the publish, send a second cancel after the invite
    // completes so relay reordering cannot leave a ghost incoming screen.
    if (!isCurrent(session)) {
      sendSignalBestEffort(peer, { action: "cancel", callId: id });
      return;
    }
  } catch (error) {
    startupMark("call_start_failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    if (isCurrent(session)) await finish(session, "failed", false);
    return;
  }
  later(session, RING_TIMEOUT_MS, () => { if (store.phase === "outgoing") void finish(session, "no_answer", true); });
}

export async function acceptCall() {
  const store = useCallStore();
  discardOrphanedSession();
  const session = activeSession;
  if (!session || !isCurrent(session) || session.direction !== "incoming" || store.phase !== "incoming" || !store.invite) return;
  const invite = { ...store.invite };
  stopTone(session);
  closeCallNotification();
  store.phase = "connecting";
  let stream: MediaStream;
  try {
    stream = await getMicrophone();
  } catch {
    if (isCurrent(session)) await finish(session, "microphone_denied", true, { log: false });
    return;
  }
  if (!isCurrent(session) || store.phase !== "connecting") {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  session.localStream = stream;
  void keepScreenOn(session);
  // The self-copy of this accept stops our other devices from ringing.
  sendSignalBestEffort(session.peer, { action: "accept", callId: session.id });
  try {
    await joinCallRoom(session, invite.room, invite.secret);
  } catch (error) {
    startupMark("call_join_failed", { reason: error instanceof Error ? error.message.slice(0, 120) : "unknown" });
    if (isCurrent(session)) await finish(session, "failed", true);
    return;
  }
  later(session, CONNECT_TIMEOUT_MS, () => { if (store.phase === "connecting") void finish(session, "failed", true); });
}

export function declineCall() {
  discardOrphanedSession();
  const session = activeSession;
  return session && isCurrent(session) ? finish(session, "declined", true) : Promise.resolve();
}

export function hangup() {
  discardOrphanedSession();
  const store = useCallStore();
  const session = activeSession;
  return session && isCurrent(session)
    ? finish(session, store.phase === "outgoing" ? "cancelled" : "hangup", true)
    : Promise.resolve();
}

export function toggleMute() {
  const store = useCallStore();
  const session = activeSession;
  if (!session || !isCurrent(session)) return;
  store.muted = !store.muted;
  for (const track of session.localStream?.getAudioTracks() || []) track.enabled = !store.muted;
}

/**
 * Apply a call signal from `sender` (a friend, or this account's own device).
 * `createdAt` is the rumor time in seconds.
 */
export async function handleCallSignal(sender: string, recipient: string, signal: CallSignal, createdAt: number) {
  const store = useCallStore();
  const me = account();
  const normalizedSender = sender.toLowerCase();
  const normalizedRecipient = recipient.toLowerCase();
  const fromSelf = normalizedSender === me;
  const peer = fromSelf ? normalizedRecipient : normalizedSender;
  discardOrphanedSession();
  startupMark("call_signal_received", { action: signal.action, fromSelf, ageSeconds: Math.floor(Date.now() / 1000) - createdAt, phase: store.phase });
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
    store.phase = "incoming";
    store.peer = peer;
    store.callId = signal.callId;
    store.direction = "incoming";
    store.invite = { room: signal.room!, secret: signal.secret! };
    const session = createSession(signal.callId, peer, "incoming");
    // The app shows its own call banner: withdraw the system notification.
    closeCallNotification();
    startTone(session, "ring");
    // Tell the caller this device is ringing (对方响铃中).
    sendSignalBestEffort(peer, { action: "ringing", callId: signal.callId });
    later(session, RING_TIMEOUT_MS, () => { if (store.phase === "incoming") void finish(session, "no_answer", false); });
    return;
  }
  const session = activeSession;
  if (!session || !isCurrent(session) || store.callId !== signal.callId || session.id !== signal.callId || session.peer !== peer) {
    // NIP-17 copies can arrive from different relays out of order. Remember a
    // terminal signal seen before its invite so a cancelled call cannot ring
    // later as a ghost incoming call.
    store.markSeen(signal.callId);
    return;
  }
  if (fromSelf) {
    // Another of our devices answered or declined this incoming call.
    if (store.phase === "incoming" && (
      signal.action === "accept" || signal.action === "reject" || signal.action === "busy" || signal.action === "end"
    )) {
      await finish(session, "answered_elsewhere", false);
    }
    return;
  }
  if (signal.action === "ringing") {
    if (session.direction === "outgoing" && store.phase === "outgoing" && !store.remoteRinging) {
      store.remoteRinging = true;
    }
    return;
  }
  if (signal.action === "accept" && store.phase === "outgoing") {
    stopTone(session);
    store.phase = "connecting";
    later(session, CONNECT_TIMEOUT_MS, () => { if (store.phase === "connecting") void finish(session, "failed", true); });
    // Several callee devices can answer the same invite. Once one has accepted,
    // a late reject/busy from another device must not tear down that connection.
  } else if (signal.action === "reject" && session.direction === "outgoing" && store.phase === "outgoing") {
    await finish(session, "remote_declined", false);
  } else if (signal.action === "busy" && session.direction === "outgoing" && store.phase === "outgoing") {
    await finish(session, "remote_busy", false);
  } else if (signal.action === "cancel" && session.direction === "incoming" && (store.phase === "incoming" || store.phase === "connecting")) {
    await finish(session, "remote_cancelled", false);
  } else if (signal.action === "end") await finish(session, "remote_hangup", false);
}
