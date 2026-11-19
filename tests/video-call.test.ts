// Video calls on top of voice calls. The guarantees that matter most here:
// a voice call is byte-for-byte the old flow, and camera video never reaches
// the audio path.
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callControlTags, parseCallSignal, serializeCallSignal } from "@/nostr/messaging/callControl";
import { CAMERA_STREAM_KIND, VIDEO_CONSENT_TIMEOUT_MS, createVideoLink, isCameraStream, isVideoRtp, videoStats, watchCameraTrack } from "@/services/callVideo";

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

let trackSeq = 0;
function track(kind: "audio" | "video") {
  return { id: `track-${++trackSeq}`, kind, enabled: true, readyState: "live", muted: false, stop: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
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
  const listeners: Record<string, Set<(event?: any) => void>> = {};
  const on = (type: string) => (listeners[type] ||= new Set());
  const sender = { replaceTrack: vi.fn(async () => undefined), getParameters: () => ({ encodings: [{}] }), setParameters: vi.fn(async () => undefined) };
  return {
    signalingState: state,
    sender,
    addEventListener: (type: string, listener: (event?: any) => void) => on(type).add(listener),
    removeEventListener: (type: string, listener: (event?: any) => void) => on(type).delete(listener),
    addTransceiver: vi.fn(() => ({ sender })),
    getTransceivers: () => [],
    getReceivers: () => [],
    getSenders: () => [],
    settle() { this.signalingState = "stable"; for (const listener of [...on("signalingstatechange")]) listener(); },
    deliverTrack(track: any) { for (const listener of [...on("track")]) listener({ track }); },
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

class FakeMediaStream {
  tracks: any[];
  constructor(tracks: any[] = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
}

describe("in-room video handshake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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

  it("caller adds its camera only after audio is connected and the callee asked for video", async () => {
    const t = link("outgoing");
    t.link.joined("peer");
    t.message({ t: "want" });
    expect(t.pc.addTransceiver).not.toHaveBeenCalled();
    t.connectAudio();
    await flush();
    // Its own sendonly transceiver: never the peer's receiving one.
    expect(t.pc.addTransceiver).toHaveBeenCalledWith(t.camera.getVideoTracks()[0], { direction: "sendonly", streams: [t.camera] });
    expect(t.room.addStream).not.toHaveBeenCalled();
    expect(t.sent()).toContainEqual({ t: "go" });
  });

  it("waits for a stable connection so the video offer never overlaps the audio one", async () => {
    const t = link("outgoing");
    t.pc.signalingState = "have-remote-offer";
    t.link.joined("peer");
    t.connectAudio();
    t.message({ t: "want" });
    expect(t.pc.addTransceiver).not.toHaveBeenCalled();
    t.pc.settle();
    await flush();
    expect(t.pc.addTransceiver).toHaveBeenCalledTimes(1);
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
    expect(silent.pc.addTransceiver).not.toHaveBeenCalled();
  });

  it("callee asks for video on joining and adds its camera after the caller's go", async () => {
    const t = link("incoming");
    t.link.joined("peer");
    expect(t.sent()).toEqual([{ t: "want" }]);
    t.connectAudio();
    expect(t.pc.addTransceiver).not.toHaveBeenCalled();
    t.message({ t: "go" });
    await flush();
    expect(t.pc.addTransceiver).toHaveBeenCalledTimes(1);
  });

  it("callee answering a video invite by voice says so and never sends video", () => {
    const t = link("incoming", { wantVideo: () => false });
    t.link.joined("peer");
    expect(t.sent()).toEqual([{ t: "voice" }]);
  });

  it("receives the peer's video from the connection's track events, ignoring audio", () => {
    const t = link("incoming");
    t.link.joined("peer");
    t.pc.deliverTrack(track("audio"));
    expect(t.events.remote).not.toHaveBeenCalled();
    const video = track("video");
    t.pc.deliverTrack(video);
    t.pc.deliverTrack(video);
    expect(t.events.remote).toHaveBeenCalledTimes(1);
  });

  it("flips the camera on its own sender without renegotiating", async () => {
    const t = link("outgoing");
    t.link.joined("peer");
    t.message({ t: "want" });
    t.connectAudio();
    await flush();
    const next = track("video");
    await t.link.replaceCamera(t.camera.getVideoTracks()[0], next as any);
    expect(t.pc.sender.replaceTrack).toHaveBeenCalledWith(next);
    expect(t.room.replaceTrack).not.toHaveBeenCalled();
  });

  it("caps the video bitrate, retrying while iOS reports the sender not ready", async () => {
    const t = link("outgoing");
    const params = { encodings: [{} as any] };
    t.pc.sender.getParameters = () => params as any;
    (t.pc.sender as any).track = t.camera.getVideoTracks()[0];
    t.pc.sender.setParameters
      .mockRejectedValueOnce(Object.assign(new Error("not ready"), { name: "InvalidStateError" }))
      .mockRejectedValueOnce(Object.assign(new Error("not ready"), { name: "InvalidStateError" }));
    t.link.joined("peer");
    t.message({ t: "want" });
    t.connectAudio();
    await flush();
    // The cap is applied once the offer/answer settles.
    t.pc.signalingState = "have-local-offer";
    t.pc.settle();
    await flush();
    expect(t.pc.sender.setParameters).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.pc.sender.setParameters).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.pc.sender.setParameters).toHaveBeenCalledTimes(3);
    expect(params.encodings[0]).toEqual({ maxBitrate: 600_000 });
  });

  it("relays camera on/off to the peer", async () => {
    const t = link("outgoing");
    t.link.joined("peer");
    t.message({ t: "want" });
    t.connectAudio();
    await flush();
    t.link.setCameraOn(false);
    expect(t.camera.getVideoTracks()[0].enabled).toBe(false);
    expect(t.sent()).toContainEqual({ t: "camera", on: false });
    t.message({ t: "camera", on: false });
    expect(t.events.remoteCamera).toHaveBeenCalledWith(false);
  });
});

describe("black-frame protection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  function eventTrack() {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      muted: false, readyState: "live",
      addEventListener: (type: string, listener: () => void) => { (listeners[type] ||= []).push(listener); },
      removeEventListener: (type: string, listener: () => void) => { listeners[type] = (listeners[type] || []).filter(l => l !== listener); },
      fire(type: string) { for (const listener of listeners[type] || []) listener(); },
    };
  }

  it("restarts a camera that iOS keeps interrupted, not one that recovers", () => {
    const track = eventTrack();
    const restart = vi.fn();
    const stop = watchCameraTrack(track as any, restart, () => true);
    track.muted = true; track.fire("mute");
    vi.advanceTimersByTime(500);
    track.muted = false; track.fire("unmute");
    vi.advanceTimersByTime(1_000);
    expect(restart).not.toHaveBeenCalled();
    track.muted = true; track.fire("mute");
    vi.advanceTimersByTime(800);
    expect(restart).toHaveBeenCalledWith("interrupted");
    track.fire("ended");
    expect(restart).toHaveBeenCalledWith("ended");
    stop();
  });

  it("replaces a stale camera before sending it", async () => {
    const room = fakeRoom();
    const pc = connection();
    room.peers.peer = pc;
    const order: string[] = [];
    pc.addTransceiver.mockImplementation(() => { order.push("addTransceiver"); return { sender: pc.sender }; });
    const created = createVideoLink({
      room: room as any, direction: "outgoing", peer: () => "peer", active: () => true, audioConnected: () => true,
      camera: () => stream("video"), wantVideo: () => true, onRemoteVideo: vi.fn(), onRemoteCamera: vi.fn(), onVoiceOnly: vi.fn(),
      ensureCamera: async () => { order.push("ensureCamera"); },
    });
    created.joined("peer");
    room.actions.video.onMessage({ t: "want" }, { peerId: "peer" });
    await vi.waitFor(() => expect(order).toEqual(["ensureCamera", "addTransceiver"]));
  });

  it("reads video frame counters, including WebKit's untyped records", () => {
    const codecs = new Map([["v", { mimeType: "video/H264" }], ["a", { mimeType: "audio/opus" }]]);
    const entries = [
      { type: "inbound-rtp", codecId: "v", framesDecoded: 42, framesReceived: 44, packetsReceived: 90, frameWidth: 480 },
      { type: "inbound-rtp", codecId: "a", packetsReceived: 300 },
      { type: "outbound-rtp", kind: "video", framesEncoded: 50, packetsSent: 100 },
    ];
    const report = { forEach: (fn: (entry: any) => void) => entries.forEach(fn), get: (id: string) => codecs.get(id) };
    expect(isVideoRtp(entries[0], report)).toBe(true);
    expect(isVideoRtp(entries[1], report)).toBe(false);
    expect(videoStats(report)).toMatchObject({ framesDecoded: 42, framesReceived: 44, framesEncoded: 50, frameWidth: 480 });
  });

  it("never reads an untyped video record as the call's audio", async () => {
    const { readFileSync } = await import("node:fs");
    const engine = readFileSync("src/services/callEngine.ts", "utf8");
    expect(engine).toContain("const untypedAudio = (entry: any) => !entry.kind && !entry.mediaType && !isVideoRtp(entry, report);");
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
    vi.stubGlobal("MediaStream", FakeMediaStream);
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
