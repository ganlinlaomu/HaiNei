// One-to-one voice calls: NIP-17 signaling, push wake-up, and the call engine.
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALL_LOG_TYPE, CALL_MISSED_TYPE, callControlTags, isCallControl, parseCallSignal, serializeCallSignal,
} from "@/nostr/messaging/callControl";
import { classifyPrivateMessage } from "@/nostr/messaging/messageRouting";
import { pushCategoryForMessage, shouldTriggerGenericPush } from "@/nostr/messaging/service";
import { CALL_PUSH_PAYLOAD, pushPayloadForType } from "../worker/src/push";

const ME = "a".repeat(64);
const FRIEND = "b".repeat(64);
const CALL_ID = "c".repeat(32);
const invite = { action: "invite" as const, callId: CALL_ID, room: "d".repeat(32), secret: "e".repeat(64) };

const mocks = vi.hoisted(() => ({
  send: vi.fn(async () => ({})),
  rooms: [] as any[],
  audioElements: [] as any[],
  accepted: true,
  joinError: null as Error | null,
  relaySession: vi.fn(async () => undefined),
}));
vi.mock("@/nostr/messaging/service", async original => ({ ...(await original() as object), sendDirectMessage: mocks.send, sendFastControl: mocks.send }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/services/nearbyTransfer", () => ({ refreshNearbyRelaySockets: mocks.relaySession }));
vi.mock("@/services/relaySession", () => ({ turnIceServers: async () => [] }));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: ME, nip44Encrypt: vi.fn(), signEvent: vi.fn() }) }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => ({ isAccepted: () => mocks.accepted }) }));
vi.mock("trystero", () => ({
  joinRoom: (config: any, id: string, callbacks?: any) => {
    if (mocks.joinError) throw mocks.joinError;
    const actions: Record<string, any> = {};
    const room = {
      config,
      id,
      callbacks,
      actions,
      leave: vi.fn(async () => undefined),
      addStream: vi.fn(() => [Promise.resolve()]),
      peers: {} as Record<string, unknown>,
      getPeers() { return this.peers; },
      onPeerJoin: null as ((peerId: string) => void) | null,
      onPeerLeave: null as ((peerId: string) => void) | null,
      onPeerStream: null as ((stream: MediaStream, peerId: string) => void) | null,
      makeAction: vi.fn((name: string, actionConfig: any = {}) => {
        const action = {
          send: vi.fn(async () => undefined),
          onMessage: actionConfig.onMessage || null,
          onReceive: actionConfig.onReceive || null,
          onReceiveProgress: actionConfig.onReceiveProgress || null,
        };
        actions[name] = action;
        return action;
      }),
    };
    mocks.rooms.push(room);
    return room;
  },
}));

describe("call signaling", () => {
  it("round-trips signals and rejects malformed ones", () => {
    const tags = callControlTags(invite);
    expect(tags).toEqual([["t", "hainei-call"], ["t", "hainei-call-invite"]]);
    expect(parseCallSignal({ tags, plaintext: serializeCallSignal(invite) })).toEqual(invite);
    expect(parseCallSignal({ tags: callControlTags({ action: "end" }), plaintext: serializeCallSignal({ action: "end", callId: CALL_ID, durationSeconds: 75 }) }))
      .toEqual({ action: "end", callId: CALL_ID, durationSeconds: 75 });
    expect(() => serializeCallSignal({ action: "invite", callId: CALL_ID })).toThrow();
    expect(parseCallSignal({ tags, plaintext: JSON.stringify({ type: "hainei-call", action: "ring", callId: CALL_ID }) })).toBeNull();
    // Without the tag, even a valid-looking payload is not acted on.
    expect(parseCallSignal({ tags: [], plaintext: serializeCallSignal(invite) })).toBeNull();
  });

  it("routes call signals as controls (never stored as chat messages)", () => {
    expect(isCallControl({ tags: callControlTags(invite) })).toBe(true);
    expect(classifyPrivateMessage({ tags: callControlTags(invite), plaintext: serializeCallSignal(invite), protocol: "nip17", transportKind: 1059 })).toBe("control");
  });

  it("wakes the callee with a call push; only missed-call records notify", () => {
    expect(pushCategoryForMessage(callControlTags(invite))).toBe("call");
    expect(shouldTriggerGenericPush(callControlTags({ action: "accept" }))).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-dm"], ["t", CALL_LOG_TYPE]])).toBe(false);
    expect(shouldTriggerGenericPush([["t", "hainei-dm"], ["t", CALL_LOG_TYPE], ["t", CALL_MISSED_TYPE]])).toBe(true);
    expect(pushPayloadForType("call")).toBe(CALL_PUSH_PAYLOAD);
    expect(CALL_PUSH_PAYLOAD.body).toBe("你有一个语音来电");
    const worker = readFileSync("worker/src/push.ts", "utf8");
    expect(worker).toContain('...(pushPayload.type === "call" ? { Urgency: "high" } : {})');
    const sw = readFileSync("public/service-worker.js", "utf8");
    expect(sw).toContain("body: isCall ? '你有一个语音来电' : '你有新的私信消息'");
    expect(sw).toContain("type === 'CLOSE_CALL_NOTIFICATION'");
    expect(sw).toContain("type === 'INCOMING_RINGTONE_BLOCKED'");
    expect(sw).toContain("type === 'INCOMING_RINGTONE_START'");
    expect(sw).toContain("visibleIncomingCallId && visibleIncomingCallId !== id");
    expect(sw).toContain("hasBlockedVisibleRing()");
    expect(sw).toContain("if (revision !== callAlertRevision");
    expect(sw).toContain("callId: blockedIncomingCallId");
  });

  it("keeps call code and ringtone media out of the startup path", () => {
    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toContain('const loadCallOverlay = () => import("@/components/CallOverlay.vue")');
    expect(app).not.toContain('scheduleBackgroundTask("preload-call-ui"');
    expect(app).toContain(`<CallOverlay v-if="call.phase !== 'idle'" />`);
    expect(readFileSync("src/stores/call.ts", "utf8")).toContain('return import("@/services/callEngine").then(module => {');
    expect(readFileSync("src/services/accountMessageSync.ts", "utf8")).toContain("await loadCallEngine()");
    expect(readFileSync("src/components/CallOverlay.vue", "utf8")).toContain("z-index:200000");
    expect(readFileSync("src/components/CallOverlay.vue", "utf8")).toContain("function restoreAudio() { loadedCallEngine()?.recoverCallAudio(); }");
    expect(readFileSync("src/components/CallOverlay.vue", "utf8")).not.toContain('from "@/services/callEngine"');
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain("storageHydrationMs");
    expect(main).toContain("versionTrackingMs");
    expect(main).toContain("vueMountMs");
    const chat = readFileSync("src/views/Messages.vue", "utf8");
    expect(chat).toContain('scheduleBackgroundTask("chat-call-warmup"');
    expect(chat).toContain("data-live-audio-action");
    const unlock = readFileSync("src/utils/audioUnlock.ts", "utf8");
    expect(unlock).not.toContain("installAudioUnlock");
    expect(main).not.toContain("installAudioUnlock");
    const overlay = readFileSync("src/components/CallOverlay.vue", "utf8");
    expect(overlay).toContain("const engine = loadedCallEngine()");
    expect(overlay).toContain("data-live-audio-action");
  });
});

