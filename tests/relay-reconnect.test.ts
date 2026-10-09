import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
  MockWebSocket.instances = [];
  Reflect.deleteProperty(globalThis, "navigator");
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "document");
  Reflect.deleteProperty(globalThis, "WebSocket");
});
describe("relay reconnect", () => {
  it("warms a relay connection without subscriptions or duplicate sockets", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { inspectRelays, restoreRelayConnections, warmRelays } = await import("@/nostr/relays");
    warmRelays(["wss://warm.test"]);
    warmRelays(["wss://warm.test"]);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(inspectRelays()["wss://warm.test"].subs).toBe(0);
    restoreRelayConnections(["wss://warm.test"]);
    expect(MockWebSocket.instances).toHaveLength(1);
    MockWebSocket.instances[0].emit("open", {});
    restoreRelayConnections(["wss://warm.test"]);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("foreground restores a failed relay without duplicate sockets or losing subscriptions", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { inspectRelays, restoreRelayConnections, subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://exhausted.test"], [{ kinds: [1059] }]);
    MockWebSocket.instances[0].emit("close", {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    MockWebSocket.instances[1].emit("close", {});
    expect(inspectRelays()["wss://exhausted.test"]).toMatchObject({ state: "waiting-retry", reconnectAttempts: 2, subs: 1 });
    restoreRelayConnections(["wss://exhausted.test"]);
    restoreRelayConnections(["wss://exhausted.test"]);
    expect(MockWebSocket.instances).toHaveLength(3);
    expect(inspectRelays()["wss://exhausted.test"]).toMatchObject({ state: "connecting", reconnectAttempts: 2, subs: 1 });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(MockWebSocket.instances).toHaveLength(3);
    subscription.unsub();
    vi.restoreAllMocks();
  });

  it("does not flush an unsubscribed REQ when another subscription remains", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, inspectRelays } = await import("@/nostr/relays");
    const removed = subscribe(["wss://queued.test"], [{ kinds: [1] }]);
    const retained = subscribe(["wss://queued.test"], [{ kinds: [1059] }]);
    expect(MockWebSocket.instances).toHaveLength(1);
    removed.unsub();
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    const requests = socket.sent.map(item => JSON.parse(item)).filter(item => item[0] === "REQ");
    expect(requests).toHaveLength(1);
    expect(requests[0][2]).toMatchObject({ kinds: [1059] });
    expect(inspectRelays()["wss://queued.test"].subs).toBe(1);
    retained.unsub();
  });

  it("ignores late open and message events from a disposed socket", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, inspectRelays } = await import("@/nostr/relays");
    const oldSubscription = subscribe(["wss://replace.test"], [{ kinds: [1] }]);
    const staleSocket = MockWebSocket.instances[0];
    oldSubscription.unsub();
    const eventReceived = vi.fn();
    const currentSubscription = subscribe(["wss://replace.test"], [{ kinds: [1059] }]);
    currentSubscription.on("event", eventReceived);
    expect(MockWebSocket.instances).toHaveLength(2);
    staleSocket.emit("open", {});
    staleSocket.emit("message", { data: JSON.stringify(["EVENT", "obsolete", { id: "x" }]) });
    expect(inspectRelays()["wss://replace.test"].state).toBe("connecting");
    expect(staleSocket.sent).toHaveLength(0);
    expect(eventReceived).not.toHaveBeenCalled();
    const activeSocket = MockWebSocket.instances[1];
    activeSocket.emit("open", {});
    expect(inspectRelays()["wss://replace.test"].state).toBe("connected");
    expect(activeSocket.sent.map(item => JSON.parse(item)).filter(item => item[0] === "REQ")).toHaveLength(1);
    currentSubscription.unsub();
  });

  it("rejects a late open after connection timeout then replays the active REQ on a fresh socket", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, inspectRelays } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://timeout.test"], [{ kinds: [1059] }]);
    const first = MockWebSocket.instances[0];
    first.emit("open", {});
    const firstReq = first.sent.map(item => JSON.parse(item)).find(item => item[0] === "REQ");
    first.emit("close", {});
    await vi.advanceTimersByTimeAsync(1_000);
    const timedOut = MockWebSocket.instances[1];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inspectRelays()["wss://timeout.test"].state).toBe("waiting-retry");
    timedOut.emit("open", {});
    expect(inspectRelays()["wss://timeout.test"].state).toBe("waiting-retry");
    expect(timedOut.sent.filter(item => JSON.parse(item)[0] === "REQ")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    const third = MockWebSocket.instances[2];
    expect(third).toBeTruthy();
    third.emit("open", {});
    const replay = third.sent.map(item => JSON.parse(item)).filter(item => item[0] === "REQ");
    expect(replay).toHaveLength(1);
    expect(replay[0][1]).toBe(firstReq[1]);
    expect(inspectRelays()["wss://timeout.test"].state).toBe("connected");
    subscription.unsub();
  });

  it("preserves the REQ id across forced reconnect without accepting events from the replaced socket", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, reconnectRelay, inspectRelays } = await import("@/nostr/relays");
    const onEvent = vi.fn();
    const subscription = subscribe(["wss://forced.test"], [{ kinds: [1059] }]);
    subscription.on("event", onEvent);
    const old = MockWebSocket.instances[0];
    old.emit("open", {});
    const initial = old.sent.map(item => JSON.parse(item)).find(item => item[0] === "REQ");
    reconnectRelay("wss://forced.test");
    expect(MockWebSocket.instances).toHaveLength(2);
    old.emit("open", {});
    expect(inspectRelays()["wss://forced.test"].state).toBe("connecting");
    const current = MockWebSocket.instances[1];
    current.emit("open", {});
    const frames = current.sent.map(item => JSON.parse(item)).filter(item => item[0] === "REQ");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(initial);
    old.emit("message", { data: JSON.stringify(["EVENT", initial[1], { id: "stale" }]) });
    expect(onEvent).not.toHaveBeenCalled();
    current.emit("message", { data: JSON.stringify(["EVENT", initial[1], { id: "current" }]) });
    expect(onEvent).toHaveBeenCalledOnce();
    subscription.unsub();
  });

  it("backs off progressively on flapping sockets and resets after a stable connection", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, inspectRelays } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://flap.test"], [{ kinds: [1059] }]);
    const first = MockWebSocket.instances[0];
    first.emit("open", {});
    first.emit("close", {});
    expect(inspectRelays()["wss://flap.test"].reconnectAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const second = MockWebSocket.instances[1];
    second.emit("open", {});
    second.emit("close", {});
    expect(inspectRelays()["wss://flap.test"].reconnectAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const third = MockWebSocket.instances[2];
    third.emit("open", {});
    await vi.advanceTimersByTimeAsync(30_001);
    third.emit("close", {});
    expect(inspectRelays()["wss://flap.test"].reconnectAttempts).toBe(1);
    subscription.unsub();
  });

  it("caps repeated retry delays at 60 seconds even with maximum jitter", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { subscribe, inspectRelays } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://backoff-cap.test"], [{ kinds: [1059] }]);
    // 0.999 yields a 1.2495 jitter multiplier. Later backoff must still
    // never exceed the 60-second absolute cap.
    const expectedDelays = [1_250, 2_499, 4_998, 9_996, 19_992, 39_984, 60_000, 60_000];
    for (const [attempt, delay] of expectedDelays.entries()) {
      MockWebSocket.instances[attempt].emit("close", {});
      expect(inspectRelays()["wss://backoff-cap.test"].reconnectAttempts).toBe(attempt + 1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(MockWebSocket.instances).toHaveLength(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(attempt + 2);
    }
    subscription.unsub();
  });

  it("does not reconnect while navigator is offline", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    const network = { onLine: true };
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: network });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { restoreRelayConnections, subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://offline-resume.test"], [{ kinds: [1059] }]);
    network.onLine = false;
    MockWebSocket.instances[0].emit("close", {});
    restoreRelayConnections(["wss://offline-resume.test"]);
    expect(MockWebSocket.instances).toHaveLength(1);
    subscription.unsub();
  });

  it("reports connecting, connected, and retry-wait states separately", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { inspectRelays, subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://state.test"], [{ kinds: [1] }]);
    const socket = MockWebSocket.instances[0];
    expect(inspectRelays()["wss://state.test"].state).toBe("connecting");
    socket.emit("open", {});
    expect(inspectRelays()["wss://state.test"].state).toBe("connected");
    socket.emit("close", {});
    expect(inspectRelays()["wss://state.test"].state).toBe("waiting-retry");
    subscription.unsub();
  });

  it("moves a stalled connection into retry backoff", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { inspectRelays, subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://stalled.test"], [{ kinds: [1] }]);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(inspectRelays()["wss://stalled.test"].state).toBe("waiting-retry");
    subscription.unsub();
  });

  it("records connection, wire send, and relay OK for publish", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { publish } = await import("@/nostr/relays");
    const { useDebugLogsStore } = await import("@/stores/debugLogs");
    const event = { id: "e".repeat(64), kind: 1059, created_at: 123, tags: [["p", "b".repeat(64)]], content: "encrypted" };
    const resultPromise = publish(["wss://publish.test"], event);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    await vi.advanceTimersByTimeAsync(200);
    socket.emit("message", { data: JSON.stringify(["OK", event.id, true, "saved"]) });

    await expect(resultPromise).resolves.toMatchObject([{ relay: "wss://publish.test", ok: true }]);
    const entries = useDebugLogsStore().entries;
    expect(entries.map(entry => entry.event)).toEqual(expect.arrayContaining([
      "relay_connecting", "relay_connected", "publish_start", "publish_waiting_connection",
      "publish_connection_ready", "publish_event_sent", "publish_ok"
    ]));
    expect(JSON.stringify(entries)).not.toContain("encrypted");
  });

  it("records waited=false and socket state when connection and publish time out", async () => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { publish } = await import("@/nostr/relays");
    const { useDebugLogsStore } = await import("@/stores/debugLogs");
    const resultPromise = publish(["wss://offline.test"], {
      id: "f".repeat(64), kind: 1059, created_at: 123, tags: [["p", "b".repeat(64)]], content: "encrypted"
    });

    await vi.advanceTimersByTimeAsync(4300);
    await vi.advanceTimersByTimeAsync(5100);
    await expect(resultPromise).resolves.toMatchObject([{ relay: "wss://offline.test", ok: false, reason: "timeout" }]);
    const connectionTimeout = useDebugLogsStore().entries.find(entry => entry.event === "publish_connection_timeout");
    expect(connectionTimeout?.data).toMatchObject({ waited: false, ready: false, queueLength: 0, wsReadyState: 0 });
    expect(useDebugLogsStore().entries.map(entry => entry.event)).toContain("publish_timeout");
  });

  it("logs safe NIP-17 envelope metadata when a relay delivers kind 1059", async () => {
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { logger } = await import("@/utils/logger");
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    const { subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://relay.test"], [{ kinds: [1059], "#p": ["b".repeat(64)] }]);
    subscription.on("event", () => {});
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    const request = JSON.parse(socket.sent.find(payload => JSON.parse(payload)[0] === "REQ")!);
    socket.emit("message", { data: JSON.stringify([
      "EVENT",
      request[1],
      { id: "e".repeat(64), kind: 1059, created_at: 123, tags: [["p", "b".repeat(64)]], content: "secret" }
    ]) });

    expect(debug).toHaveBeenCalledWith("[relay] nip17_event", {
      relay: "wss://relay.test",
      subId: request[1],
      eventId: "e".repeat(12),
      recipient: "b".repeat(12),
      created_at: 123
    });
    expect(JSON.stringify(debug.mock.calls)).not.toContain("secret");
    subscription.unsub();
  });

  it("reclaims a warmed idle socket at 20s with no subscribers or publishing work", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { warmRelays, inspectRelays, IDLE_RELAY_TTL_MS, getRelayPerformanceDiagnostics } = await import("@/nostr/relays");
    warmRelays(["wss://warm-ttl.test"]);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    expect(inspectRelays()["wss://warm-ttl.test"]).toMatchObject({
      usage: "idle", subs: 0, pendingPublishes: 0,
      idleExpiresAt: Date.now() + IDLE_RELAY_TTL_MS,
    });
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS - 1);
    expect(inspectRelays()["wss://warm-ttl.test"]).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1);
    expect(inspectRelays()["wss://warm-ttl.test"]).toBeUndefined();
    expect(socket.readyState).toBe(3);
    expect(getRelayPerformanceDiagnostics().idleConnectionsReleased).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("never expires a subscribed realtime inbox, even if its EOSE timeout elapsed", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { warmRelays, subscribe, inspectRelays, IDLE_RELAY_TTL_MS } = await import("@/nostr/relays");
    warmRelays(["wss://receive.test"]);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    const first = subscribe(["wss://receive.test"], [{ kinds: [1059] }]);
    const second = subscribe(["wss://receive.test"], [{ kinds: [1] }]);
    expect(inspectRelays()["wss://receive.test"]).toMatchObject({ subs: 2, idleExpiresAt: null, usage: "subscription" });
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS * 3);
    expect(inspectRelays()["wss://receive.test"].subs).toBe(2);
    expect(socket.readyState).toBe(1);
    first.unsub();
    expect(inspectRelays()["wss://receive.test"].subs).toBe(1);
    second.unsub();
    expect(inspectRelays()["wss://receive.test"]).toBeUndefined();
  });

  it("cancels the warm TTL while publishing, and starts a new idle lease after OK", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { warmRelays, publish, inspectRelays, IDLE_RELAY_TTL_MS } = await import("@/nostr/relays");
    warmRelays(["wss://warm-publish.test"]);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS - 1_000);
    const evt = { id: "e".repeat(64), kind: 1059, tags: [["p", "b".repeat(64)]], content: "ciphertext" };
    const sending = publish(["wss://warm-publish.test"], evt);
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectRelays()["wss://warm-publish.test"]).toMatchObject({
      pendingPublishes: 1, idleExpiresAt: null, usage: "publishing",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(inspectRelays()["wss://warm-publish.test"].ready).toBe(true);
    socket.emit("message", { data: JSON.stringify(["OK", evt.id, true, "saved"]) });
    await expect(sending).resolves.toMatchObject([{ ok: true }]);
    expect(inspectRelays()["wss://warm-publish.test"]).toMatchObject({
      pendingPublishes: 0, usage: "idle", idleExpiresAt: Date.now() + IDLE_RELAY_TTL_MS,
    });
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS);
    expect(inspectRelays()["wss://warm-publish.test"]).toBeUndefined();
  });

  it("makes manual reconnect fail only ambiguous in-flight OKs and preserve active REQ identity", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { publish, subscribe, reconnectRelay, inspectRelays } = await import("@/nostr/relays");
    const sub = subscribe(["wss://manual-publish.test"], [{ kinds: [1059] }]);
    const first = MockWebSocket.instances[0];
    first.emit("open", {});
    const oldReq = first.sent.map(x => JSON.parse(x)).find(x => x[0] === "REQ");
    const evt = { id: "f".repeat(64), kind: 1059, tags: [["p", "a".repeat(64)]], content: "encrypted" };
    const sending = publish(["wss://manual-publish.test"], evt);
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectRelays()["wss://manual-publish.test"].okHandlers).toBe(1);
    reconnectRelay("wss://manual-publish.test");
    await expect(sending).resolves.toMatchObject([{ ok: false, reason: "relay_reconnected" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectRelays()["wss://manual-publish.test"]).toMatchObject({ subs: 1, pendingPublishes: 0, okHandlers: 0 });
    const current = MockWebSocket.instances[1];
    current.emit("open", {});
    const newReq = current.sent.map(x => JSON.parse(x)).find(x => x[0] === "REQ");
    expect(newReq).toEqual(oldReq);
    first.emit("message", { data: JSON.stringify(["OK", evt.id, true, "late"]) });
    expect(inspectRelays()["wss://manual-publish.test"].okHandlers).toBe(0);
    sub.unsub();
  });

  it("renews a warm socket idle deadline when manual reconnect starts near expiry", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { warmRelays, reconnectRelay, inspectRelays, IDLE_RELAY_TTL_MS } = await import("@/nostr/relays");
    warmRelays(["wss://renew.test"]);
    MockWebSocket.instances[0].emit("open", {});
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS - 100);
    reconnectRelay("wss://renew.test");
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectRelays()["wss://renew.test"].idleExpiresAt).toBe(Date.now() + IDLE_RELAY_TTL_MS);
    await vi.advanceTimersByTimeAsync(500);
    expect(inspectRelays()["wss://renew.test"]).toBeTruthy();
    await vi.advanceTimersByTimeAsync(IDLE_RELAY_TTL_MS);
    expect(inspectRelays()["wss://renew.test"]).toBeUndefined();
  });

  it("sends immediately after the socket opens without waiting for a 150ms readiness poll", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { publish, inspectRelays } = await import("@/nostr/relays");
    const evt = { id: "c".repeat(64), kind: 1059, tags: [["p", "a".repeat(64)]], content: "encrypted" };
    const sending = publish(["wss://instant.test"], evt);
    const socket = MockWebSocket.instances[0];
    socket.emit("open", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.map(x => JSON.parse(x)[0])).toContain("EVENT");
    expect(inspectRelays()["wss://instant.test"].pendingPublishes).toBe(1);
    socket.emit("message", { data: JSON.stringify(["OK", evt.id, true, "saved"]) });
    await expect(sending).resolves.toMatchObject([{ ok: true }]);
  });

  it("account teardown reclaims only unowned sockets and leaves active publishers subscribed or pending", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { warmRelays, subscribe, inspectRelays, releaseUnusedRelayConnections } = await import("@/nostr/relays");
    warmRelays(["wss://former-account.test", "wss://retained.test"]);
    const sub = subscribe(["wss://retained.test"], [{ kinds: [1059] }]);
    releaseUnusedRelayConnections();
    expect(inspectRelays()["wss://former-account.test"]).toBeUndefined();
    expect(inspectRelays()["wss://retained.test"].subs).toBe(1);
    sub.unsub();
    expect(inspectRelays()["wss://retained.test"]).toBeUndefined();
  });

  it("aborts a pre-OPEN publisher immediately when settings remove its Relay", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { publish, disconnectRelay, inspectRelays } = await import("@/nostr/relays");
    const evt = { id: "e".repeat(64), kind: 1059, tags: [["p", "b".repeat(64)]], content: "encrypted" };
    const pending = publish(["wss://removed-before-open.test"], evt);
    expect(inspectRelays()["wss://removed-before-open.test"].pendingPublishes).toBe(1);
    disconnectRelay("wss://removed-before-open.test");
    await expect(pending).resolves.toMatchObject([{ ok: false, reason: "disconnected" }]);
    expect(inspectRelays()["wss://removed-before-open.test"]).toBeUndefined();
  });

  it("explicit disconnect settles a pending encrypted publication instead of silently discarding it", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { publish, disconnectRelay, inspectRelays } = await import("@/nostr/relays");
    const evt = { id: "d".repeat(64), kind: 1059, tags: [["p", "a".repeat(64)]], content: "encrypted" };
    const sending = publish(["wss://abandon.test"], evt);
    const ws = MockWebSocket.instances[0];
    ws.emit("open", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(inspectRelays()["wss://abandon.test"].okHandlers).toBe(1);
    disconnectRelay("wss://abandon.test");
    await expect(sending).resolves.toMatchObject([{ ok: false, reason: "settings" }]);
    expect(inspectRelays()["wss://abandon.test"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("replays active REQ with the original subscription id", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { setTimeout, clearTimeout }
    });
    const { subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://relay.test"], [{ kinds: [1059] }]);
    const first = MockWebSocket.instances[0];
    first.emit("open", {});
    const firstRequest = JSON.parse(first.sent.find(payload => JSON.parse(payload)[0] === "REQ")!);

    first.emit("close", {});
    // Reconnect uses a 1-second first retry with deterministic jitter.
    // Do not advance past the 10-second connection-open deadline before opening it.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(2);
    const second = MockWebSocket.instances[1];
    second.emit("open", {});
    const replayPayload = second.sent.find(payload => JSON.parse(payload)[0] === "REQ");
    expect(replayPayload).toBeDefined();
    const replay = JSON.parse(replayPayload!);
    expect(replay[1]).toBe(firstRequest[1]);
    expect(replay.slice(2)).toEqual(firstRequest.slice(2));
    expect(second.sent.filter(payload => JSON.parse(payload)[0] === "REQ")).toHaveLength(1);
    // A late event from the closed socket must never revive the old generation.
    first.emit("open", {});
    expect(second.sent.filter(payload => JSON.parse(payload)[0] === "REQ")).toHaveLength(1);
    subscription.unsub();
    vi.restoreAllMocks();
  });
});
