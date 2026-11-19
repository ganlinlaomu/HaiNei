import { debugLog, startupMark } from "@/utils/debugLog";

/**
 * Video for one-to-one calls, layered on an already working voice call.
 *
 * The voice path (microphone acquisition, the offer-ordering gate, remote
 * audio playback) is not touched: the camera is its own video-only stream,
 * added only after audio is connected and only when both sides have agreed
 * inside the call room. An older client never sends that agreement, so it
 * never receives video and its call is an ordinary voice call.
 *
 * In-room handshake (Trystero action "video"):
 *   callee -> caller  { t: "want" }   the callee answered with video
 *   callee -> caller  { t: "voice" }  the callee answered a video invite by voice
 *   caller -> callee  { t: "go" }     the caller added (or has no) camera
 *   either            { t: "camera", on } camera switched off / on
 * Both sides add their camera only once the connection is stable, the caller
 * first, so the two video offers never collide.
 *
 * Each side sends on its own sendonly transceiver (addTransceiver never
 * reuses the peer's receiving one, unlike addTrack). The receiving
 * transceiver then never changes direction: on some iPhones a remote video
 * track whose transceiver turned sendrecv stayed muted forever (black video)
 * while frames were decoding. Video is received from the connection's own
 * track events, not Trystero's stream metadata.
 */
export const CAMERA_STREAM_KIND = "hainei-camera";
/** Roughly 480p at 24 fps; keeps relayed (TURN) calls cheap. */
export const VIDEO_MAX_BITRATE = 600_000;
export const VIDEO_MAX_FRAMERATE = 24;
/** An older callee never answers the handshake; the call stays voice. */
export const VIDEO_CONSENT_TIMEOUT_MS = 5_000;

type Room = import("trystero").Room;
type VideoMessage = { t: "want" } | { t: "voice" } | { t: "go" } | { t: "camera"; on: boolean };

export function isCameraStream(stream: MediaStream, metadata?: unknown) {
  if ((metadata as { kind?: unknown } | undefined)?.kind === CAMERA_STREAM_KIND) return true;
  // A video-only stream is never microphone audio, whoever sent it.
  return (stream.getAudioTracks?.().length ?? 0) === 0 && (stream.getVideoTracks?.().length ?? 0) > 0;
}

export function getCamera(facing: "user" | "environment" = "user") {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: VIDEO_MAX_FRAMERATE, max: VIDEO_MAX_FRAMERATE },
    },
  });
}

async function capBitrate(sender: RTCRtpSender | null) {
  if (!sender?.getParameters || !sender.setParameters) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
    params.encodings[0].maxFramerate = VIDEO_MAX_FRAMERATE;
    await sender.setParameters(params);
  } catch (error) {
    debugLog("system", "call_video_bitrate_failed", { name: error instanceof Error ? error.name : "unknown" }, "warn");
  }
}

/** Recognise video RTP records, including WebKit's untyped ones (by codec). */
export function isVideoRtp(entry: any, report: any) {
  return entry?.kind === "video" || entry?.mediaType === "video"
    || String(report?.get?.(entry?.codecId)?.mimeType || "").toLowerCase().startsWith("video/");
}

/**
 * The track to render for the peer's video. iPhone WebKit can hand the page
 * a stream whose track stays muted forever while the receiver decodes frames
 * on its own track (the same bug the voice path corrects for audio). Prefer
 * the receiver track the stats report as decoding, then any unmuted one.
 */
export function pickRemoteVideoTrack(
  streamTrack: MediaStreamTrack | undefined,
  receivers: RTCRtpReceiver[] | undefined,
  decodingTrackId?: string,
) {
  const live = (receivers || []).map(receiver => receiver.track)
    .filter((track): track is MediaStreamTrack => !!track && track.kind === "video" && track.readyState === "live");
  if (decodingTrackId) {
    const decoding = live.find(track => track.id === decodingTrackId);
    if (decoding) return decoding;
  }
  if (streamTrack && streamTrack.readyState === "live" && !streamTrack.muted) return streamTrack;
  return live.find(track => !track.muted) || (streamTrack?.readyState === "live" ? streamTrack : live[0]);
}

/** The inbound video RTP record (kept internal: its ids are never logged). */
export function inboundVideo(report: any) {
  let inbound: any = null;
  report.forEach((entry: any) => { if (entry.type === "inbound-rtp" && isVideoRtp(entry, report)) inbound = entry; });
  return inbound;
}

