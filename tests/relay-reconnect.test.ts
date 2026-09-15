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
});
describe("relay reconnect", () => {
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
