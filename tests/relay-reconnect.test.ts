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

  it("foreground immediately resets exhausted retries and preserves one subscription", async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: MockWebSocket });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: true } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout, addEventListener: vi.fn() } });
    const { inspectRelays, restoreRelayConnections, subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://exhausted.test"], [{ kinds: [1059] }]);
    MockWebSocket.instances[0].emit("close", {});
    await vi.advanceTimersByTimeAsync(1_000);
    MockWebSocket.instances[1].emit("close", {});
    await vi.advanceTimersByTimeAsync(2_000);
    MockWebSocket.instances[2].emit("close", {});
    await vi.advanceTimersByTimeAsync(2_000);
    MockWebSocket.instances[3].emit("close", {});
    expect(inspectRelays()["wss://exhausted.test"]).toMatchObject({ state: "disconnected", reconnectAttempts: 3, subs: 1 });

    restoreRelayConnections(["wss://exhausted.test"]);
    expect(MockWebSocket.instances).toHaveLength(5);
    expect(inspectRelays()["wss://exhausted.test"]).toMatchObject({ state: "connecting", reconnectAttempts: 0, subs: 1 });
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

  it("replays active REQ with the original subscription id", async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(30_100);
    const second = MockWebSocket.instances[1];
    expect(second).toBeTruthy();
    second.emit("open", {});
    const replay = JSON.parse(second.sent.find(payload => JSON.parse(payload)[0] === "REQ")!);
    expect(replay[1]).toBe(firstRequest[1]);
    expect(replay.slice(2)).toEqual(firstRequest.slice(2));
    subscription.unsub();
  });
});
