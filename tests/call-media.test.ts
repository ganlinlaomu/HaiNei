import { describe, expect, it, vi } from "vitest";
import { callMediaState, createCallMediaGate } from "@/services/callMedia";

function fixture(direction: "incoming" | "outgoing") {
  const pc = Object.assign(new EventTarget(), { signalingState: "stable" });
  let active = true;
  const attach = vi.fn();
  const gate = createCallMediaGate({
    direction, current: () => active,
    connection: () => pc as unknown as RTCPeerConnection, attach,
  });
  return { pc, attach, gate, cancel: () => { active = false; gate.clear(); } };
}

describe("voice media negotiation", () => {
  it("lets the caller publish audio first, once per peer", () => {
    const { gate, attach } = fixture("outgoing");
    gate.joined("callee");
    gate.joined("callee");
    gate.received("callee");
    expect(attach.mock.calls).toEqual([["callee"]]);
  });

  it("does not let the callee race the caller's first audio offer", () => {
    const { pc, gate, attach } = fixture("incoming");
    gate.joined("caller");
    expect(attach).not.toHaveBeenCalled();
    pc.signalingState = "have-remote-offer";
    gate.received("caller"); // ontrack fires before the local answer is applied
    pc.dispatchEvent(new Event("signalingstatechange"));
    expect(attach).not.toHaveBeenCalled();
    pc.signalingState = "stable";
    pc.dispatchEvent(new Event("signalingstatechange"));
    expect(attach.mock.calls).toEqual([["caller"]]);
    gate.received("caller");
    pc.dispatchEvent(new Event("signalingstatechange"));
    expect(attach).toHaveBeenCalledOnce();
  });

  it("sends immediately when the remote track arrives after the answer is stable", () => {
    const { gate, attach } = fixture("incoming");
    gate.joined("caller");
    gate.received("caller");
    expect(attach).toHaveBeenCalledWith("caller");
  });

  it("discards a pending microphone attachment on hangup", () => {
    const { pc, gate, attach, cancel } = fixture("incoming");
    pc.signalingState = "have-remote-offer";
    gate.received("caller");
    cancel();
    pc.signalingState = "stable";
    pc.dispatchEvent(new Event("signalingstatechange"));
    expect(attach).not.toHaveBeenCalled();
  });

  it("forgets the old negotiation and permits one attachment after reconnect", () => {
    const { pc, gate, attach } = fixture("incoming");
    pc.signalingState = "have-remote-offer";
    gate.received("caller");
    gate.forget("caller");
    pc.signalingState = "stable";
    pc.dispatchEvent(new Event("signalingstatechange"));
    gate.joined("caller");
    expect(attach).not.toHaveBeenCalled();
    gate.received("caller");
    expect(attach).toHaveBeenCalledOnce();
  });

  it("distinguishes a live microphone from a transceiver negotiated receive-only", () => {
    const microphone = { kind: "audio", readyState: "live", enabled: true, muted: false, id: "private-track-id" };
    const state = callMediaState({
      signalingState: "stable",
      getTransceivers: () => [{
        direction: "sendrecv", currentDirection: "recvonly",
        sender: { track: microphone }, receiver: { track: { kind: "audio", muted: true, readyState: "live" } },
      }],
    } as unknown as RTCPeerConnection, { getAudioTracks: () => [microphone] } as unknown as MediaStream);
    expect(state.transceivers).toEqual([expect.objectContaining({
      direction: "sendrecv", currentDirection: "recvonly", senderIsMicrophone: true, senderMuted: false,
    })]);
    expect(JSON.stringify(state)).not.toContain(microphone.id);
  });
});
