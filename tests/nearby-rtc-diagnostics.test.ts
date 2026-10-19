import { describe, expect, it } from "vitest";
import { createNearbyRtcDiagnostics } from "@/services/nearbyRtcDiagnostics";
import { connectionRoute } from "@/services/nearbyTransfer";

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

describe("connection route", () => {
  const report = (entries: Record<string, Record<string, unknown>>) => ({ getStats: async () => new Map(Object.entries(entries)) as unknown as RTCStatsReport });
  const viaTransport = (local: Record<string, unknown>, remote: Record<string, unknown>) => report({
    t: { type: "transport", selectedCandidatePairId: "p" },
    p: { type: "candidate-pair", localCandidateId: "l", remoteCandidateId: "r", state: "succeeded" },
    l: { type: "local-candidate", ...local }, r: { type: "remote-candidate", ...remote },
  });

  it("labels same-network, internet and relayed pairs from the selected candidates", async () => {
    expect(await connectionRoute(viaTransport({ candidateType: "host", address: "192.168.1.5" }, { candidateType: "host", address: "192.168.1.9" }))).toBe("lan");
    expect(await connectionRoute(viaTransport({ candidateType: "host", address: "a1b2.local" }, { candidateType: "prflx", address: "10.0.0.7" }))).toBe("lan");
    expect(await connectionRoute(viaTransport({ candidateType: "srflx", address: "203.0.113.4" }, { candidateType: "srflx", address: "198.51.100.8" }))).toBe("internet");
    expect(await connectionRoute(viaTransport({ candidateType: "host", address: "192.168.1.5" }, { candidateType: "srflx", address: "198.51.100.8" }))).toBe("internet");
    expect(await connectionRoute(viaTransport({ candidateType: "relay", address: "192.0.2.1" }, { candidateType: "host", address: "192.168.1.9" }))).toBe("relay");
  });

  it("reads Firefox's selected pair and returns nothing before a pair is chosen", async () => {
    expect(await connectionRoute(report({
      p: { type: "candidate-pair", selected: true, state: "succeeded", localCandidateId: "l", remoteCandidateId: "r" },
      l: { type: "local-candidate", candidateType: "host", address: "fe80::1" }, r: { type: "remote-candidate", candidateType: "host", address: "fd12::3" },
    }))).toBe("lan");
    expect(await connectionRoute(report({ p: { type: "candidate-pair", state: "in-progress" } }))).toBe("");
  });
});