/** Frame counters for one video call sample; no SSRCs, device or peer details. */
export function videoStats(report: any) {
  let inbound: any = null;
  let outbound: any = null;
  report.forEach((entry: any) => {
    if (entry.type === "inbound-rtp" && isVideoRtp(entry, report)) inbound = entry;
    if (entry.type === "outbound-rtp" && isVideoRtp(entry, report)) outbound = entry;
  });
  return {
    framesReceived: inbound?.framesReceived ?? null,
    framesDecoded: inbound?.framesDecoded ?? null,
    packetsReceived: inbound?.packetsReceived ?? null,
    frameWidth: inbound?.frameWidth ?? null,
    framesEncoded: outbound?.framesEncoded ?? null,
    framesSent: outbound?.framesSent ?? null,
    packetsSent: outbound?.packetsSent ?? null,
    qualityLimitation: outbound?.qualityLimitationReason ?? null,
  };
}

/**
 * Watch the local camera track. iOS interrupts capture (track.muted, black
 * frames) when the audio session changes, e.g. as the ringback starts; it
 * also ends the track in the background. Either way `restart` replaces it.
 */
export function watchCameraTrack(track: MediaStreamTrack, restart: (reason: "interrupted" | "ended") => void, isVisible = () => document.visibilityState === "visible") {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onMute = () => {
    startupMark("call_camera_muted", { state: track.readyState });
    if (timer) clearTimeout(timer);
    // A brief interruption recovers by itself; only a lasting one is restarted.
    timer = setTimeout(() => {
      timer = null;
      if (track.muted && track.readyState === "live" && isVisible()) restart("interrupted");
    }, 800);
  };
  const onUnmute = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    startupMark("call_camera_unmuted", {});
  };
  const onEnded = () => {
    startupMark("call_camera_ended", {});
    if (isVisible()) restart("ended");
  };
  track.addEventListener("mute", onMute);
  track.addEventListener("unmute", onUnmute);
  track.addEventListener("ended", onEnded);
  return () => {
    if (timer) clearTimeout(timer);
    track.removeEventListener("mute", onMute);
    track.removeEventListener("unmute", onUnmute);
    track.removeEventListener("ended", onEnded);
  };
}

export type VideoLink = ReturnType<typeof createVideoLink>;

