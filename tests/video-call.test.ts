// Video calls on top of voice calls. The guarantees that matter most here:
// a voice call is byte-for-byte the old flow, and camera video never reaches
// the audio path.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callControlTags, parseCallSignal, serializeCallSignal } from "@/nostr/messaging/callControl";
import { CAMERA_STREAM_KIND, VIDEO_CONSENT_TIMEOUT_MS, createVideoLink, isCameraStream } from "@/services/callVideo";

const ME = "a".repeat(64);
const FRIEND = "b".repeat(64);
const CALL_ID = "c".repeat(32);
const invite = { action: "invite" as const, callId: CALL_ID, room: "d".repeat(32), secret: "e".repeat(64) };
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  rooms: [] as any[],
  elements: [] as any[],
}));
vi.mock("@/nostr/messaging/service", async original => ({ ...(await original() as object), sendDirectMessage: mocks.send, sendFastControl: mocks.send }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/services/nearbyTransfer", () => ({ refreshNearbyRelaySockets: async () => undefined }));
vi.mock("@/services/relaySession", () => ({ turnIceServers: async () => [] }));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: ME, nip44Encrypt: vi.fn(), signEvent: vi.fn() }) }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => ({ isAccepted: () => true }) }));
vi.mock("trystero", () => ({ joinRoom: () => fakeRoom() }));

function fakeRoom() {
  const actions: Record<string, any> = {};
  const room = {
    actions,
    leave: vi.fn(async () => undefined),
    addStream: vi.fn(() => [Promise.resolve()]),
    replaceTrack: vi.fn(() => [Promise.resolve()]),
    peers: {} as Record<string, any>,
    getPeers() { return this.peers; },
    onPeerJoin: null as any,
    onPeerLeave: null as any,
    onPeerStream: null as any,
    makeAction: vi.fn((name: string, config: any = {}) => {
      const action = { send: vi.fn(async () => undefined), onMessage: config.onMessage || null };
      actions[name] = action;
      return action;
    }),
  };
  mocks.rooms.push(room);
  return room;
}

function track(kind: "audio" | "video") {
  return { kind, enabled: true, readyState: "live", muted: false, stop: vi.fn() };
}
function stream(...kinds: Array<"audio" | "video">) {
  const tracks = kinds.map(track);
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === "audio"),
    getVideoTracks: () => tracks.filter(t => t.kind === "video"),
    addTrack: (t: any) => tracks.push(t),
    removeTrack: (t: any) => tracks.splice(tracks.indexOf(t), 1),
  } as any;
}
function connection(state = "stable") {
  const listeners = new Set<() => void>();
  return {
    signalingState: state,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    getSenders: () => [],
    settle() { this.signalingState = "stable"; for (const listener of [...listeners]) listener(); },
  };
}

describe("video call signaling", () => {
  it("carries the video offer on invites only, and old invites stay voice", () => {
    const tags = callControlTags(invite);
    expect(parseCallSignal({ tags, plaintext: serializeCallSignal({ ...invite, media: "video" }) })).toEqual({ ...invite, media: "video" });
    expect(parseCallSignal({ tags, plaintext: serializeCallSignal(invite) })).toEqual(invite);
    expect(parseCallSignal({ tags, plaintext: JSON.stringify({ type: "hainei-call", ...invite, media: "hologram" }) })).toEqual(invite);
  });

  it("tells camera streams from microphone streams", () => {
    expect(isCameraStream(stream("video"))).toBe(true);
    expect(isCameraStream(stream("audio"))).toBe(false);
    expect(isCameraStream(stream("audio", "video"))).toBe(false);
    expect(isCameraStream(stream("audio"), { kind: CAMERA_STREAM_KIND })).toBe(true);
  });
});

