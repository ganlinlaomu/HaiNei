import { describe, expect, it } from "vitest";
import { createNearbyRtcDiagnostics } from "@/services/nearbyRtcDiagnostics";

class FakePeer extends EventTarget {
  connectionState = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  signalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  async addIceCandidate(value?: RTCIceCandidateInit | null) { if (value?.candidate === "bad") throw new Error("invalid candidate"); }
}

describe("nearby RTC diagnostic evidence", () => {
  it("retains failed attempts, SDP stages and candidate counts without SDP or addresses", async () => {
    const diagnostic = createNearbyRtcDiagnostics(FakePeer as unknown as typeof RTCPeerConnection);
    const pc = new diagnostic.PeerConnection() as unknown as FakePeer;
    pc.localDescription = { type: "offer", sdp: "secret local address" };
    await pc.setRemoteDescription({ type: "answer", sdp: "a=candidate:private-address\r\n" });
    pc.dispatchEvent(Object.assign(new Event("icecandidate"), { candidate: { type: "host", candidate: "private-ip" } }));
    await pc.addIceCandidate({ candidate: "remote-ip" });
    await expect(pc.addIceCandidate({ candidate: "bad" })).rejects.toThrow("invalid candidate");
    pc.iceConnectionState = "failed";
    pc.connectionState = "closed";
    pc.dispatchEvent(new Event("connectionstatechange"));
    const [snapshot] = diagnostic.snapshots();
    expect(snapshot).toMatchObject({ localDescription: "offer", remoteDescription: "answer", localCandidates: 1, remoteCandidates: 1, candidateTypes: ["host"], ice: "failed", connection: "closed" });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|remote-ip/);
    snapshot.candidateTypes.push("external modification");
    expect(diagnostic.snapshots()[0].candidateTypes).toEqual(["host"]);
    diagnostic.clear();
    expect(diagnostic.snapshots()).toEqual([]);
  });

  it("bounds the history and records STUN error codes without server messages", () => {
    const diagnostic = createNearbyRtcDiagnostics(FakePeer as unknown as typeof RTCPeerConnection);
    for (let i = 0; i < 20; i++) new diagnostic.PeerConnection();
    const pc = new diagnostic.PeerConnection();
    pc.dispatchEvent(Object.assign(new Event("icecandidateerror"), { errorCode: 701, errorText: "private address", url: "private server" }));
    expect(diagnostic.snapshots()).toHaveLength(12);
    expect(diagnostic.snapshots().at(-1)?.iceErrors).toEqual([701]);
    expect(JSON.stringify(diagnostic.snapshots())).not.toContain("private");
  });
});
