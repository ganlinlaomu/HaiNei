import { useCallStore, type CallEndReason } from "@/stores/call";
import { useKeyStore } from "@/stores/keys";
import { useFriendshipsStore } from "@/stores/friendships";
import { sendDirectMessage, sendFastControl } from "@/nostr/messaging/service";
import { getRelaysFromStorage } from "@/nostr/relays";
import { DEFAULT_RELAY_URLS } from "@/services/connectionSettings";
import { refreshNearbyRelaySockets } from "@/services/nearbyTransfer";
import { turnIceServers } from "@/services/relaySession";
import { debugLog, startupMark } from "@/utils/debugLog";
import { incomingRingtoneArmed, reloadRingtoneElement, ringtoneElement, setCallAudioActive, setRingAudioSession } from "@/utils/audioUnlock";
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
  remoteStream: MediaStream | null;
  audioCleanup: (() => void) | null;
  audioRetryTimer: ReturnType<typeof setTimeout> | null;
  audioFailures: number;
  playRequest: number;
  /** Explicit browser-selected output, if the speaker-selection API is available. */
  outputDeviceId: string;
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
    id, peer, direction, owner: account(), room: null, localStream: null, remoteAudio: null, remoteStream: null,
    audioCleanup: null, audioRetryTimer: null, audioFailures: 0, playRequest: 0, outputDeviceId: "",
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
  if (session.audioRetryTimer) clearTimeout(session.audioRetryTimer);
  session.audioRetryTimer = null;
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
      // The audio element's play() promise can resolve even when iOS routes
      // sound to the receiver (or renders nothing). Record the RTP side
      // separately so a later no-sound report can distinguish the two.
      if (inbound && (session.quality.samples === 1 || session.quality.samples === 3)) {
        const track = session.remoteStream?.getAudioTracks?.()[0];
        startupMark("call_audio_media_stats", {
          packetsReceived: inbound.packetsReceived || 0,
          bytesReceived: inbound.bytesReceived || 0,
          totalAudioEnergy: inbound.totalAudioEnergy || 0,
          totalSamplesDuration: inbound.totalSamplesDuration || 0,
          trackMuted: track?.muted ?? null,
          trackState: track?.readyState ?? "unknown",
          elementPaused: session.remoteAudio?.paused ?? null,
          elementMuted: session.remoteAudio?.muted ?? null,
          sinkId: session.remoteAudio ? (session.remoteAudio as RoutedAudio).sinkId ?? "unsupported" : "no_element",
          sessionType: browserCallAudioSession()?.type || "unknown",
          sessionState: browserCallAudioSession()?.state || "unknown",
        });
      }
      // Packet arrival alone does not prove that WebKit is rendering sound.
      if (inbound && received > 0 && session.remoteAudio?.paused) {
        if (session.quality.samples % 3 === 0) startupMark("call_audio_not_playing", {
          packetsReceived: received, bytesReceived: inbound.bytesReceived || 0,
          totalAudioEnergy: inbound.totalAudioEnergy || 0,
          trackMuted: session.remoteStream?.getAudioTracks?.()[0]?.muted ?? false,
          failures: session.audioFailures,
        });
        scheduleAudioRetry(session, "incoming_rtp_but_paused");
      }
    } catch { /* stats unavailable this round */ }
  }, STATS_INTERVAL_MS);
}

