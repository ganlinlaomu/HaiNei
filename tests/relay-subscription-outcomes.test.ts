import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event?: any) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(name: string, listener: Listener) {
    const list = this.listeners.get(name) || [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  emit(name: string, event?: any) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit("open");
  }

  subscriptionId() {
    const request = this.sent.map(item => JSON.parse(item)).find(item => item[0] === "REQ");
    return request?.[1];
  }
}

describe("relay subscription completion outcomes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    MockWebSocket.instances = [];
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function activeSubscription() {
    const { subscribe } = await import("@/nostr/relays");
    const subscription = subscribe(["wss://relay.test"], [{ kinds: [1059] }]);
    const socket = MockWebSocket.instances[0];
    socket.open();
    const subId = socket.subscriptionId();
    expect(subId).toBeTruthy();
    return { subscription, socket, subId };
  }

  it("treats only protocol EOSE as successful completion", async () => {
    const { subscription, socket, subId } = await activeSubscription();
    const eose = vi.fn();
    const failure = vi.fn();
    subscription.on("eose", eose);
    subscription.on("failure", failure);

    socket.emit("message", { data: JSON.stringify(["EOSE", subId]) });

    expect(eose).toHaveBeenCalledWith("wss://relay.test");
    expect(failure).not.toHaveBeenCalled();
    subscription.unsub();
  });

  it("reports CLOSED without synthesizing EOSE", async () => {
    const { subscription, socket, subId } = await activeSubscription();
    const eose = vi.fn();
    const failure = vi.fn();
    subscription.on("eose", eose);
    subscription.on("failure", failure);

    socket.emit("message", { data: JSON.stringify(["CLOSED", subId, "blocked"]) });

    expect(failure).toHaveBeenCalledWith("wss://relay.test", "closed");
    expect(eose).not.toHaveBeenCalled();
    subscription.unsub();
  });

  it("reports disconnect without synthesizing EOSE", async () => {
    const { subscription, socket } = await activeSubscription();
    const eose = vi.fn();
    const failure = vi.fn();
    subscription.on("eose", eose);
    subscription.on("failure", failure);

    socket.close();

    expect(failure).toHaveBeenCalledWith("wss://relay.test", "disconnected");
    expect(eose).not.toHaveBeenCalled();
    subscription.unsub();
  });

  it("reports EOSE timeout as timeout failure", async () => {
    const { subscription } = await activeSubscription();
    const eose = vi.fn();
    const failure = vi.fn();
    subscription.on("eose", eose);
    subscription.on("failure", failure);

    await vi.advanceTimersByTimeAsync(8_000);

    expect(failure).toHaveBeenCalledWith("wss://relay.test", "timeout");
    expect(eose).not.toHaveBeenCalled();
    subscription.unsub();
  });
});
