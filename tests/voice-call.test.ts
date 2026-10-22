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
  accepted: true,
}));
vi.mock("@/nostr/messaging/service", async original => ({ ...(await original() as object), sendDirectMessage: mocks.send }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/services/nearbyTransfer", () => ({ prepareNearbyRelaySession: async () => undefined }));
vi.mock("@/services/relaySession", () => ({ turnIceServers: async () => [] }));
vi.mock("@/stores/keys", () => ({ useKeyStore: () => ({ pkHex: ME, nip44Encrypt: vi.fn(), signEvent: vi.fn() }) }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => ({ isAccepted: () => mocks.accepted }) }));
vi.mock("trystero", () => ({
  joinRoom: (config: any, id: string) => {
    const room = { config, id, leave: vi.fn(), addStream: vi.fn(), onPeerJoin: vi.fn(), onPeerLeave: vi.fn(), onPeerStream: vi.fn(), makeAction: () => [vi.fn(), vi.fn()] };
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
    expect(sw).toContain("event.data?.type === 'CLOSE_CALL_NOTIFICATION'");
  });

  it("keeps call code out of startup: lazy engine and overlay", () => {
    const app = readFileSync("src/App.vue", "utf8");
    expect(app).toContain('defineAsyncComponent(() => import("@/components/CallOverlay.vue"))');
    expect(app).toContain(`<CallOverlay v-if="call.phase !== 'idle'" />`);
    expect(readFileSync("src/stores/call.ts", "utf8")).toContain('return import("@/services/callEngine");');
    expect(readFileSync("src/services/accountMessageSync.ts", "utf8")).toContain("void loadCallEngine()");
  });
});

describe("call engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    mocks.send.mockClear();
    mocks.rooms.length = 0;
    mocks.accepted = true;
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [], getAudioTracks: () => [] })) } });
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
    expect(sentActions()).toEqual(["busy"]);
    expect(store.callId).toBe("2".repeat(32));
  });

  it("stops ringing when another of our devices answers", async () => {
    const { handleCallSignal } = await import("@/services/callEngine");
    const { useCallStore } = await import("@/stores/call");
    const store = useCallStore();
    await handleCallSignal(FRIEND, ME, invite, now());
    await handleCallSignal(ME, FRIEND, { action: "accept", callId: CALL_ID }, now());
    expect(store).toMatchObject({ phase: "ended", endReason: "answered_elsewhere" });
    expect(mocks.send).not.toHaveBeenCalled();
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
    const log = (mocks.send.mock.calls.at(-1) as any[])[0];
    expect(log.content).toBe("📞 语音通话 · 已拒绝");
    expect(log.tags).toEqual([["t", "hainei-dm"], ["t", CALL_LOG_TYPE]]);
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
});
