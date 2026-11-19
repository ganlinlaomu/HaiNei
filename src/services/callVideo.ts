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

async function capBitrate(pc: RTCPeerConnection | undefined, track: MediaStreamTrack) {
  const sender = pc?.getSenders?.().find(item => item.track === track);
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
}) {
  const { room, direction } = options;
  let linkedPeer = "";
  let peerWantsVideo = false;
  let callerWent = false;
  let attached = false;
  let waiting: { pc: RTCPeerConnection; listener: () => void } | null = null;
  let consentTimer: ReturnType<typeof setTimeout> | null = null;
  let voiceOnly = false;
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

  function tryAttach() {
    const peer = options.peer();
    if (attached || voiceOnly || !peer || !options.active() || !options.audioConnected()) return;
    if (direction === "outgoing" ? !peerWantsVideo : !callerWent) return;
    const pc = room.getPeers()[peer];
    if (!pc || pc.signalingState === "closed") return;
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
    const camera = options.camera();
    const track = camera?.getVideoTracks()[0];
    if (camera && track) {
      startupMark("call_video_attaching", { direction });
      for (const sending of room.addStream(camera, { target: peer, metadata: { kind: CAMERA_STREAM_KIND } })) {
        void sending.then(() => capBitrate(room.getPeers()[peer], track)).catch(error => {
          debugLog("system", "call_video_send_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" }, "warn");
        });
      }
      send({ t: "camera", on: track.enabled });
    }
    // The callee waits for this before adding its own camera.
    if (direction === "outgoing") send({ t: "go" });
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
      }
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
    remoteStream(stream: MediaStream) {
      if (voiceOnly) return;
      options.onRemoteVideo(stream);
      if (direction === "incoming") {
        // Seeing the caller's video is as good as its "go".
        callerWent = true;
        tryAttach();
      }
    },
    setCameraOn(on: boolean) {
      for (const track of options.camera()?.getVideoTracks() || []) track.enabled = on;
      if (attached) send({ t: "camera", on });
    },
    /** Swap the camera track in place (flip, or a camera iOS stopped). */
    async replaceCamera(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack) {
      const peer = options.peer();
      if (!attached || !peer) return;
      await Promise.all(room.replaceTrack(oldTrack, newTrack, { target: peer }));
      await capBitrate(room.getPeers()[peer], newTrack);
    },
    close() {
      stopWaiting();
      clearConsentTimer();
    },
  };
}
