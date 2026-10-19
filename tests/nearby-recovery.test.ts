import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createPinia, setActivePinia } from "pinia";

const trystero = vi.hoisted(() => ({ sockets: {} as Record<string, unknown>, rooms: [] as any[] }));
vi.mock("trystero", () => ({
  selfId: "local-test-id",
  getRelaySockets: () => trystero.sockets,
  joinRoom: vi.fn((_config, _id, callbacks) => {
    const room = {
      callbacks, config: _config, id: _id,
      actions: {} as Record<string, any>,
      makeAction(name: string, handlers: unknown) {
        const action = { handlers, send: vi.fn(async () => {}), request: vi.fn(async () => false) };
        this.actions[name] = action;
        return action;
      },
      leave: vi.fn(async () => {}), getPeers: () => ({}), onPeerJoin: (_id: string) => {},
    };
    trystero.rooms.push(room);
    return room;
  }),
}));

import { NearbyRoom, nearbyRelayStates, refreshNearbyRelaySockets } from "@/services/nearbyTransfer";
import { answerPendingOffer, clearNearbyTransfer, ensureOwnDevicesRoom, nearbyState, refreshNearbyDiscovery, resetNearby, retryNearbyWithCamera, startPairRoom } from "@/services/nearbySession";

class Socket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); });
  respond(type = "EOSE") {
    const request = this.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(([type]) => type === "REQ");
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify([type, request[1]]) }));
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("RTCPeerConnection", class extends EventTarget {});
  trystero.rooms.length = 0;
  trystero.sockets = {};
});
afterEach(async () => { await resetNearby(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function startProbe(socket: Socket) {
  trystero.sockets = { relay: socket };
  const pending = refreshNearbyRelaySockets();
  if (socket.readyState === Socket.OPEN) await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
  return { pending };
}

describe("nearby signaling recovery", () => {
  it("auto-accepts own-account batches but requires confirmation in a QR room", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const offer = { id: "0123456789abcdef", files: [{ name: "a.txt", size: 3, type: "text/plain" }] };
    const own = trystero.rooms[0];
    own.onPeerJoin("own-peer");
    expect(await own.actions.offer.handlers.onRequest(offer, { peerId: "own-peer" })).toBe(true);
    expect(nearbyState.pendingOffer).toBeNull();
    expect(nearbyState.transfers[0].state).toBe("active");
    const metadata = { offerId: offer.id, index: 0 };
    expect(own.actions.file.handlers.onReceive({ peerId: "other", metadata, byteLength: 3 })).toBe(false);
    expect(own.actions.file.handlers.onReceive({ peerId: "own-peer", metadata, byteLength: 4 })).toBe(false);
    expect(own.actions.file.handlers.onReceive({ peerId: "own-peer", metadata, byteLength: 3 })).toBe(true);
    own.actions.file.handlers.onMessage(new Uint8Array([1, 2, 3]).buffer, { peerId: "own-peer", metadata });
    expect(nearbyState.transfers[0].state).toBe("done");
    expect(nearbyState.transfers[0].files[0].name).toBe("a.txt");
    expect(own.actions.file.handlers.onReceive({ peerId: "own-peer", metadata, byteLength: 3 })).toBe(false);
    await startPairRoom({ roomId: "qr", password: "qr-secret" });
    const pair = trystero.rooms[1];
    pair.onPeerJoin("pair-peer");
    const request = pair.actions.offer.handlers.onRequest(offer, { peerId: "pair-peer" });
    expect(nearbyState.pendingOffer?.transferId).toBe(`pair:${offer.id}`);
    answerPendingOffer(true);
    expect(await request).toBe(true);
  });

  it("reserves aggregate receive memory, rejects duplicate batches, and releases cleared files", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const own = trystero.rooms[0];
    own.onPeerJoin("peer");
    const offer = { id: "0123456789abcdef", files: [{ name: "large", size: 700 * 1024 * 1024 }] };
    expect(await own.actions.offer.handlers.onRequest(offer, { peerId: "peer" })).toBe(true);
    expect(await own.actions.offer.handlers.onRequest(offer, { peerId: "peer" })).toBe(false);
    const second = { ...offer, id: "1123456789abcdef" };
    expect(await own.actions.offer.handlers.onRequest(second, { peerId: "peer" })).toBe(false);
    own.onPeerLeave("peer");
    expect(nearbyState.transfers[0].state).toBe("failed");
    clearNearbyTransfer(nearbyState.transfers[0].id);
    expect(nearbyState.transfers).toHaveLength(0);
    own.onPeerJoin("peer");
    expect(await own.actions.offer.handlers.onRequest(second, { peerId: "peer" })).toBe(true);
    await resetNearby();
    expect(nearbyState.transfers).toHaveLength(0);
    expect(await own.actions.offer.handlers.onRequest(offer, { peerId: "peer" })).toBe(false);
  });
  it("closes camera capture before rebuilding the same automatic room with fresh ICE", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const previous = trystero.rooms[0];
    previous.leave.mockImplementation(async () => { expect(stop).toHaveBeenCalledOnce(); });
    // The explicit camera retry must also replace a PC still checking with the
    // old candidate policy; no need to wait for another 23-second timeout.
    expect(await retryNearbyWithCamera(new AbortController().signal)).toBe(true);
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ video: true, audio: false });
    expect(trystero.rooms).toHaveLength(2);
    expect(trystero.rooms[1].id).toBe(previous.id);
    expect(trystero.rooms[1].config.password).toBe(previous.config.password);
  });

  it("never requests camera access during startup or an ordinary search", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    await refreshNearbyDiscovery();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps the current room when camera permission is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    await expect(retryNearbyWithCamera(new AbortController().signal)).rejects.toThrow("Denied");
    expect(trystero.rooms[0].leave).not.toHaveBeenCalled();
  });

  it.each(["page closed", "account changed"])("releases a late camera grant without restarting after %s", async reason => {
    let grant!: (stream: any) => void;
    const getUserMedia = vi.fn(() => new Promise(resolve => { grant = resolve; }));
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const controller = new AbortController();
    const pending = retryNearbyWithCamera(controller.signal);
    if (reason === "page closed") controller.abort();
    else await ensureOwnDevicesRoom("other-account", "2".repeat(64));
    const roomCount = trystero.rooms.length;
    const stop = vi.fn();
    grant({ getTracks: () => [{ stop }] });
    expect(await pending).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(trystero.rooms).toHaveLength(roomCount);
  });

  it("creates only one automatic room when startup and page entry overlap", async () => {
    await Promise.all([
      ensureOwnDevicesRoom("account", "1".repeat(64)),
      ensureOwnDevicesRoom("account", "1".repeat(64)),
    ]);
    expect(trystero.rooms).toHaveLength(1);
  });

  it("does not join after logout while the secret room key is being derived", async () => {
    let finishDigest!: (value: ArrayBuffer) => void;
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; }));
    try {
      const joining = ensureOwnDevicesRoom("account", "1".repeat(64));
      await vi.waitFor(() => expect(digest).toHaveBeenCalled());
      await resetNearby();
      finishDigest(new Uint8Array(32).buffer);
      await joining;
      expect(trystero.rooms).toHaveLength(0);
      expect(nearbyState.ownAccount).toBe("");
    } finally {
      digest.mockRestore();
    }
  });

  it("shows an authentication rejection without retaining the relay payload", async () => {
    const socket = new Socket();
    trystero.sockets = { relay: socket };
    await nearbyRelayStates();
    socket.dispatchEvent(new MessageEvent("message", { data: '["CLOSED","sub","auth-required: private-server-detail"]' }));
    const states = await nearbyRelayStates();
    expect(states.relays[0].rejection).toBe("Relay 要求认证，附近传输未认证");
    expect(JSON.stringify(states)).not.toContain("private-server-detail");
  });

  it("actually rebuilds a failed automatic room when searching again", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const previous = trystero.rooms[0];
    previous.callbacks.onJoinError({ error: "could not connect to peer old after exchanging SDP" });
    await refreshNearbyDiscovery();
    expect(previous.leave).toHaveBeenCalledOnce();
    expect(trystero.rooms).toHaveLength(2);
    expect(trystero.rooms[1].id).toBe(previous.id);
    expect(nearbyState.ownError).toBe("");
  });

  it("never rebuilds a room with a connected device because a different peer failed", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const previous = trystero.rooms[0];
    previous.onPeerJoin("connected-peer");
    previous.callbacks.onJoinError({ error: "could not connect to peer other" });
    await refreshNearbyDiscovery();
    expect(previous.leave).not.toHaveBeenCalled();
    expect(trystero.rooms).toHaveLength(1);
  });

  it("does not restart an old account after a relay probe overlaps logout", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    trystero.rooms[0].callbacks.onJoinError({ error: "could not connect to peer old" });
    const socket = new Socket();
    trystero.sockets = { relay: socket };
    const refresh = refreshNearbyDiscovery();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalled());
    await resetNearby();
    socket.respond();
    await refresh;
    expect(trystero.rooms).toHaveLength(1);
    expect(nearbyState.ownAccount).toBe("");
  });

  it("preserves a responsive OPEN socket, and coalesces concurrent refreshes", async () => {
    const socket = new Socket();
    const { pending } = await startProbe(socket);
    expect(refreshNearbyRelaySockets()).toBe(pending);
    socket.respond();
    expect(await pending).toBe(0);
    expect(socket.close).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0])[0]).toBe("CLOSE");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only recycles an OPEN socket that fails the application-level probe", async () => {
    const socket = new Socket();
    const { pending } = await startProbe(socket);
    await vi.advanceTimersByTimeAsync(7000);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toBe(1);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not abort a CONNECTING socket", async () => {
    const socket = new Socket();
    socket.readyState = 0;
    const { pending } = await startProbe(socket);
    expect(await pending).toBe(0);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("ignores unrelated EOSE, and stops probing a socket closed by the library", async () => {
    const socket = new Socket();
    const { pending } = await startProbe(socket);
    socket.dispatchEvent(new MessageEvent("message", { data: '["EOSE","another-sub"]' }));
    socket.close();
    expect(await pending).toBe(0);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts with the same room key, and ignores errors from the old negotiation", async () => {
    const onError = vi.fn();
    const room = new NearbyRoom("phone", { onPeers: vi.fn(), onError, onOffer: async () => false, onReceiveProgress: vi.fn(), onFile: vi.fn() });
    const key = { roomId: "room", password: "secret" };
    await room.join(key);
    const first = trystero.rooms[0];
    await room.restart();
    expect(first.leave).toHaveBeenCalledOnce();
    expect(trystero.rooms).toHaveLength(2);
    expect(trystero.rooms[1].id).toBe(key.roomId);
    expect(trystero.rooms[1].config.password).toBe(key.password);
    first.callbacks.onJoinError({ error: "old failure" });
    expect(onError).not.toHaveBeenCalled();
    trystero.rooms[1].callbacks.onJoinError({ error: "current failure" });
    expect(onError).toHaveBeenCalledWith("current failure");
    await room.leave();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cannot resurrect an old room if logout happens during restart", async () => {
    const room = new NearbyRoom("phone", { onPeers: vi.fn(), onError: vi.fn(), onOffer: async () => false, onReceiveProgress: vi.fn(), onFile: vi.fn() });
    await room.join({ roomId: "old", password: "secret" });
    let finishLeave!: () => void;
    trystero.rooms[0].leave.mockImplementationOnce(() => new Promise<void>(resolve => { finishLeave = resolve; }));
    const restart = room.restart();
    await room.leave();
    finishLeave();
    await restart;
    expect(trystero.rooms).toHaveLength(1);
  });

  it("confirms the installed transport silently drops candidates while a socket is reconnecting", async () => {
    const source = readFileSync("node_modules/@trystero-p2p/nostr/dist/index.mjs", "utf8");
    const body = source.slice(source.indexOf("const publishMessage ="), source.indexOf("const retrySubscription ="));
    const publish = Function("retiredRelays", "canPublishAnnouncement", "batchers", "getRelayBackoffMs", "createEvent", "steadyAnnounceIntervalMs", "nextAnnounce", "stopAnnouncing", `${body}; return publishMessage;`)(
      new WeakSet(), () => true, {}, () => 0, async () => "candidate-event", 60000, (value: number) => value, {},
    );
    const client = { url: "relay", isClosed: false, socket: { readyState: 0 }, send: vi.fn() };
    await publish(client, "peer-topic", "encrypted-candidate", false);
    expect(client.send).not.toHaveBeenCalled();
    client.socket.readyState = 1;
    await publish(client, "peer-topic", "encrypted-candidate", false);
    expect(client.send).toHaveBeenCalledWith("candidate-event");
  });
});
