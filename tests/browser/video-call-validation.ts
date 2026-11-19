// Real browser RTP: a voice call, then video added in the order the app uses
// (caller first, callee after, each only on a stable connection). The voice
// RTP must keep flowing in both directions while and after video is added.
import createPeer from "../../node_modules/@trystero-p2p/core/dist/peer.mjs";
import { createCallMediaGate } from "../../src/services/callMedia";

function canvasCamera(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const timer = setInterval(() => {
    frame += 1;
    context.fillStyle = color;
    context.fillRect(0, 0, 320, 240);
    context.fillStyle = "#fff";
    context.fillRect((frame * 7) % 320, 100, 40, 40);
  }, 40);
  const stream = canvas.captureStream(24);
  return { stream, stop: () => { clearInterval(timer); stream.getTracks().forEach(track => track.stop()); } };
}

async function audioStats(pc: RTCPeerConnection) {
  const stats = [...(await pc.getStats()).values()];
  const inbound = stats.find(s => s.type === "inbound-rtp" && s.kind === "audio");
  const outbound = stats.find(s => s.type === "outbound-rtp" && s.kind === "audio");
  return { received: inbound?.packetsReceived || 0, energy: inbound?.totalAudioEnergy || 0, sent: outbound?.packetsSent || 0 };
}
async function videoFrames(pc: RTCPeerConnection) {
  const stats = [...(await pc.getStats()).values()];
  return stats.find(s => s.type === "inbound-rtp" && s.kind === "video")?.framesDecoded || 0;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}
function whenStable(pc: RTCPeerConnection) {
  return pc.signalingState === "stable" ? Promise.resolve() : new Promise<void>(resolve => {
    const listener = () => { if (pc.signalingState === "stable") { pc.removeEventListener("signalingstatechange", listener); resolve(); } };
    pc.addEventListener("signalingstatechange", listener);
  });
}

export async function validateVideoCallMedia() {
  for (const callerInitiates of [true, false]) {
    const context = new AudioContext();
    await context.resume();
    const voices = [440, 660].map(frequency => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return { oscillator, stream: destination.stream };
    });
    const cameras = [canvasCamera("#1d4ed8"), canvasCamera("#15803d")];
    const config = { rtcConfig: { iceServers: [] }, _test_only_mdnsHostFallbackToLoopback: true };
    const peers = [createPeer(callerInitiates, config), createPeer(!callerInitiates, config)];
    const errors: Error[] = [];
    let active = true;
    const audioOutputs: HTMLAudioElement[] = [];
    const remoteVideo: Array<MediaStream | null> = [null, null];
    const gates = peers.map((peer, index) => createCallMediaGate({
      direction: index === 0 ? "outgoing" : "incoming",
      current: () => active,
      connection: () => peer.connection,
      attach: () => peer.addStream(voices[index].stream),
    }));
    peers.forEach((peer, index) => peer.setHandlers({
      signal: signal => { void peers[1 - index].signal(signal); },
      connect: () => gates[index].joined("other"),
      stream: stream => {
        if (stream.getAudioTracks().length === 0) {
          // Camera: never routed to an audio element.
          remoteVideo[index] = stream;
          return;
        }
        gates[index].received("other");
        const audio = document.createElement("audio");
        audio.srcObject = stream;
        document.body.appendChild(audio);
        audioOutputs.push(audio);
        void audio.play().catch(error => errors.push(error));
      },
      error: error => errors.push(error),
    }));
    try {
      const pcs = peers.map(peer => peer.connection as RTCPeerConnection);
      await until(async () => {
        if (errors.length) throw errors[0];
        const stats = await Promise.all(pcs.map(audioStats));
        return stats.every(s => s.sent > 10 && s.received > 10 && s.energy > 0);
      }, `voice before video (callerInitiates=${callerInitiates})`);
      const beforeVideo = await Promise.all(pcs.map(audioStats));

      // Caller adds its camera on a stable connection, then the callee does.
      await whenStable(pcs[0]);
      peers[0].addStream(cameras[0].stream);
      await until(async () => !!remoteVideo[1], "callee receives caller video");
      await whenStable(pcs[1]);
      peers[1].addStream(cameras[1].stream);

      await until(async () => {
        if (errors.length) throw errors[0];
        const frames = await Promise.all(pcs.map(videoFrames));
        return frames.every(count => count > 10);
      }, `video both ways (callerInitiates=${callerInitiates})`);
      // Voice kept flowing after video joined, in both directions.
      await sleep(600);
      const afterVideo = await Promise.all(pcs.map(audioStats));
      afterVideo.forEach((after, index) => {
        if (after.received <= beforeVideo[index].received + 10 || after.energy <= beforeVideo[index].energy) {
          throw new Error(`voice stalled after video was added on peer ${index}: ` + JSON.stringify({ before: beforeVideo[index], after }));
        }
      });
      for (const pc of pcs) {
        const audioTransceivers = pc.getTransceivers().filter(t => t.receiver.track?.kind === "audio");
        if (!audioTransceivers.some(t => t.currentDirection === "sendrecv")) {
          throw new Error("audio transceiver is no longer sendrecv after video: " + JSON.stringify(audioTransceivers.map(t => t.currentDirection)));
        }
      }
      if (audioOutputs.some(audio => (audio.srcObject as MediaStream).getVideoTracks().length > 0)) {
        throw new Error("a camera track reached an audio element");
      }
    } finally {
      active = false;
      gates.forEach(gate => gate.clear());
      peers.forEach(peer => peer.destroy());
      audioOutputs.forEach(audio => { audio.pause(); audio.srcObject = null; audio.remove(); });
      voices.forEach(({ oscillator, stream }) => { oscillator.stop(); stream.getTracks().forEach(track => track.stop()); });
      cameras.forEach(camera => camera.stop());
      await context.close();
    }
  }
}
