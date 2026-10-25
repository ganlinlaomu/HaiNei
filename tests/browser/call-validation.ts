// Exercise the installed Trystero peer implementation with real browser RTP.
// Both WebRTC initiator roles must work independently of who dialled the call.
import createPeer from "../../node_modules/@trystero-p2p/core/dist/peer.mjs";
import { createCallMediaGate } from "../../src/services/callMedia";

export async function validateCallMedia() {
  for (const callerInitiates of [true, false]) {
    const context = new AudioContext();
    await context.resume();
    const sources = [440, 660].map(frequency => {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination);
      oscillator.start();
      return { oscillator, stream: destination.stream };
    });
    // Loopback is deliberate: no relay, STUN server or mDNS service is needed
    // for two test peers within the same browser/network namespace.
    const config = { rtcConfig: { iceServers: [] }, _test_only_mdnsHostFallbackToLoopback: true };
    const peers = [createPeer(callerInitiates, config), createPeer(!callerInitiates, config)];
    const errors: Error[] = [];
    let active = true;
    const outputs: HTMLAudioElement[] = [];
    const gates = peers.map((peer, index) => createCallMediaGate({
      direction: index === 0 ? "outgoing" : "incoming",
      current: () => active,
      connection: () => peer.connection,
      attach: () => peer.addStream(sources[index].stream),
    }));
    peers.forEach((peer, index) => peer.setHandlers({
      signal: signal => { void peers[1 - index].signal(signal); },
      connect: () => gates[index].joined("other"),
      stream: stream => {
        gates[index].received("other");
        const audio = document.createElement("audio");
        audio.srcObject = stream;
        document.body.appendChild(audio);
        outputs.push(audio);
        void audio.play().catch(error => errors.push(error));
      },
      error: error => errors.push(error),
    }));
    try {
      const deadline = performance.now() + 10_000;
      let verified = false;
      while (performance.now() < deadline) {
        if (errors.length) throw errors[0];
        const checks = await Promise.all(peers.map(async peer => {
          const report = await peer.connection.getStats();
          const stats = [...report.values()];
          return stats.some(s => s.type === "outbound-rtp" && s.packetsSent > 10)
            && stats.some(s => s.type === "inbound-rtp" && s.packetsReceived > 10 && s.totalAudioEnergy > 0)
            && peer.connection.getTransceivers().some(t => t.currentDirection === "sendrecv" && !t.receiver.track.muted);
        }));
        if (checks.every(Boolean)) { verified = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!verified) throw new Error(`voice RTP did not become bidirectional (callerInitiates=${callerInitiates}): ` + JSON.stringify(
        peers.map(peer => ({ connection: peer.connection.connectionState, signaling: peer.connection.signalingState,
          directions: peer.connection.getTransceivers().map(t => ({ desired: t.direction, negotiated: t.currentDirection })) })),
      ));
    } finally {
      active = false;
      gates.forEach(gate => gate.clear());
      peers.forEach(peer => peer.destroy());
      outputs.forEach(audio => { audio.pause(); audio.srcObject = null; audio.remove(); });
      sources.forEach(({ oscillator, stream }) => { oscillator.stop(); stream.getTracks().forEach(track => track.stop()); });
      await context.close();
    }
  }
}