describe("call engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    mocks.send.mockClear();
    mocks.rooms.length = 0;
    mocks.audioElements.length = 0;
    mocks.accepted = true;
    mocks.joinError = null;
    mocks.relaySession.mockReset();
    mocks.relaySession.mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })) } });
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        const audio = {
          autoplay: false,
          setAttribute: vi.fn(),
          style: {},
          srcObject: null as MediaStream | null,
          play: vi.fn(async () => undefined),
          remove: vi.fn(),
        };
        mocks.audioElements.push(audio);
        return audio;
      }),
      body: { appendChild: vi.fn() },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const now = () => Math.floor(Date.now() / 1000);
  const sentActions = () => mocks.send.mock.calls.map((call: any) => {
    try { return JSON.parse(call[0].content).action; } catch { return call[0].content; }
  });

  it("rings once for a fresh invite, never for a stale, duplicate or own one", async () => {
    const { handleCallSignal } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "1".repeat(32) }, now() - 120);
    expect(store.phase).toBe("idle");
    await handleCallSignal(ME, FRIEND, invite, now());
    expect(store.phase).toBe("idle");
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "2".repeat(32) }, now());
    expect(store).toMatchObject({ phase: "incoming", peer: FRIEND, direction: "incoming", callId: "2".repeat(32) });
    // A second invite while ringing gets a busy reply.
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "3".repeat(32) }, now());
    await vi.advanceTimersByTimeAsync(0);
    // The ringing acknowledgement for the first call, then busy for the second.
    expect(sentActions()).toEqual(["ringing", "busy"]);
    expect(store.callId).toBe("2".repeat(32));
  });

  it("offers an explicit trusted-tap retry when iOS denies incoming ringtone autoplay", async () => {
    const { handleCallSignal, retryIncomingRingtone, declineCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const element = {
      src: "", currentTime: 0, paused: true, loop: false, muted: false, error: null,
      setAttribute: vi.fn(), pause: vi.fn(),
      play: vi.fn()
        .mockRejectedValueOnce(new DOMException("autoplay denied", "NotAllowedError"))
        .mockResolvedValue(undefined),
    };
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => element);
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "8".repeat(32) }, now());
    await Promise.resolve();
    const store = useCallStore();
    expect(store.phase).toBe("incoming");
    expect(store.ringtoneBlocked).toBe(true);
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('signalCallNotification("INCOMING_RINGTONE_BLOCKED", session.id);');
    expect(element.play).toHaveBeenCalledTimes(1);
    retryIncomingRingtone();
    await Promise.resolve();
    expect(element.play).toHaveBeenCalledTimes(2);
    expect(store.ringtoneBlocked).toBe(false);
    expect(store.phase).toBe("incoming");
    await declineCall();
    expect(store.phase).toBe("ended");
  });

  it("stops ringing when another of our devices answers", async () => {
    const { handleCallSignal } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await handleCallSignal(FRIEND, ME, invite, now());
    await handleCallSignal(ME, FRIEND, { action: "accept", callId: CALL_ID }, now());
    expect(store).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
    // Only this device's ringing acknowledgement; nothing after the other answered.
    expect(sentActions()).toEqual(["ringing"]);
  });

  it("does not ring for an invite that arrives after its cancellation", async () => {
    const { handleCallSignal } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const callId = "5".repeat(32);

    await handleCallSignal(FRIEND, ME, { action: "cancel", callId }, now());
    await handleCallSignal(FRIEND, ME, { ...invite, callId }, now());

    expect(useCallStore().phase).toBe("idle");
  });

  it("calls a friend over a one-time room and records a declined call", async () => {
    const { handleCallSignal, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await startCall(FRIEND);
    expect(store).toMatchObject({ phase: "outgoing", peer: FRIEND, direction: "outgoing" });
    const [sentInvite] = mocks.send.mock.calls[0] as any[];
    const signal = JSON.parse(sentInvite.content);
    expect(signal).toMatchObject({ action: "invite", callId: store.callId });
    expect(sentInvite.tags).toEqual([["t", "hainei-call"], ["t", "hainei-call-invite"]]);
    // The room and password are the invite's, and only travel inside it.
    expect(mocks.rooms[0].id).toBe(signal.room);
    expect(mocks.rooms[0].config.password).toBe(signal.secret);

    await handleCallSignal(FRIEND, ME, { action: "reject", callId: store.callId }, now());
    expect(store).toMatchObject({ phase: "ended", endReason: "remote_declined" });
    expect(mocks.rooms[0].leave).toHaveBeenCalled();
    // The caller's record is private to its own devices: no unread for the callee.
    const log = (mocks.send.mock.calls.at(-1) as any[])[0];
    expect(log.content).toBe("📞 语音通话 · 对方已拒绝");
    expect(log.tags).toEqual([["t", "hainei-dm"], ["t", CALL_LOG_TYPE]]);
    expect(log.selfOnly).toBe(true);
  });

  it("sends signals on the fast path, the invite with an immediate call push", async () => {
    const { startCall } = await import("@/services/callEngine");
    await startCall(FRIEND);
    const [inviteOptions] = mocks.send.mock.calls[0] as any[];
    expect(inviteOptions.push).toBe("call");
    expect(inviteOptions.relays).toEqual(expect.arrayContaining(["wss://cloudflare-nostr-relay.noster.workers.dev"]));
  });

  it("records a declined incoming call privately on the callee side", async () => {
    const { declineCall, handleCallSignal } = await import("@/services/callEngine");
    await handleCallSignal(FRIEND, ME, invite, now());
    await declineCall();
    const records = mocks.send.mock.calls.map((call: any) => call[0]).filter((options: any) => options.tags?.some((tag: string[]) => tag[1] === CALL_LOG_TYPE));
    expect(records).toEqual([expect.objectContaining({ content: "📞 语音通话 · 已拒绝", selfOnly: true })]);
    expect(sentActions()).toContain("reject");
  });


  it("hands off an audible incoming ring to WebRTC without crossing auto", async () => {
    // Regression: iPhone 15 hears the ringing but not the peer after answering.
    vi.resetModules(); // Keep ringtone element/session state from prior tests out.
    const { handleCallSignal, acceptCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const categories: string[] = [];
    let currentCategory = "auto";
    (navigator as any).audioSession = {
      get type() { return currentCategory; },
      set type(next: string) { categories.push(next); currentCategory = next; },
      state: "active",
    };
    const ring = {
      src: "", currentTime: 0, paused: false, loop: false, muted: false,
      preload: "", error: null, setAttribute: vi.fn(),
      play: vi.fn(async () => undefined),
      pause: vi.fn(() => { ring.paused = true; }),
      removeAttribute: vi.fn((name: string) => { if (name === "src") ring.src = ""; }),
      load: vi.fn(),
    };
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ring);
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "7".repeat(32) }, now());
    expect(useCallStore().phase).toBe("incoming");
    expect(categories).toEqual(["playback"]);
    expect(ring.play).toHaveBeenCalledOnce();
    await Promise.resolve();

    const mic = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    mic.mockImplementationOnce(async () => {
      expect(currentCategory).toBe("play-and-record");
      expect(ring.pause).toHaveBeenCalled();
      expect(ring.removeAttribute).toHaveBeenCalledWith("src");
      expect(ring.load).toHaveBeenCalledOnce();
      return { getTracks: () => [], getAudioTracks: () => [] };
    });
    await acceptCall();
    expect(useCallStore().phase).toBe("connecting");
    // No auto reset can interrupt the microphone's call session after ring.
    expect(categories).toEqual(["playback", "play-and-record"]);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("caller-device");
    const remoteStream = { getAudioTracks: () => [] } as unknown as MediaStream;
    room.onPeerStream(remoteStream, "caller-device");
    await Promise.resolve();
    const remote = mocks.audioElements.find((element: any) => element.srcObject === remoteStream);
    expect(remote?.play).toHaveBeenCalledOnce();
    expect(currentCategory).toBe("play-and-record");
    await hangup();
    expect(categories.at(-1)).toBe("auto");
    expect(ring.load).toHaveBeenCalledOnce();
  });

  it("releases outgoing ringback before receiving peer audio without resetting iOS call session", async () => {
    vi.resetModules(); // Reset the audioUnlock media-element cache.
    const { startCall, handleCallSignal, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const categories: string[] = [];
    let category = "auto";
    (navigator as any).audioSession = {
      get type() { return category; },
      set type(next: string) { categories.push(next); category = next; },
      state: "active",
    };
    const ringback = {
      src: "", currentTime: 0, muted: false, loop: false, preload: "", error: null,
      setAttribute: vi.fn(),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ringback);
    await startCall(FRIEND);
    expect(ringback.play).toHaveBeenCalledOnce();
    expect(category).toBe("play-and-record");

    const room = mocks.rooms.at(-1);
    const callId = useCallStore().callId;
    await handleCallSignal(FRIEND, ME, { action: "accept", callId }, now());
    expect(ringback.pause).toHaveBeenCalled();
    expect(ringback.removeAttribute).toHaveBeenCalledWith("src");
    expect(ringback.load).toHaveBeenCalledOnce();
    expect(categories).toEqual(["play-and-record"]);

    room.onPeerJoin("answering-iphone");
    const remoteStream = { getAudioTracks: () => [] } as unknown as MediaStream;
    room.onPeerStream(remoteStream, "answering-iphone");
    await Promise.resolve();
    const remoteAudio = mocks.audioElements.find((item: any) => item.srcObject === remoteStream);
    expect(remoteAudio?.play).toHaveBeenCalledOnce();
    expect(ringback.load.mock.invocationCallOrder[0]).toBeLessThan(remoteAudio.play.mock.invocationCallOrder[0]);
    expect(ringback.load).toHaveBeenCalledOnce();
    expect(category).toBe("play-and-record");
    await hangup();
    expect(categories).toEqual(["play-and-record", "auto"]);
    expect(ringback.load).toHaveBeenCalledOnce();
  });

  it("releases outgoing ringback when cancelled before peer answers", async () => {
    vi.resetModules();
    const { startCall, hangup } = await import("@/services/callEngine");
    const ringback = {
      src: "", currentTime: 0, muted: false, loop: false, preload: "", error: null,
      setAttribute: vi.fn(),
      play: vi.fn(async () => undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ringback);
    await startCall(FRIEND);
    expect(ringback.play).toHaveBeenCalledOnce();
    await hangup();
    expect(ringback.pause).toHaveBeenCalled();
    expect(ringback.removeAttribute).toHaveBeenCalledWith("src");
    expect(ringback.load).toHaveBeenCalledOnce();
  });

  it("requests a call audio session before capture and releases it on hangup", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const audioSession = { type: "auto" };
    (navigator as any).audioSession = audioSession;
    const mic = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    mic.mockImplementationOnce(async () => {
      expect(audioSession.type).toBe("play-and-record");
      return { getTracks: () => [], getAudioTracks: () => [] };
    });
    await startCall(FRIEND);
    expect(audioSession.type).toBe("play-and-record");
    await hangup();
    expect(audioSession.type).toBe("auto");
  });

  it("recovers remote playback rejected by WebKit without renegotiating the call", async () => {
    const { startCall, recoverCallAudio, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND);
    const peer = mocks.rooms.at(-1);
    peer.onPeerJoin("iphone15");
    const play = vi.fn()
      .mockRejectedValueOnce(new DOMException("requires a user gesture", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const remoteAudio = {
      autoplay: false, setAttribute: vi.fn(), style: {}, srcObject: null,
      muted: false, volume: 1, paused: true, error: null, play,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      remove: vi.fn(), pause: vi.fn(),
    };
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => remoteAudio);
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
    peer.onPeerStream(stream, "iphone15");
    await Promise.resolve();
    expect(useCallStore().phase).toBe("active");
    expect(useCallStore().audioStatus).toBe("blocked");
    await vi.advanceTimersByTimeAsync(2_500);
    expect(play).toHaveBeenCalledTimes(1); // autoplay cannot be retried without a gesture
    recoverCallAudio();
    await Promise.resolve();
    // Recovery must create a fresh output renderer, not replay the element
    // that WebKit may have left silent despite resolving play().
    expect(play).toHaveBeenCalledTimes(1);
    const replacement = mocks.audioElements.at(-1);
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(remoteAudio);
    expect(replacement.play).toHaveBeenCalledOnce();
    expect(useCallStore().audioStatus).toBe("playing");
    expect(remoteAudio.srcObject).toBeNull();
    expect(replacement.srcObject).toBe(stream);
    expect(peer.addStream).toHaveBeenCalledTimes(1); // media negotiation unchanged
    await hangup();
    expect(remoteAudio.remove).toHaveBeenCalledOnce();
    expect(replacement.remove).toHaveBeenCalledOnce();
    expect(remoteAudio.removeEventListener).toHaveBeenCalledWith("playing", expect.any(Function));
  });

  it("samples audio-only iOS RTP when WebKit omits kind and does not mistake missing stats for zero loss", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const { useDebugLogsStore } = await import("@/stores/debugLogs");
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("ios-peer");
    let sample = 0;
    room.peers["ios-peer"] = {
      getStats: vi.fn(async () => {
        sample++;
        const entries: [string, any][] = [
          ["pair", { type: "candidate-pair", state: "succeeded", nominated: true }],
        ];
        // First stats poll sees an ICE route but no inbound RTP report.
        if (sample > 1) {
          entries.push(["codec", { type: "codec", mimeType: "audio/opus" }]);
          // Simulate WebKit omitting the required kind/mediaType properties.
          entries.push(["inbound", {
            type: "inbound-rtp", id: "legacy-rtp", codecId: "codec",
            packetsReceived: (sample - 1) * 40, bytesReceived: (sample - 1) * 4800,
          }]);
        }
        return new Map(entries);
      }),
      getReceivers: vi.fn(() => []),
    };
    const track = {
      kind: "audio", id: "remote-audio", muted: true, enabled: true, readyState: "live",
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    room.onPeerStream({ getAudioTracks: () => [track] } as unknown as MediaStream, "ios-peer");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_050);
    let events = useDebugLogsStore().startupMarks();
    expect(events.find(entry => entry.event === "startup_call_audio_stats_unavailable")).toBeTruthy();
    const initial = events.find(entry => entry.event === "startup_call_audio_media_stats");
    expect(initial?.data).toMatchObject({ inboundFound: false, packetsReceived: null });
    await vi.advanceTimersByTimeAsync(8_050);
    events = useDebugLogsStore().startupMarks();
    const media = events.filter(entry => entry.event === "startup_call_audio_media_stats");
    expect(media.at(-1)?.data).toMatchObject({ inboundFound: true, packetsReceived: 80, reportedKind: "missing" });
    expect(events.find(entry => entry.event === "startup_call_remote_track_stalled")).toBeTruthy();
    expect(useCallStore().audioStatus).toBe("blocked");
    await hangup();
    const ended = useDebugLogsStore().startupMarks().find(entry => entry.event === "startup_call_ended");
    expect(ended?.data).toMatchObject({ inboundStatsSeen: true, receivedAudioPackets: 80 });
  });

  it("makes a one-time manual iPhone route reset when RTP track is stuck muted", async () => {
    const { startCall, recoverCallAudio, hangup } = await import("@/services/callEngine");
    const categories: string[] = [];
    let category = "auto";
    const audioSession = {
      get type() { return category; },
      set type(value: string) { category = value; categories.push(value); },
    };
    (navigator as any).audioSession = audioSession;
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("iphone15");
    const track = {
      id: "incoming-audio", kind: "audio", muted: true, enabled: true, readyState: "live",
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    room.onPeerStream(stream, "iphone15");
    await Promise.resolve();
    expect(category).toBe("play-and-record");
    recoverCallAudio();
    await Promise.resolve();
    expect(categories).toContain("auto");
    expect(categories.slice(-2)).toEqual(["auto", "play-and-record"]);
    const firstResetCount = categories.filter(type => type === "auto").length;
    recoverCallAudio();
    await Promise.resolve();
    expect(categories.filter(type => type === "auto")).toHaveLength(firstResetCount);
    expect(room.addStream).toHaveBeenCalledTimes(1);
    await hangup();
    expect(category).toBe("auto");
  });

  it("does not call a muted remote track healthy just because play resolves", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("peer");
    const listeners: Record<string, () => void> = {};
    const track = {
      muted: true, readyState: "live",
      addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
      removeEventListener: vi.fn(),
    };
    room.onPeerStream({ getAudioTracks: () => [track] } as unknown as MediaStream, "peer");
    await Promise.resolve();
    expect(useCallStore().audioStatus).toBe("waiting");
    track.muted = false;
    listeners.unmute();
    expect(useCallStore().audioStatus).toBe("playing");
    await hangup();
  });

  it.each([
    { scenario: "stale output", staleMuted: true, receiverMuted: false, packets: 198, corrected: true },
    { scenario: "healthy output", staleMuted: false, receiverMuted: false, packets: 198, corrected: false },
    { scenario: "muted receiver", staleMuted: true, receiverMuted: true, packets: 198, corrected: false },
    { scenario: "no incoming packets", staleMuted: true, receiverMuted: false, packets: 0, corrected: false },
  ])("only repairs a proven receiver mismatch: $scenario", async ({ staleMuted, receiverMuted, packets, corrected }) => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const stale = { id: "stale", kind: "audio", muted: staleMuted, readyState: "live" };
    const actual = { id: "actual", kind: "audio", muted: receiverMuted, readyState: "live" };
    vi.stubGlobal("MediaStream", class {
      constructor(private tracks: any[]) {}
      getAudioTracks() { return this.tracks; }
    });
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.peers.peer = {
      getReceivers: () => [{ track: actual }],
      getStats: async () => new Map([["audio", {
        type: "inbound-rtp", kind: "audio", trackIdentifier: "actual", packetsReceived: packets,
      }]]),
    };
    room.onPeerJoin("peer");
    room.onPeerStream({ getAudioTracks: () => [stale] } as unknown as MediaStream, "peer");
    await vi.advanceTimersByTimeAsync(4_050);
    const audio = mocks.audioElements.find(element => element.srcObject);
    expect(audio.srcObject.getAudioTracks()).toEqual([corrected ? actual : stale]);
    expect(room.addStream).toHaveBeenCalledOnce();
    await hangup();
  });

  it("offers an explicit output picker without renegotiating the WebRTC call", async () => {
    const { startCall, selectCallOutput, hangup } = await import("@/services/callEngine");
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("iphone15");
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
    room.onPeerStream(stream, "iphone15");
    await Promise.resolve();
    const audio = mocks.audioElements.find((element: any) => element.srcObject === stream);
    expect(audio).toBeTruthy();
    const setSinkId = vi.fn(async (id: string) => { audio.sinkId = id; });
    audio.setSinkId = setSinkId;
    (navigator.mediaDevices as any).selectAudioOutput = vi.fn(async () => ({ deviceId: "chosen-output" }));
    await selectCallOutput();
    expect((navigator.mediaDevices as any).selectAudioOutput).toHaveBeenCalledOnce();
    expect(setSinkId).toHaveBeenCalledWith("chosen-output");
    expect(room.addStream).toHaveBeenCalledTimes(1);
    await hangup();
  });

  it("does not rebind a healthy remote stream when the track unmutes", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND);
    const peer = mocks.rooms.at(-1);
    peer.onPeerJoin("iphone15");
    const listeners: Record<string, () => void> = {};
    const track = {
      muted: false, readyState: "live",
      addEventListener: vi.fn((name: string, fn: () => void) => { listeners[name] = fn; }),
      removeEventListener: vi.fn(),
    };
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    peer.onPeerStream(stream, "iphone15");
    await Promise.resolve();
    const audio = mocks.audioElements.find((candidate: any) => candidate.srcObject === stream);
    expect(audio).toBeTruthy();
    expect(useCallStore().audioStatus).toBe("playing");
    listeners.unmute();
    expect(audio.srcObject).toBe(stream);
    expect(audio.play).toHaveBeenCalledTimes(1);
    await hangup();
  });

  it("does not let a rejected playback promise revive a finished call", async () => {
    const { startCall, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND);
    const peer = mocks.rooms.at(-1);
    peer.onPeerJoin("iphone15");
    let rejectPlayback: ((error: Error) => void) | undefined;
    const play = vi.fn(() => new Promise<void>((_, reject) => { rejectPlayback = reject; }));
    (document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      autoplay: false, setAttribute: vi.fn(), style: {}, srcObject: null, play,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), remove: vi.fn(), pause: vi.fn(),
    }));
    peer.onPeerStream({ getAudioTracks: () => [] } as unknown as MediaStream, "iphone15");
    await hangup();
    rejectPlayback?.(new Error("late play failure"));
    await Promise.resolve();
    expect(useCallStore().phase).toBe("ended");
    expect(useCallStore().audioStatus).toBe("waiting");
  });

  it("uses the Trystero 0.26 room API to target media and handle peer lifecycle", async () => {
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce(localStream);

    await startCall(FRIEND);
    const store = useCallStore();
    const joined = mocks.rooms[0];
    expect(joined.makeAction).toHaveBeenCalledWith("taken", expect.objectContaining({ onMessage: expect.any(Function) }));
    expect(joined.onPeerJoin).toEqual(expect.any(Function));
    expect(joined.onPeerLeave).toEqual(expect.any(Function));
    expect(joined.onPeerStream).toEqual(expect.any(Function));

    joined.onPeerJoin("callee-device");
    expect(joined.addStream).toHaveBeenCalledWith(localStream, { target: "callee-device" });

    const remoteStream = {} as MediaStream;
    joined.onPeerStream(remoteStream, "callee-device");
    await Promise.resolve();
    expect(store.phase).toBe("active");
    expect(store.connectedAt).toBeGreaterThan(0);
    // Ringtone elements are created too; find the one playing the peer.
    expect(mocks.audioElements.find((audio: any) => audio.srcObject === remoteStream)).toMatchObject({ autoplay: true, srcObject: remoteStream });
    expect(mocks.audioElements.find((audio: any) => audio.srcObject === remoteStream).play).toHaveBeenCalled();

    joined.onPeerJoin("second-device");
    expect(joined.actions.taken.send).toHaveBeenCalledWith(true, { target: "second-device" });
    expect(joined.addStream).toHaveBeenCalledTimes(1);

    joined.onPeerLeave("callee-device");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(store.phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    expect(store).toMatchObject({ phase: "ended", endReason: "remote_hangup" });
    expect(joined.leave).toHaveBeenCalled();
  });

  it("lets only the caller reject a second answering device", async () => {
    const { acceptCall, handleCallSignal, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await handleCallSignal(FRIEND, ME, invite, now());
    await acceptCall();

    const joined = mocks.rooms[0];
    joined.onPeerJoin("caller-device");
    joined.onPeerJoin("other-answering-device");
    expect(joined.addStream).not.toHaveBeenCalled();
    joined.peers["caller-device"] = { signalingState: "stable" };
    joined.onPeerStream({} as MediaStream, "caller-device");
    expect(joined.addStream).toHaveBeenCalledTimes(1);
    expect(joined.actions.taken.send).not.toHaveBeenCalled();

    await joined.actions.taken.onMessage(true, { peerId: "caller-device" });
    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
    expect(joined.leave).toHaveBeenCalled();
    await hangup();
  });

  it("ignores a late decline or busy signal after another device connected", async () => {
    const { handleCallSignal, hangup, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await startCall(FRIEND);
    const store = useCallStore();
    const callId = store.callId;
    const joined = mocks.rooms[0];
    joined.onPeerJoin("answering-device");
    joined.onPeerStream({} as MediaStream, "answering-device");
    expect(store.phase).toBe("active");

    await handleCallSignal(FRIEND, ME, { action: "reject", callId }, now());
    await handleCallSignal(FRIEND, ME, { action: "busy", callId }, now());

    expect(store).toMatchObject({ phase: "active", callId });
    await hangup();
  });

  it("stops another device ringing when the accepting device already ended", async () => {
    const { handleCallSignal } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const callId = "6".repeat(32);
    await handleCallSignal(FRIEND, ME, { ...invite, callId }, now());

    await handleCallSignal(ME, FRIEND, { action: "end", callId, durationSeconds: 0 }, now());

    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
  });

  it("does not join or signal after the call is cancelled during relay preparation", async () => {
    let releaseRelay: (() => void) | undefined;
    mocks.relaySession.mockImplementationOnce(() => new Promise<void>(resolve => { releaseRelay = resolve; }));
    const { hangup, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");

    const starting = startCall(FRIEND);
    await vi.waitFor(() => expect(mocks.relaySession).toHaveBeenCalled());
    await hangup();
    releaseRelay?.();
    await starting;

    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "cancelled" });
    expect(mocks.rooms).toHaveLength(0);
    expect(sentActions()).toEqual(["cancel", "📞 语音通话 · 未接听"]);
  });

  it("stops a microphone stream that arrives after the caller already cancelled", async () => {
    let resolveMicrophone: ((stream: any) => void) | undefined;
    const stop = vi.fn();
    (navigator.mediaDevices.getUserMedia as any).mockImplementationOnce(() => new Promise(resolve => {
      resolveMicrophone = resolve;
    }));
    const { hangup, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");

    const starting = startCall(FRIEND);
    expect(useCallStore().phase).toBe("outgoing");
    await hangup();
    resolveMicrophone?.({ getTracks: () => [{ stop }], getAudioTracks: () => [] });
    await starting;

    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.rooms).toHaveLength(0);
    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "cancelled" });
  });

  it("stops a late microphone stream when an accepted call is hung up while permission is pending", async () => {
    let resolveMicrophone: ((stream: any) => void) | undefined;
    const stop = vi.fn();
    (navigator.mediaDevices.getUserMedia as any).mockImplementationOnce(() => new Promise(resolve => {
      resolveMicrophone = resolve;
    }));
    const { acceptCall, handleCallSignal, hangup } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    await handleCallSignal(FRIEND, ME, { ...invite, callId: "4".repeat(32) }, now());

    const accepting = acceptCall();
    expect(useCallStore().phase).toBe("connecting");
    await hangup();
    resolveMicrophone?.({ getTracks: () => [{ stop }], getAudioTracks: () => [] });
    await accepting;

    expect(stop).toHaveBeenCalledOnce();
    expect(mocks.rooms).toHaveLength(0);
    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "hangup" });
  });

  it("isolates a new call from callbacks and teardown belonging to the previous room", async () => {
    const firstStop = vi.fn();
    const secondStop = vi.fn();
    (navigator.mediaDevices.getUserMedia as any)
      .mockResolvedValueOnce({ getTracks: () => [{ stop: firstStop }], getAudioTracks: () => [] })
      .mockResolvedValueOnce({ getTracks: () => [{ stop: secondStop }], getAudioTracks: () => [] });
    const { hangup, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();

    await startCall(FRIEND);
    const firstRoom = mocks.rooms[0];
    firstRoom.onPeerJoin("first-peer");
    firstRoom.onPeerStream({} as MediaStream, "first-peer");
    const staleStream = firstRoom.onPeerStream;
    const staleLeave = firstRoom.onPeerLeave;
    const staleTaken = firstRoom.actions.taken.onMessage;
    await hangup();
    expect(firstStop).toHaveBeenCalledOnce();

    store.reset();
    await startCall(FRIEND);
    const secondCallId = store.callId;
    staleStream({} as MediaStream, "first-peer");
    staleLeave("first-peer");
    await staleTaken(true, { peerId: "first-peer" });

    expect(store).toMatchObject({ phase: "outgoing", callId: secondCallId });
    expect(secondStop).not.toHaveBeenCalled();
    await hangup();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("cleans up the microphone when creating the Trystero room fails", async () => {
    const stop = vi.fn();
    (navigator.mediaDevices.getUserMedia as any).mockResolvedValueOnce({
      getTracks: () => [{ stop }],
      getAudioTracks: () => [],
    });
    mocks.joinError = new Error("join_failed");
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");

    await startCall(FRIEND);

    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "failed" });
    expect(mocks.rooms).toHaveLength(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(sentActions()).toEqual(["📞 语音通话 · 未接通"]);
  });

  it("gives up after 45 s unanswered and leaves a missed-call record", async () => {
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await startCall(FRIEND);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(store).toMatchObject({ phase: "ended", endReason: "no_answer" });
    expect(sentActions()).toEqual(["invite", "cancel", "📞 语音通话 · 未接听"]);
    expect((mocks.send.mock.calls.at(-1) as any[])[0].tags).toContainEqual(["t", CALL_MISSED_TYPE]);
  });

  it("reports a denied microphone and only calls accepted friends", async () => {
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    (navigator as any).mediaDevices.getUserMedia = vi.fn(async () => { throw new Error("NotAllowedError"); });
    await startCall(FRIEND);
    expect(useCallStore()).toMatchObject({ phase: "ended", endReason: "microphone_denied" });
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.accepted = false;
    useCallStore().reset();
    await expect(startCall(FRIEND)).rejects.toThrow("只能和已接受的好友通话");
  });

  it("tells the caller the callee is ringing", async () => {
    const { handleCallSignal, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    // Callee side: a fresh invite rings and acknowledges.
    await handleCallSignal(FRIEND, ME, invite, now());
    expect(sentActions()).toContain("ringing");
    useCallStore().reset();
    mocks.send.mockClear();
    // Caller side: 正在呼叫 becomes 对方响铃中.
    await startCall(FRIEND);
    const store = useCallStore();
    expect(store.remoteRinging).toBe(false);
    await handleCallSignal(FRIEND, ME, { action: "ringing", callId: store.callId }, now());
    expect(store).toMatchObject({ phase: "outgoing", remoteRinging: true });
  });

  it("shows reconnecting when the peer drops, recovers on rejoin, ends after the grace", async () => {
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    room.onPeerJoin("peer-1");
    room.onPeerStream({} as MediaStream, "peer-1");
    expect(store.phase).toBe("active");
    room.onPeerLeave("peer-1");
    expect(store.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    room.onPeerJoin("peer-2");
    expect(store).toMatchObject({ phase: "active", reconnecting: false });
    room.onPeerLeave("peer-2");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store).toMatchObject({ phase: "ended", endReason: "remote_hangup" });
  });

  it("samples route, latency and loss while connected and flags a poor network", async () => {
    const { startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await startCall(FRIEND);
    const room = mocks.rooms.at(-1);
    let lost = 0;
    let received = 0;
    room.peers["peer-1"] = { getStats: async () => {
      lost += 10; received += 90;
      return new Map<string, any>([
        ["pair", { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.12, localCandidateId: "l", remoteCandidateId: "r" }],
        ["l", { candidateType: "relay" }], ["r", { candidateType: "srflx" }],
        ["in", { type: "inbound-rtp", kind: "audio", packetsLost: lost, packetsReceived: received, jitter: 0.01 }],
      ]);
    } };
    room.onPeerJoin("peer-1");
    room.onPeerStream({} as MediaStream, "peer-1");
    await vi.advanceTimersByTimeAsync(4_100);
    expect(store.quality).toBe("poor");
  });

  it("uses call-scoped tones, guarded output sessions and optional output switching", () => {
    const engine = readFileSync("src/services/callEngine.ts", "utf8");
    expect(engine).toContain('ringtoneElement("ringback");');
    expect(engine).toContain('const ownsPlaybackSession = kind === "ring" && !session.localStream;');
    expect(engine).toContain('if (previous !== type) native.type = type;');
    expect(engine).toContain('async function selectCallOutput()');
    expect(engine).toContain('if (audio.paused || store.audioStatus === "blocked")');
    expect(engine).toContain('navigator.mediaDevices?.addEventListener?.("devicechange"');
    const overlay = readFileSync("src/components/CallOverlay.vue", "utf8");
    expect(overlay).toContain('call.remoteRinging ? "对方响铃中…" : "正在呼叫…"');
    expect(overlay).toContain('call.direction === "outgoing" ? "重拨" : "回拨"');
    expect(readFileSync("src/views/Messages.vue", "utf8")).toContain('v-if="isCallRecord(message) && accepted" class="call-back-link"');
  });

  it("closes at once when you end the call, briefly shows why when the other side did", async () => {
    const { declineCall, handleCallSignal, startCall } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await handleCallSignal(FRIEND, ME, invite, now());
    await declineCall();
    await vi.advanceTimersByTimeAsync(600);
    expect(store.phase).toBe("idle");

    await startCall(FRIEND);
    await handleCallSignal(FRIEND, ME, { action: "reject", callId: store.callId }, now());
    await vi.advanceTimersByTimeAsync(600);
    expect(store).toMatchObject({ phase: "ended", endReason: "remote_declined" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.phase).toBe("idle");
  });

  it("shows an in-app incoming call as a banner and withdraws system notifications", () => {
    const overlay = readFileSync("src/components/CallOverlay.vue", "utf8");
    expect(overlay).toContain('const showBanner = computed(() => call.phase === "incoming" && !expanded.value);');
    expect(overlay).toContain('<div v-if="showBanner" class="call-banner"');
    const sw = readFileSync("public/service-worker.js", "utf8");
    expect(sw).toContain("for (const notification of await self.registration.getNotifications({ tag })) notification.close();");
    expect(readFileSync("src/services/callEngine.ts", "utf8")).toContain('signalCallNotification("INCOMING_RINGTONE_START", session.id);');
  });
});
