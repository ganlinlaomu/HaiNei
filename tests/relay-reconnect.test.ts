import { afterEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  sent: string[] = [];
  private listeners: Record<string, Array<(event: any) => void>> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(name: string, callback: (event: any) => void) {
    (this.listeners[name] ||= []).push(callback);
  }

  send(payload: string) { this.sent.push(payload); }
  close() { this.emit("close", {}); }
  emit(name: string, event: any) { this.listeners[name]?.forEach(callback => callback(event)); }
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  MockWebSocket.instances = [];
});
describe("relay reconnect", () => {
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
    await vi.advanceTimersByTimeAsync(2000);
    const second = MockWebSocket.instances[1];
    expect(second).toBeTruthy();
    second.emit("open", {});
    const replay = JSON.parse(second.sent.find(payload => JSON.parse(payload)[0] === "REQ")!);
    expect(replay[1]).toBe(firstRequest[1]);
    expect(replay.slice(2)).toEqual(firstRequest.slice(2));
    subscription.unsub();
  });
});