describe("in-room video handshake", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function link(direction: "incoming" | "outgoing", over: Partial<Parameters<typeof createVideoLink>[0]> = {}) {
    const room = fakeRoom();
    const pc = connection();
    room.peers.peer = pc;
    let audio = false;
    const camera = stream("video");
    const events = { voiceOnly: vi.fn(), remote: vi.fn(), remoteCamera: vi.fn() };
    const created = createVideoLink({
      room: room as any, direction, peer: () => "peer", active: () => true, audioConnected: () => audio,
      camera: () => camera, wantVideo: () => true,
      onRemoteVideo: events.remote, onRemoteCamera: events.remoteCamera, onVoiceOnly: events.voiceOnly, ...over,
    });
    const message = (data: unknown) => room.actions.video.onMessage(data, { peerId: "peer" });
    const sent = () => room.actions.video.send.mock.calls.map((call: any) => call[0]);
    return { room, pc, camera, events, link: created, message, sent, connectAudio: () => { audio = true; created.audioReady(); } };
  }

  it("caller adds its camera only after audio is connected and the callee asked for video", () => {
    const t = link("outgoing");
    t.link.joined("peer");
    t.message({ t: "want" });
    expect(t.room.addStream).not.toHaveBeenCalled();
    t.connectAudio();
    expect(t.room.addStream).toHaveBeenCalledWith(t.camera, { target: "peer", metadata: { kind: CAMERA_STREAM_KIND } });
    expect(t.sent()).toContainEqual({ t: "go" });
  });

  it("waits for a stable connection so the video offer never overlaps the audio one", () => {
    const t = link("outgoing");
    t.pc.signalingState = "have-remote-offer";
    t.link.joined("peer");
    t.connectAudio();
    t.message({ t: "want" });
    expect(t.room.addStream).not.toHaveBeenCalled();
    t.pc.settle();
    expect(t.room.addStream).toHaveBeenCalledTimes(1);
  });

  it("caller falls back to voice when the callee answers by voice or never answers (older app)", () => {
    const declined = link("outgoing");
    declined.link.joined("peer");
    declined.message({ t: "voice" });
    expect(declined.events.voiceOnly).toHaveBeenCalledTimes(1);

    const silent = link("outgoing");
    silent.link.joined("peer");
    silent.connectAudio();
    vi.advanceTimersByTime(VIDEO_CONSENT_TIMEOUT_MS);
    expect(silent.events.voiceOnly).toHaveBeenCalledTimes(1);
    silent.message({ t: "want" });
    expect(silent.room.addStream).not.toHaveBeenCalled();
  });

  it("callee asks for video on joining and adds its camera after the caller's go", () => {
    const t = link("incoming");
    t.link.joined("peer");
    expect(t.sent()).toEqual([{ t: "want" }]);
    t.connectAudio();
    expect(t.room.addStream).not.toHaveBeenCalled();
    t.message({ t: "go" });
    expect(t.room.addStream).toHaveBeenCalledTimes(1);
  });

  it("callee answering a video invite by voice says so and never sends video", () => {
    const t = link("incoming", { wantVideo: () => false });
    t.link.joined("peer");
    expect(t.sent()).toEqual([{ t: "voice" }]);
  });

  it("relays camera on/off to the peer", () => {
    const t = link("outgoing");
    t.link.joined("peer");
    t.message({ t: "want" });
    t.connectAudio();
    t.link.setCameraOn(false);
    expect(t.camera.getVideoTracks()[0].enabled).toBe(false);
    expect(t.sent()).toContainEqual({ t: "camera", on: false });
    t.message({ t: "camera", on: false });
    expect(t.events.remoteCamera).toHaveBeenCalledWith(false);
  });
});

describe("call engine with video", () => {
  let getUserMedia: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    mocks.send.mockClear();
    mocks.rooms.length = 0;
    mocks.elements.length = 0;
    getUserMedia = vi.fn(async (constraints: any) => constraints.video ? stream("video") : stream("audio"));
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaStream", class { tracks: any[]; constructor(tracks: any[] = []) { this.tracks = tracks; } getVideoTracks() { return this.tracks; } });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        const element = { autoplay: false, setAttribute: vi.fn(), style: {}, srcObject: null, play: vi.fn(async () => undefined), remove: vi.fn() };
        mocks.elements.push(element);
        return element;
      }),
      body: { appendChild: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: "visible",
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const invites = () => mocks.send.mock.calls.map((call: any) => JSON.parse(call[0].content)).filter((s: any) => s.action === "invite");

  it("a voice call is unchanged: one microphone request, no video offer, no video room action", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    await startCall(FRIEND);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(MIC_CONSTRAINTS);
    expect(invites()[0].media).toBeUndefined();
    expect(mocks.rooms[0].makeAction.mock.calls.map((call: any) => call[0])).not.toContain("video");
    await hangup();
  });

  it("a video call keeps the same microphone request and asks for the camera separately", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND, { video: true });
    expect(getUserMedia.mock.calls[0][0]).toEqual(MIC_CONSTRAINTS);
    expect(getUserMedia.mock.calls[1][0]).toMatchObject({ audio: false, video: expect.any(Object) });
    expect(invites()[0].media).toBe("video");
    expect(useCallStore().media).toBe("video");
    expect(useCallStore().localVideo).toBeTruthy();
    expect(mocks.rooms[0].makeAction.mock.calls.map((call: any) => call[0])).toContain("video");
    await hangup();
  });

  it("never binds a camera stream to the remote audio element", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    await startCall(FRIEND, { video: true });
    const room = mocks.rooms[0];
    room.peers.peer = connection();
    room.onPeerJoin("peer");
    const before = mocks.elements.length;
    const camera = stream("video");
    room.onPeerStream(camera, "peer", { kind: CAMERA_STREAM_KIND });
    expect(mocks.elements).toHaveLength(before);
    expect(mocks.elements.some(element => element.srcObject === camera)).toBe(false);
    const voice = stream("audio");
    room.onPeerStream(voice, "peer");
    expect(mocks.elements.some(element => element.srcObject === voice)).toBe(true);
    await hangup();
  });

  it("continues as a voice call when the camera is unavailable", async () => {
    getUserMedia.mockImplementation(async (constraints: any) => {
      if (constraints.video) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      return stream("audio");
    });
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND, { video: true });
    expect(useCallStore().phase).toBe("outgoing");
    expect(useCallStore().cameraOn).toBe(false);
    await hangup();
  });
});
