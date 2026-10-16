import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  readyState = 0;
  private listeners: Record<string, Array<(event: any) => void>> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(name: string, callback: (event: any) => void) {
    (this.listeners[name] ||= []).push(callback);
  }

  send(payload: string) { this.sent.push(payload); }
  close() { this.emit("close", {}); }
  emit(name: string, event: any) {
    if (name === "open") this.readyState = 1;
    if (name === "close") this.readyState = 3;
    this.listeners[name]?.forEach(callback => callback(event));
  }
  frames(type: string) {
    return this.sent.map(item => JSON.parse(item)).filter(item => item[0] === type);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  MockWebSocket.instances = [];
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "WebSocket");
});

async function openSubscribedRelay(url: string) {
  const relays = await import("@/nostr/relays");
  const subscription = relays.subscribe([url], [{ kinds: [1059] }]);
  const socket = MockWebSocket.instances[0];
  socket.emit("open", {});
  const [req] = socket.frames("REQ");
  socket.emit("message", { data: JSON.stringify(["EOSE", req[1]]) });
  return { relays, subscription, socket };
}

describe("relay liveness", () => {
  it("replaces a quiet socket that still reports OPEN but answers nothing after resume", async () => {
    const { relays, subscription, socket } = await openSubscribedRelay("wss://zombie.test");
    await vi.advanceTimersByTimeAsync(relays.LIVENESS_QUIET_MS);

    relays.restoreRelayConnections(["wss://zombie.test"]);
    const probe = socket.frames("REQ").find(frame => String(frame[1]).startsWith("probe_"));
    expect(probe?.[2]).toEqual({ kinds: [0], limit: 0 });
    expect(MockWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(relays.LIVENESS_PROBE_TIMEOUT_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
    const fresh = MockWebSocket.instances[1];
    fresh.emit("open", {});
    // The live subscription is replayed on the replacement socket.
    expect(fresh.frames("REQ").map(frame => frame[2])).toEqual([{ kinds: [1059] }]);
    subscription.unsub();
  });

  it("keeps a quiet socket that answers the probe and closes the probe REQ", async () => {
    const { relays, subscription, socket } = await openSubscribedRelay("wss://alive.test");
    await vi.advanceTimersByTimeAsync(relays.LIVENESS_QUIET_MS);

    relays.restoreRelayConnections(["wss://alive.test"]);
    const probe = socket.frames("REQ").find(frame => String(frame[1]).startsWith("probe_"))!;
    socket.emit("message", { data: JSON.stringify(["EOSE", probe[1]]) });
    await vi.advanceTimersByTimeAsync(relays.LIVENESS_PROBE_TIMEOUT_MS * 2);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.frames("CLOSE").map(frame => frame[1])).toContain(probe[1]);
    expect(relays.inspectRelays()["wss://alive.test"].state).toBe("connected");
    subscription.unsub();
  });

  it("does not probe a socket that received traffic recently", async () => {
    const { relays, subscription, socket } = await openSubscribedRelay("wss://busy.test");
    await vi.advanceTimersByTimeAsync(relays.LIVENESS_QUIET_MS - 1_000);

    relays.restoreRelayConnections(["wss://busy.test"]);
    expect(socket.frames("REQ").some(frame => String(frame[1]).startsWith("probe_"))).toBe(false);
    subscription.unsub();
  });

  it("probes and replaces an OPEN socket when a subscription gets no EOSE", async () => {
    const relays = await import("@/nostr/relays");
    const subscription = relays.subscribe(["wss://silent.test"], [{ kinds: [1059] }]);
    const failure = vi.fn();
    subscription.on("failure", failure);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});

    await vi.advanceTimersByTimeAsync(8_000);
    expect(failure).toHaveBeenCalledWith("wss://silent.test", "timeout");
    expect(socket.frames("REQ").some(frame => String(frame[1]).startsWith("probe_"))).toBe(true);

    await vi.advanceTimersByTimeAsync(relays.LIVENESS_PROBE_TIMEOUT_MS);
    expect(MockWebSocket.instances).toHaveLength(2);
    subscription.unsub();
  });
});