function signalCallNotification(type: "INCOMING_RINGTONE_START" | "INCOMING_RINGTONE_BLOCKED" | "INCOMING_RINGTONE_PLAYING" | "CLOSE_CALL_NOTIFICATION", callId: string) {
  try { navigator.serviceWorker?.controller?.postMessage({ type, callId }); } catch { /* best effort */ }
}
function closeCallNotification(callId: string) {
  signalCallNotification("CLOSE_CALL_NOTIFICATION", callId);
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
  const store = useCallStore();
  if (kind === "ring") store.ringtoneBlocked = false;
  // Android: vibrate with the ring (iOS web has no vibration).
  let vibration: ReturnType<typeof setInterval> | null = null;
  if (kind === "ring" && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    navigator.vibrate([400, 200, 400]);
    vibration = setInterval(() => navigator.vibrate?.([400, 200, 400]), 2_000);
  }
  // Preferred: the <audio> element primed by an earlier tap (works in the
  // standalone PWA, where Web Audio may stay silent after backgrounding).
  const first = ringtoneElement(kind);
  // Incoming ringtones own a playback session until capture starts. Ringback
  // must never replace the active microphone's play-and-record session.
  const ownsPlaybackSession = kind === "ring" && !session.localStream;
  if (ownsPlaybackSession) setRingAudioSession(true);
  if (!first) {
    startWebAudioTone(session, kind, vibration);
    return;
  }
  const play = (element: HTMLAudioElement, attempt: number) => {
    element.currentTime = 0;
    element.muted = false;
    let playing: Promise<void>;
    try { playing = Promise.resolve(element.play()); }
    catch (error) { playing = Promise.reject(error); }
    const handle = { stop() {
      element.pause();
      element.currentTime = 0;
      if (ownsPlaybackSession) setRingAudioSession(false);
      if (vibration) { clearInterval(vibration); navigator.vibrate?.(0); }
    } };
    session.ringtone = handle;
    void playing.then(
      () => {
        if (session.ringtone === handle && isCurrent(session)) {
          startupMark("call_ring_audio", { kind, via: "element", attempt, primed: incomingRingtoneArmed() });
          startupMark("ring_autoplay_result", { callId: session.id, kind, result: "played", primed: incomingRingtoneArmed() });
          if (kind === "ring") signalCallNotification("INCOMING_RINGTONE_PLAYING", session.id);
        }
      },
      error => {
        const name = error instanceof Error ? error.name : "unknown";
        startupMark("call_ring_audio_failed", {
          kind, via: "element", attempt, error: name,
          mediaError: element.error?.code ?? 0, primed: incomingRingtoneArmed(),
        });
        if (session.ringtone !== handle || !isCurrent(session)) return;
        startupMark("ring_autoplay_result", { callId: session.id, kind, result: "rejected", error: name, primed: incomingRingtoneArmed() });
        // Gesture-less autoplay denial cannot be fixed by another synthetic
        // oscillator; rely on the incoming-call UI / system push notification.
        if (name === "NotAllowedError") {
          startupMark("call_ring_requires_interaction", { kind, primed: incomingRingtoneArmed() });
          // Keep the incoming banner and expose a one-tap retry. A timer
          // or fresh AudioContext cannot manufacture an iOS user activation.
          if (kind === "ring") {
            store.ringtoneBlocked = true;
            // Foreground push notifications are intentionally silent/closed.
            // Ask the service worker for an OS alert ONLY if audio was denied.
            signalCallNotification("INCOMING_RINGTONE_BLOCKED", session.id);
            startupMark("ring_fallback_result", { callId: session.id, result: "os_alert_requested" });
          }
          stopTone(session);
          return;
        }
        // Retry an unsupported blob source once, then use Web Audio fallback.
        const retry = name === "NotSupportedError" && attempt === 1 ? reloadRingtoneElement(kind) : null;
        if (retry) play(retry, 2);
        else {
          if (ownsPlaybackSession) setRingAudioSession(false);
          startWebAudioTone(session, kind, vibration);
        }
      },
    );
  };
  play(first, 1);
}

function startWebAudioTone(session: CallSession, kind: "ring" | "ringback", vibration: ReturnType<typeof setInterval> | null) {
  try {
    // Fallback is deliberately demand-driven. It may be suspended on iOS
    // without activation; do not pretend a running context proves audibility.
    const Context = (window as any).AudioContext || (window as any).webkitAudioContext;
    const context: AudioContext | null = Context ? new Context() : null;
    if (!context) throw new Error("no_audio");
    // Do not replace a live call\u0027s play-and-record session with playback.
    const ownsRingingSession = !session.localStream;
    if (ownsRingingSession) setRingAudioSession(true);
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
      if (ownsRingingSession) setRingAudioSession(false);
      void context.close().catch(() => undefined);
    } };
    if (context.state !== "running") startupMark("call_ring_audio_locked", { kind, state: context.state });
    else startupMark("call_ring_audio", { kind, via: "webaudio" });
  } catch {
    session.ringtone = vibration ? { stop() { clearInterval(vibration!); navigator.vibrate?.(0); } } : null;
  }
}

function stopTone(session: CallSession) {
  session.ringtone?.stop();
  session.ringtone = null;
}