export function createVideoLink(options: {
  room: Room;
  direction: "incoming" | "outgoing";
  /** This call's current media peer, or "". */
  peer: () => string;
  /** The session is still current. */
  active: () => boolean;
  /** Audio is connected (phase "active"). */
  audioConnected: () => boolean;
  camera: () => MediaStream | null;
  /** Callee: answered with video (else it tells the caller "voice"). */
  wantVideo: () => boolean;
  onRemoteVideo: (stream: MediaStream) => void;
  onRemoteCamera: (on: boolean) => void;
  /** Caller: the callee will not do video; turn this call into voice. */
  onVoiceOnly: () => void;
  /** Replace an interrupted or ended camera before it is sent. */
  ensureCamera?: () => Promise<void>;
}) {
  const { room, direction } = options;
  let linkedPeer = "";
  let peerWantsVideo = false;
  let callerWent = false;
  let attached = false;
  let waiting: { pc: RTCPeerConnection; listener: () => void } | null = null;
  let consentTimer: ReturnType<typeof setTimeout> | null = null;
  let voiceOnly = false;
  let sender: RTCRtpSender | null = null;
  let remoteTrackId = "";
  let listening: { pc: RTCPeerConnection; listener: (event: RTCTrackEvent) => void } | null = null;
  const clearConsentTimer = () => {
    if (consentTimer) clearTimeout(consentTimer);
    consentTimer = null;
  };
  const becomeVoiceOnly = () => {
    if (voiceOnly || direction !== "outgoing") return;
    voiceOnly = true;
    clearConsentTimer();
    stopWaiting();
    startupMark("call_video_declined", {});
    options.onVoiceOnly();
  };

  const action = room.makeAction<VideoMessage>("video", {
    onMessage: (message, { peerId }) => {
      if (!options.active() || peerId !== options.peer() || !message || typeof message !== "object") return;
      if (message.t === "want" && direction === "outgoing") {
        if (voiceOnly) return;
        peerWantsVideo = true;
        clearConsentTimer();
        tryAttach();
      } else if (message.t === "voice" && direction === "outgoing") {
        becomeVoiceOnly();
      } else if (message.t === "go" && direction === "incoming") {
        callerWent = true;
        tryAttach();
      } else if (message.t === "camera" && typeof message.on === "boolean") {
        options.onRemoteCamera(message.on);
      }
    },
  });
  const send = (message: VideoMessage) => {
    const peer = options.peer();
    if (peer) void action.send(message, { target: peer }).catch(() => undefined);
  };

  const stopWaiting = () => {
    waiting?.pc.removeEventListener("signalingstatechange", waiting.listener);
    waiting = null;
  };

  function receiveTrack(track: MediaStreamTrack | undefined) {
    if (!track || track.kind !== "video" || voiceOnly || !options.active()) return;
    if (track.id === remoteTrackId) return;
    remoteTrackId = track.id;
    options.onRemoteVideo(new MediaStream([track]));
    if (direction === "incoming") {
      // Seeing the caller's video is as good as its "go".
      callerWent = true;
      tryAttach();
    }
  }

  /** Receive video straight from the connection (audio is left to Trystero). */
  function listen(pc: RTCPeerConnection | undefined) {
    if (!pc || listening?.pc === pc) return;
    stopListening();
    const listener = (event: RTCTrackEvent) => receiveTrack(event.track);
    pc.addEventListener("track", listener as EventListener);
    listening = { pc, listener };
    // A video track that arrived before we listened (fast peers).
    for (const transceiver of pc.getTransceivers?.() || []) {
      const track = transceiver.receiver?.track;
      if (track?.kind === "video" && track.readyState === "live" && /recv/.test(transceiver.currentDirection || "")) receiveTrack(track);
    }
  }
  function stopListening() {
    listening?.pc.removeEventListener("track", listening.listener as EventListener);
    listening = null;
  }

  function tryAttach() {
    const peer = options.peer();
    if (attached || voiceOnly || !peer || !options.active() || !options.audioConnected()) return;
    if (direction === "outgoing" ? !peerWantsVideo : !callerWent) return;
    const pc = room.getPeers()[peer];
    if (!pc || pc.signalingState === "closed") return;
    listen(pc);
    if (pc.signalingState !== "stable") {
      // Never start the video offer while the audio negotiation is open.
      if (!waiting) {
        const listener = () => tryAttach();
        waiting = { pc, listener };
        pc.addEventListener("signalingstatechange", listener);
      }
      return;
    }
    stopWaiting();
    attached = true;
    void (async () => {
      // An interrupted camera would only send black frames: replace it first.
      try { await options.ensureCamera?.(); } catch { /* attach what there is */ }
      if (!options.active() || options.peer() !== peer) return;
      const camera = options.camera();
      const track = camera?.getVideoTracks()[0];
      const current = room.getPeers()[peer];
      if (camera && track && current && current.signalingState !== "closed") {
        startupMark("call_video_attaching", { direction, muted: track.muted, enabled: track.enabled, state: track.readyState });
        try {
          sender = current.addTransceiver(track, { direction: "sendonly", streams: [camera] }).sender;
          // Encodings exist once the offer/answer has settled.
          const capOnStable = () => {
            if (current.signalingState !== "stable") return;
            current.removeEventListener("signalingstatechange", capOnStable);
            void capBitrate(sender);
          };
          current.addEventListener("signalingstatechange", capOnStable);
        } catch (error) {
          debugLog("system", "call_video_send_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }, "warn");
        }
        send({ t: "camera", on: track.enabled });
      }
      // The callee waits for this before adding its own camera.
      if (direction === "outgoing") send({ t: "go" });
    })();
  }

  return {
    /** The media peer (re)joined: a reconnect starts the handshake over. */
    joined(peer: string) {
      if (peer !== linkedPeer) {
        stopWaiting();
        linkedPeer = peer;
        peerWantsVideo = false;
        callerWent = false;
        attached = false;
        sender = null;
        remoteTrackId = "";
      }
      listen(room.getPeers()[peer]);
      if (direction === "incoming") send(options.wantVideo() ? { t: "want" } : { t: "voice" });
    },
    /** Audio just connected. */
    audioReady() {
      if (direction === "outgoing" && !peerWantsVideo && !voiceOnly && !consentTimer) {
        consentTimer = setTimeout(() => {
          consentTimer = null;
          if (options.active() && !peerWantsVideo) becomeVoiceOnly();
        }, VIDEO_CONSENT_TIMEOUT_MS);
      }
      tryAttach();
    },
    /** Video from a peer that still sends through Trystero (0.1.210-0.1.211). */
    remoteStream(stream: MediaStream) {
      receiveTrack(stream.getVideoTracks()[0]);
    },
    setCameraOn(on: boolean) {
      for (const track of options.camera()?.getVideoTracks() || []) track.enabled = on;
      if (attached) send({ t: "camera", on });
    },
    /** Swap the camera track in place (flip, or a camera iOS stopped). */
    async replaceCamera(_oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack) {
      if (!attached || !sender) return;
      await sender.replaceTrack(newTrack);
      await capBitrate(sender);
    },
    close() {
      stopWaiting();
      stopListening();
      clearConsentTimer();
    },
  };
}
