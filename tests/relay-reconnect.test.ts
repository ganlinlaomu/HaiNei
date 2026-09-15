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
