/** Serialize the two audio offers instead of adding both microphones at once.
 * Trystero's data channel connects before the audio tracks are negotiated.
 * The caller sends first; the callee waits for that offer's answer to become
 * stable before adding its microphone. In particular, ontrack alone is too
 * early: it fires while setRemoteDescription(offer) is still being applied.
 */
export function createCallMediaGate(options: {
  direction: "incoming" | "outgoing";
  current: () => boolean;
  connection: (peer: string) => RTCPeerConnection | undefined;
  attach: (peer: string) => void;
}) {
  const peers = new Map<string, {
    remoteReady: boolean;
    attached: boolean;
    waiting: RTCPeerConnection | null;
    listener: (() => void) | null;
  }>();
  const forget = (peer: string) => {
    const state = peers.get(peer);
    if (state?.listener) state.waiting?.removeEventListener("signalingstatechange", state.listener);
    peers.delete(peer);
  };
  const send = (peer: string, remoteReady = false) => {
    if (!options.current()) return;
    let state = peers.get(peer);
    if (!state) {
      state = { remoteReady: false, attached: false, waiting: null, listener: null };
      peers.set(peer, state);
    }
    state.remoteReady ||= remoteReady;
    if (state.attached || (options.direction === "incoming" && !state.remoteReady)) return;
    const pc = options.connection(peer);
    if (options.direction === "incoming") {
      if (!pc || pc.signalingState === "closed") return;
      if (pc.signalingState !== "stable") {
        if (!state.listener) {
          state.waiting = pc;
          state.listener = () => send(peer);
          pc.addEventListener("signalingstatechange", state.listener);
        }
        return;
      }
    }
    if (state.listener) state.waiting?.removeEventListener("signalingstatechange", state.listener);
    state.listener = null;
    state.waiting = null;
    state.attached = true;
    options.attach(peer);
  };
  return {
    joined: (peer: string) => send(peer),
    received: (peer: string) => send(peer, true),
    forget,
    clear: () => { for (const peer of peers.keys()) forget(peer); },
  };
}

/** Log state, never microphone contents, SDP, device labels or track IDs. */
export function callMediaState(pc: RTCPeerConnection, localStream: MediaStream | null) {
  const localTracks = localStream?.getAudioTracks?.() || [];
  return {
    signalingState: pc.signalingState || "unknown",
    localTracks: localTracks.map(track => ({ muted: track.muted, enabled: track.enabled, state: track.readyState })),
    transceivers: (pc.getTransceivers?.() || []).filter(t =>
      t.sender.track?.kind === "audio" || t.receiver.track?.kind === "audio",
    ).map(t => ({
      direction: t.direction, currentDirection: t.currentDirection,
      senderPresent: !!t.sender.track,
      senderIsMicrophone: !!t.sender.track && localTracks.includes(t.sender.track),
      senderState: t.sender.track?.readyState ?? null,
      senderMuted: t.sender.track?.muted ?? null,
      senderEnabled: t.sender.track?.enabled ?? null,
      receiverMuted: t.receiver.track?.muted ?? null,
      receiverState: t.receiver.track?.readyState ?? null,
    })),
  };
}