/** Must run directly in the ringtone retry button's trusted click event. */
export function retryIncomingRingtone() {
  const session = activeSession;
  const store = useCallStore();
  if (!session || !isCurrent(session) || session.direction !== "incoming" || store.phase !== "incoming" || !store.ringtoneBlocked) return;
  startupMark("call_ring_manual_retry", { primed: incomingRingtoneArmed() });
  startTone(session, "ring");
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


type RoutedAudio = HTMLAudioElement & {
  sinkId?: string;
  setSinkId?: (deviceId: string) => Promise<void>;
};

type BrowserCallAudioSession = {
  type: string;
  state?: string;
  addEventListener?: (name: string, listener: EventListener) => void;
  removeEventListener?: (name: string, listener: EventListener) => void;
};
function browserCallAudioSession(): BrowserCallAudioSession | undefined {
  return (navigator as Navigator & { audioSession?: BrowserCallAudioSession }).audioSession;
}
function setCallAudioSession(session: CallSession, type: "auto" | "play-and-record", reason: string) {
  // Cleanup for a previous call may complete after the next call starts.
  if (type === "auto" ? activeSession !== null : !isCurrent(session)) return;
  const native = browserCallAudioSession();
  if (!native) return;
  try {
    const previous = native.type;
    // Reassert only when needed: flipping a healthy iOS call's audio category
    // can move playback between the receiver and speaker.
    if (previous !== type) native.type = type;
    startupMark("call_audio_session", { previous, type: native.type, changed: previous !== type, state: native.state || "unknown", reason });
  } catch (error) {
    debugLog("system", "call_audio_session_failed", { name: error instanceof Error ? error.name : "unknown", reason }, "warn");
  }
}
function clearAudioRetry(session: CallSession) {
  if (session.audioRetryTimer) clearTimeout(session.audioRetryTimer);
  session.audioRetryTimer = null;
}
function scheduleAudioRetry(session: CallSession, reason: string) {
  if (!isCurrent(session) || !session.remoteStream || session.audioRetryTimer || session.audioFailures >= 3) return;
  const delay = [300, 900, 2_000][Math.max(0, session.audioFailures - 1)];
  session.audioRetryTimer = setTimeout(() => {
    session.audioRetryTimer = null;
    if (isCurrent(session)) attemptRemotePlayback(session, reason);
  }, delay);
}
function attemptRemotePlayback(session: CallSession, reason: string, reset = false) {
  const audio = session.remoteAudio;
  const stream = session.remoteStream;
  if (!audio || !stream || !isCurrent(session)) return;
  if (reset) {
    clearAudioRetry(session);
    session.audioFailures = 0;
    // Rebinding is reserved for foreground/session recovery or an explicit tap;
    // it must not continually interrupt a healthy WebRTC media stream.
    if (audio.srcObject === stream) {
      audio.srcObject = null;
      audio.srcObject = stream;
    }
  } else if (session.audioFailures >= 3) return;
  setCallAudioSession(session, "play-and-record", reason);
  audio.muted = false;
  audio.volume = 1;
  const request = ++session.playRequest;
  const store = useCallStore();
  store.audioStatus = "waiting";
  let playing: Promise<void>;
  try { playing = Promise.resolve(audio.play()); }
  catch (error) { playing = Promise.reject(error); }
  void playing.then(() => {
    if (!isCurrent(session) || session.playRequest !== request) return;
    clearAudioRetry(session);
    session.audioFailures = 0;
    store.audioStatus = "playing";
    startupMark("call_remote_audio_playing", { reason });
  }, error => {
    if (!isCurrent(session) || session.playRequest !== request) return;
    const name = error instanceof Error ? error.name : "unknown";
    session.audioFailures++;
    store.audioStatus = "blocked";
    startupMark("call_remote_audio_failed", { name, reason, attempt: session.audioFailures, mediaError: audio.error?.code ?? 0 });
    // Autoplay policy failures require a new user gesture, not a timer loop.
    if (name !== "NotAllowedError") scheduleAudioRetry(session, "play_rejected");
  });
}
function watchRemoteAudio(session: CallSession, stream: MediaStream, audio: HTMLAudioElement) {
  session.audioCleanup?.();
  const store = useCallStore();
  const playing = () => {
    if (!isCurrent(session)) return;
    clearAudioRetry(session);
    session.audioFailures = 0;
    store.audioStatus = "playing";
  };
  const paused = () => {
    if (!isCurrent(session)) return;
    store.audioStatus = "waiting";
    scheduleAudioRetry(session, "element_paused");
  };
  const failed = () => {
    if (!isCurrent(session)) return;
    store.audioStatus = "blocked";
    startupMark("call_remote_audio_element_error", { code: audio.error?.code ?? 0 });
    scheduleAudioRetry(session, "element_error");
  };
  const trackMuted = () => { if (isCurrent(session)) startupMark("call_remote_track_muted"); };
  const trackUnmuted = () => {
    if (!isCurrent(session)) return;
    // A late unmute often arrives milliseconds after the first stream/play.
    // Rebinding srcObject here aborts WebKit's still-starting audio renderer.
    if (audio.paused || store.audioStatus === "blocked") attemptRemotePlayback(session, "track_unmuted");
  };
  const trackEnded = () => { if (isCurrent(session)) startupMark("call_remote_track_ended"); };
  const foreground = () => {
    if (document.visibilityState !== "visible") return;
    later(session, 250, () => {
      // Returning to the app is not proof that WebKit lost the output track.
      // Unnecessary srcObject rebinding can itself make iOS go silent.
      if (audio.paused || store.audioStatus === "blocked") {
        attemptRemotePlayback(session, "foreground_resume", true);
      } else {
        startupMark("call_audio_foreground_healthy", {
          sessionState: browserCallAudioSession()?.state || "unknown",
          sinkId: (audio as RoutedAudio).sinkId ?? "unsupported",
        });
      }
    });
  };
  let wasInterrupted = false;
  const sessionChanged: EventListener = () => {
    if (!isCurrent(session)) return;
    const state = browserCallAudioSession()?.state;
    startupMark("call_audio_session_state", { state: state || "unknown" });
    if (state === "interrupted") {
      wasInterrupted = true;
      store.audioStatus = "waiting";
    } else if (wasInterrupted && state === "active") {
      // Normal inactive/active transitions must not restart playback endlessly.
      wasInterrupted = false;
      attemptRemotePlayback(session, "session_resumed", audio.paused || store.audioStatus === "blocked");
    }
  };
  // Synchronous capture handler preserves the iOS user activation window.
  const gesture = (event: Event) => {
    // The explicit recovery button handles its own click; avoid double rebinding.
    if ((event.target as Element | null)?.closest?.(".call-button.recover")) return;
    if (isCurrent(session) && (audio.paused || store.audioStatus === "blocked")) {
      attemptRemotePlayback(session, "user_gesture", true);
    }
  };
  const deviceChanged = () => {
    if (!isCurrent(session)) return;
    startupMark("call_audio_device_changed", {
      sinkId: (audio as RoutedAudio).sinkId ?? "unsupported",
      sessionState: browserCallAudioSession()?.state || "unknown",
      selectedOutput: !!session.outputDeviceId,
    });
  };
  const tracks = stream.getAudioTracks?.() || [];
  audio.addEventListener?.("playing", playing);
  audio.addEventListener?.("pause", paused);
  audio.addEventListener?.("error", failed);
  for (const track of tracks) {
    track.addEventListener?.("mute", trackMuted);
    track.addEventListener?.("unmute", trackUnmuted);
    track.addEventListener?.("ended", trackEnded);
  }
  document.addEventListener?.("visibilitychange", foreground);
  window.addEventListener?.("pageshow", foreground);
  window.addEventListener?.("pointerdown", gesture, { capture: true });
  window.addEventListener?.("touchend", gesture, { capture: true });
  browserCallAudioSession()?.addEventListener?.("statechange", sessionChanged);
  navigator.mediaDevices?.addEventListener?.("devicechange", deviceChanged);
  session.audioCleanup = () => {
    audio.removeEventListener?.("playing", playing);
    audio.removeEventListener?.("pause", paused);
    audio.removeEventListener?.("error", failed);
    for (const track of tracks) {
      track.removeEventListener?.("mute", trackMuted);
      track.removeEventListener?.("unmute", trackUnmuted);
      track.removeEventListener?.("ended", trackEnded);
    }
    document.removeEventListener?.("visibilitychange", foreground);
    window.removeEventListener?.("pageshow", foreground);
    window.removeEventListener?.("pointerdown", gesture, { capture: true });
    window.removeEventListener?.("touchend", gesture, { capture: true });
    browserCallAudioSession()?.removeEventListener?.("statechange", sessionChanged);
    navigator.mediaDevices?.removeEventListener?.("devicechange", deviceChanged);
  };
}
function playRemote(session: CallSession, stream: MediaStream, reason = "remote_stream") {
  if (!session.remoteAudio) {
    session.remoteAudio = document.createElement("audio");
    session.remoteAudio.autoplay = true;
    session.remoteAudio.setAttribute("playsinline", "");
    session.remoteAudio.style.display = "none";
    document.body.appendChild(session.remoteAudio);
  }
  session.remoteStream = stream;
  session.audioFailures = 0;
  session.playRequest++;
  clearAudioRetry(session);
  session.remoteAudio.srcObject = stream;
  watchRemoteAudio(session, stream, session.remoteAudio);
  // A browser-selected output is preserved across renderer replacement.
  const selected = session.outputDeviceId;
  const routed = session.remoteAudio as RoutedAudio;
  if (selected && routed.setSinkId) {
    void routed.setSinkId(selected).then(
      () => { if (isCurrent(session)) startupMark("call_audio_output_restored", { selected: true }); },
      error => { if (isCurrent(session)) startupMark("call_audio_output_restore_failed", { name: error instanceof Error ? error.name : "unknown" }); },
    );
  }
  attemptRemotePlayback(session, reason);
}
/**
 * Recover a WebKit audio renderer which reports play() success but stays
 * silent. Replaying the same element is insufficient on some iPhones:
 * recreate only the output element, keeping the live WebRTC transport,
 * microphone, and peer connection untouched. Must run synchronously in
 * the recovery button's user-gesture handler.
 */
export function recoverCallAudio() {
  const session = activeSession;
  if (!session || !isCurrent(session) || !session.remoteStream) return;
  const stream = session.remoteStream;
  const track = stream.getAudioTracks?.()[0];
  startupMark("call_audio_output_recovery", {
    strategy: "replace_element",
    incomingPackets: session.quality.received,
    trackMuted: track?.muted ?? null,
    trackState: track?.readyState ?? "unknown",
    elementPaused: session.remoteAudio?.paused ?? null,
    sinkId: session.remoteAudio ? (session.remoteAudio as RoutedAudio).sinkId ?? "unsupported" : "no_element",
    sessionType: browserCallAudioSession()?.type || "unknown",
    sessionState: browserCallAudioSession()?.state || "unknown",
  });
  session.audioCleanup?.();
  session.audioCleanup = null;
  clearAudioRetry(session);
  session.playRequest++;
  const previous = session.remoteAudio;
  session.remoteAudio = null;
  if (previous) {
    try { previous.pause(); } catch { /* unsupported browser shim */ }
    previous.srcObject = null;
    previous.remove();
  }
  playRemote(session, stream, "manual_recovery");
}

/**
 * Optional native browser output picker. Always invoke selectAudioOutput()
 * directly from the user's click; some iOS builds don't implement it and
 * a fulfilled setSinkId() does not prove the physical route changed.
 */
export async function selectCallOutput() {
  const session = activeSession;
  const media = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: () => Promise<{ deviceId: string }>;
  };
  const picker = media?.selectAudioOutput;
  const output = session?.remoteAudio as RoutedAudio | null;
  if (!session || !isCurrent(session) || !output?.setSinkId || !picker) return;
  try {
    const device = await picker.call(media);
    if (!isCurrent(session) || session.remoteAudio !== output) return;
    await output.setSinkId(device.deviceId);
    if (!isCurrent(session)) return;
    session.outputDeviceId = device.deviceId;
    startupMark("call_audio_output_selected", { selected: true, reportedSinkId: output.sinkId ?? "unsupported" });
  } catch (error) {
    if (isCurrent(session)) startupMark("call_audio_output_select_failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
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
  session.audioCleanup?.();
  session.audioCleanup = null;
  clearAudioRetry(session);
  session.playRequest++;
  session.remoteStream = null;
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
  if (!activeSession) {
    setCallAudioActive(false);
    setCallAudioSession(session, "auto", "call_ended");
  }
  try { await leaving?.leave(); } catch { /* already gone */ }
}

function discardOrphanedSession() {
  const session = activeSession;
  if (!session) return;
  const store = useCallStore();
  if (store.callId === session.id && store.phase !== "idle" && store.phase !== "ended" && account() === session.owner) return;
  activeSession = null;
  closeCallNotification(session.id);
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
  closeCallNotification(session.id);
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
  // Load the small ringback resource only after the user starts a call.
  // Merely loading media is not audio priming; no play() occurs here.
  ringtoneElement("ringback");
  setCallAudioActive(true);
  setCallAudioSession(session, "play-and-record", "call_start");
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
  setCallAudioSession(session, "play-and-record", "microphone_ready");
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
  closeCallNotification(session.id);
  store.phase = "connecting";
  setCallAudioActive(true);
  setCallAudioSession(session, "play-and-record", "call_accept");
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
  setCallAudioSession(session, "play-and-record", "microphone_ready");
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
    // Do not let a tap on the incoming-call banner prime unrelated ringtone
    // media or a Web Audio context just as WebKit starts microphone capture.
    setCallAudioActive(true);
    // Announce this exact call before playback. Stale close messages from
    // a previous call must not hide this call's OS fallback notification.
    signalCallNotification("INCOMING_RINGTONE_START", session.id);
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
