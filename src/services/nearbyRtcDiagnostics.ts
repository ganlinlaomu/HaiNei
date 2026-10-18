/** Memory-only, address-free snapshots, including negotiations absent from getPeers(). */
export type NearbyRtcSnapshot = {
  id: number;
  connection: string;
  ice: string;
  gathering: string;
  signaling: string;
  localDescription: string;
  remoteDescription: string;
  localCandidates: number;
  remoteCandidates: number;
  candidateTypes: string[];
  iceErrors: number[];
};

export function createNearbyRtcDiagnostics(Native: typeof RTCPeerConnection) {
  let sequence = 0;
  const snapshots: NearbyRtcSnapshot[] = [];
  // Trystero accepts a constructor per room. Never replace the browser global.
  class ObservedPeerConnection extends Native {
    private updateSnapshot: (() => void) | undefined;
    private appliedCandidates = 0;
    constructor(config?: RTCConfiguration) {
      super(config);
      const snapshot: NearbyRtcSnapshot = {
        id: ++sequence, connection: this.connectionState, ice: this.iceConnectionState,
        gathering: this.iceGatheringState, signaling: this.signalingState,
        localDescription: "—", remoteDescription: "—", localCandidates: 0,
        remoteCandidates: 0, candidateTypes: [], iceErrors: [],
      };
      snapshots.push(snapshot);
      // Keep no PC, SDP, IP address, room password or file contents in snapshots.
      if (snapshots.length > 12) snapshots.shift();
      const update = () => {
        snapshot.connection = this.connectionState;
        snapshot.ice = this.iceConnectionState;
        snapshot.gathering = this.iceGatheringState;
        snapshot.signaling = this.signalingState;
        snapshot.localDescription = this.localDescription?.type || snapshot.localDescription;
        snapshot.remoteDescription = this.remoteDescription?.type || snapshot.remoteDescription;
        snapshot.remoteCandidates = Math.max(snapshot.remoteCandidates, this.appliedCandidates,
          (this.remoteDescription?.sdp.match(/^a=candidate:/gm) || []).length);
      };
      this.updateSnapshot = update;
      for (const type of ["connectionstatechange", "iceconnectionstatechange", "icegatheringstatechange", "signalingstatechange"]) {
        this.addEventListener(type, update);
      }
      this.addEventListener("icecandidate", event => {
        if (!event.candidate) return;
        snapshot.localCandidates++;
        const type = event.candidate.type;
        if (type && !snapshot.candidateTypes.includes(type)) snapshot.candidateTypes.push(type);
        update();
      });
      this.addEventListener("icecandidateerror", event => {
        if (!snapshot.iceErrors.includes(event.errorCode)) snapshot.iceErrors.push(event.errorCode);
      });
    }

    async addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
      await super.addIceCandidate(candidate);
      if (candidate?.candidate) this.appliedCandidates++;
      this.updateSnapshot?.();
    }

    async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      await super.setRemoteDescription(description);
      this.updateSnapshot?.();
    }
  }
  return {
    PeerConnection: ObservedPeerConnection,
    snapshots: () => snapshots.map(value => ({ ...value, candidateTypes: [...value.candidateTypes], iceErrors: [...value.iceErrors] })),
    clear: () => { snapshots.length = 0; },
  };
}
