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
import { answerPendingOffer, cancelNearbyTransfer, clearNearbyTransfer, ensureOwnDevicesRoom, nearbyState, queueNearbyFiles, refreshNearbyDiscovery, resetNearby, retryNearbyTransfer, retryNearbyWithCamera, sendNearbyFiles, startPairRoom } from "@/services/nearbySession";
import { NEARBY_CHUNK_BYTES, chunkDigest } from '@/services/nearbyChunks';

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
  async function modernRoom() {
    await ensureOwnDevicesRoom('account', '1'.repeat(64));
    const room = trystero.rooms[0];
    room.onPeerJoin('peer');
    room.actions.hello.handlers.onMessage({ name: 'PC', reply: true, text: true, protocol: 2 }, { peerId: 'peer' });
    for (const name of ['offer', 'chunk2', 'control2']) room.actions[name].request.mockImplementation(async (value: any, options: any) => {
      const handlers = room.actions[name].handlers;
      const byteLength = value instanceof Blob ? value.size : new TextEncoder().encode(JSON.stringify(value)).length;
      if (handlers.onReceive && !await handlers.onReceive({ kind: 'request', peerId: 'peer', metadata: options.metadata, byteLength })) throw new Error('request rejected');
      const response = await handlers.onRequest(value, { peerId: 'peer', metadata: options.metadata });
      // Trystero uses the same admission handler for responses, without request metadata.
      if (handlers.onReceive && !await handlers.onReceive({ kind: 'response', peerId: 'peer', byteLength: JSON.stringify(response).length })) throw new Error('response rejected');
      return response;
    });
    return room;
  }

  it('waits for receiver completion, serializes queued batches and can cancel a queued item', async () => {
    const room = await modernRoom();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const control = room.actions.control2.request.getMockImplementation();
    room.actions.control2.request.mockImplementation(async (value: any, options: any) => {
      if (value.op === 'complete') await gate;
      return control(value, options);
    });
    const first = queueNearbyFiles('own', 'peer', [new File(['abc'], 'a.txt')]);
    const second = queueNearbyFiles('own', 'peer', [], 'second');
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === first)?.state).toBe('verifying'));
    expect(nearbyState.transfers.find(item => item.id === second)?.state).toBe('queued');
    expect(room.actions.offer.request).toHaveBeenCalledOnce();
    cancelNearbyTransfer(second);
    release();
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === first)?.state).toBe('done'));
    expect(nearbyState.transfers.find(item => item.id === first)?.deliveryConfirmed).toBe(true);
    expect(nearbyState.transfers.find(item => item.id === second)?.state).toBe('canceled');
    expect(room.actions.offer.request).toHaveBeenCalledOnce();
  });

  it('continues the same offer from acknowledged offsets on reconnect without duplicate records', async () => {
    const room = await modernRoom();
    const original = room.actions.chunk2.request.getMockImplementation();
    room.actions.chunk2.request.mockImplementationOnce(async (value: any, options: any) => {
      await original(value, options);
      room.onPeerLeave('peer');
      throw new Error('connection lost after ack');
    });
    const id = queueNearbyFiles('own', 'peer', [new File([new Uint8Array(NEARBY_CHUNK_BYTES + 3)], 'large.bin')]);
    const queued = queueNearbyFiles('own', 'peer', [], 'after reconnect');
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === id)?.state).toBe('paused'));
    expect(nearbyState.transfers.find(item => item.id === queued)?.state).toBe('paused');
    expect(nearbyState.transfers.filter(item => item.direction === 'in')).toHaveLength(1);
    room.onPeerJoin('peer');
    room.actions.hello.handlers.onMessage({ name: 'PC', reply: true, text: true, protocol: 2 }, { peerId: 'peer' });
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === id)?.state).toBe('done'));
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === queued)?.state).toBe('done'));
    expect(room.actions.chunk2.request).toHaveBeenCalledTimes(2);
    expect(room.actions.chunk2.request.mock.calls[1][1].metadata.offset).toBe(NEARBY_CHUNK_BYTES);
    expect(nearbyState.transfers).toHaveLength(4);
    expect(nearbyState.transfers.every(item => item.state === 'done')).toBe(true);
  });

  it('retains source files for a failed attempt and retries without repeating delivered bytes', async () => {
    const room = await modernRoom();
    room.actions.control2.request.mockRejectedValueOnce(new Error('temporary error'));
    const id = queueNearbyFiles('own', 'peer', [new File(['abc'], 'a.txt')]);
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === id)?.state).toBe('failed'));
    const wireId = nearbyState.transfers.find(item => item.id === id)?.wireId;
    retryNearbyTransfer(id);
    await vi.waitFor(() => expect(nearbyState.transfers.find(item => item.id === id)?.state).toBe('done'));
    expect(nearbyState.transfers.find(item => item.id === id)?.wireId).toBe(wireId);
    expect(nearbyState.transfers).toHaveLength(2);
  });

  it('clears the queue and aborts the active request on account reset', async () => {
    const room = await modernRoom();
    let signal!: AbortSignal;
    room.actions.offer.request.mockImplementation((_offer: any, options: any) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('canceled', 'AbortError')), { once: true }));
    });
    const pending = sendNearbyFiles('own', 'peer', [], 'first');
    queueNearbyFiles('own', 'peer', [], 'queued');
    await resetNearby();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(nearbyState.transfers).toEqual([]);
    expect(room.actions.offer.request).toHaveBeenCalledOnce();
  });

  it('preserves partial chunks across same-room discovery restart but releases them on leave', async () => {
    const onOffer = vi.fn(async () => true), onResume = vi.fn();
    const room = new NearbyRoom('phone', { onPeers: vi.fn(), onError: vi.fn(), onOffer, onResume, onReceiveProgress: vi.fn(), onFile: vi.fn() });
    await room.join({ roomId: 'resume', password: 'secret' });
    const offer = { id: '0123456789abcdef', files: [{ name: 'a', size: NEARBY_CHUNK_BYTES + 1, type: 'application/octet-stream' }], protocol: 2 };
    const first = trystero.rooms[0];
    expect(await first.actions.offer.handlers.onRequest(offer, { peerId: 'peer' })).toBe(true);
    const bytes = new Uint8Array(NEARBY_CHUNK_BYTES);
    await first.actions.chunk2.handlers.onRequest(bytes.buffer, { peerId: 'peer', metadata: { id: offer.id, index: 0, offset: 0, hash: chunkDigest(bytes) } });
    await room.restart();
    const second = trystero.rooms[1];
    expect(await second.actions.offer.handlers.onRequest(offer, { peerId: 'peer' })).toBe(true);
    expect(onOffer).toHaveBeenCalledOnce();
    expect(onResume).toHaveBeenCalledWith(offer.id, 'peer');
    expect(second.actions.control2.handlers.onRequest({ id: offer.id, index: 0, op: 'status' }, { peerId: 'peer' })).toBe(NEARBY_CHUNK_BYTES);
    await room.leave();
    await room.join({ roomId: 'other', password: 'other' });
    expect(() => trystero.rooms[2].actions.control2.handlers.onRequest({ id: offer.id, index: 0, op: 'status' }, { peerId: 'peer' })).toThrow('unknown_transfer');
    await room.leave();
  });

  it('honors receiver cancellation and never marks a late result delivered', async () => {
    const room = await modernRoom();
    let finishOffer!: (ok: boolean) => void;
    room.actions.offer.request.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishOffer = resolve; }));
    const id = queueNearbyFiles('own', 'peer', [], 'pending');
    const record = nearbyState.transfers.find(item => item.id === id)!;
    room.actions.cancel2.handlers.onMessage({ id: record.wireId }, { peerId: 'other' });
    expect(record.state).toBe('waiting');
    room.actions.cancel2.handlers.onMessage({ id: record.wireId }, { peerId: 'peer' });
    expect(record.state).toBe('canceled');
    finishOffer(true);
    await vi.waitFor(() => expect(record.deliveryConfirmed).not.toBe(true));
    expect(record.state).toBe('canceled');
  });

  it("receives text as a completed own-account message and clears it on account reset", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const own = trystero.rooms[0];
    own.onPeerJoin("peer");
    const offer = { id: "0123456789abcdef", files: [], text: "第一行\n第二行" };
    expect(await own.actions.offer.handlers.onRequest(offer, { peerId: "peer" })).toBe(true);
    expect(nearbyState.pendingOffer).toBeNull();
    expect(nearbyState.transfers[0]).toMatchObject({ text: offer.text, files: [], state: "done" });
    await resetNearby();
    expect(nearbyState.transfers).toEqual([]);
  });

  it("requires QR-peer confirmation for text, with no phantom active file transfer", async () => {
    await startPairRoom({ roomId: "qr", password: "secret" });
    const pair = trystero.rooms[0];
    pair.onPeerJoin("peer");
    const offer = { id: "0123456789abcdef", files: [], text: "hello" };
    const request = pair.actions.offer.handlers.onRequest(offer, { peerId: "peer" });
    expect(nearbyState.transfers[0].state).toBe("waiting");
    answerPendingOffer(true);
    expect(await request).toBe(true);
    expect(nearbyState.transfers[0].state).toBe("done");
  });

  it("negotiates text capability, sends one combined offer, and keeps legacy file-only sending", async () => {
    await ensureOwnDevicesRoom("account", "1".repeat(64));
    const own = trystero.rooms[0];
    own.onPeerJoin("peer");
    own.actions.hello.handlers.onMessage({ name: "PC", reply: true }, { peerId: "peer" });
    own.actions.offer.request.mockResolvedValue(true);
    await expect(sendNearbyFiles("own", "peer", [], "hello")).rejects.toThrow("nearby_text_unsupported");
    const file = new File(["a"], "a.txt");
    await sendNearbyFiles("own", "peer", [file]);
    expect(own.actions.file.send).toHaveBeenCalledOnce();
    own.actions.hello.handlers.onMessage({ name: "PC", reply: true, text: true }, { peerId: "peer" });
    await sendNearbyFiles("own", "peer", [], "hello\nworld");
    expect(own.actions.offer.request.mock.calls.at(-1)[0]).toMatchObject({ files: [], text: "hello\nworld" });
    expect(own.actions.file.send).toHaveBeenCalledOnce();
    expect(nearbyState.transfers[0]).toMatchObject({ text: "hello\nworld", state: "done" });
    await sendNearbyFiles("own", "peer", [file], "caption");
    expect(own.actions.offer.request.mock.calls.at(-1)[0]).toMatchObject({ files: [{ name: "a.txt", size: 1 }], text: "caption" });
    expect(own.actions.file.send).toHaveBeenCalledTimes(2);
    own.onPeerLeave("peer");
    expect(nearbyState.ownTextPeers).toEqual({});
  });
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
