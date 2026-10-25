import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeCallNotification, triggerGenericPush } from "@/services/pushNotifications";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@/services/deviceStorage", () => ({ deviceStorage: { getItem: (key: string) => storage.get(key) ?? null } }));
vi.mock("@/services/workerAuth", () => ({
  signedWorkerPost: (_sign: unknown, _account: unknown, options: any) => options.send(options.payload),
}));
const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const MESSAGE = "c".repeat(64);
const sign = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage.set(`hainei_push_enabled_${ACCOUNT}`, "1");
  vi.stubGlobal("window", { PushManager: {}, Notification: {}, location: { origin: "https://app.test" } });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({
    pushManager: { getSubscription: async () => ({ endpoint: "https://web.push.apple.com/device" }) },
  }) } });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ acknowledged: true, accepted: true })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); storage.clear(); });

describe("visible call claim and bounded call retries", () => {
  it("claims only the current visible call and includes the exact device endpoint", async () => {
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/push\/call-handled$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      endpoint: "https://web.push.apple.com/device", senderPubkey: PEER, messageId: MESSAGE,
    });
  });

  it("does not suppress an alert while hidden, after account/call change, or without a subscription", async () => {
    (document as any).visibilityState = "hidden";
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    (document as any).visibilityState = "visible";
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => false);
    (navigator as any).serviceWorker.ready = Promise.resolve({ pushManager: { getSubscription: async () => null } });
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks visibility after asynchronous subscription lookup", async () => {
    (navigator as any).serviceWorker.ready = Promise.resolve({ pushManager: { getSubscription: async () => {
      (document as any).visibilityState = "hidden";
      return { endpoint: "https://web.push.apple.com/device" };
    } } });
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed call request once with the same ID, without retrying ordinary messages here", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "push_delivery_failed" }), { status: 503 }));
    const pending = triggerGenericPush([PEER], ACCOUNT, sign, "call", MESSAGE);
    await vi.advanceTimersByTimeAsync(501);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).messageId)).toEqual([MESSAGE, MESSAGE]);
    fetchMock.mockClear().mockResolvedValue(new Response(JSON.stringify({ error: "push_delivery_failed" }), { status: 503 }));
    await expect(triggerGenericPush([PEER], ACCOUNT, sign, "message", MESSAGE)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry once the caller has cancelled or the call has already been handled", async () => {
    vi.useFakeTimers();
    let calling = true;
    fetchMock.mockImplementation(async () => {
      calling = false;
      return new Response(JSON.stringify({ error: "push_delivery_failed" }), { status: 503 });
    });
    const pending = triggerGenericPush([PEER], ACCOUNT, sign, "call", MESSAGE, [], () => calling);
    await vi.advanceTimersByTimeAsync(501);
    await pending;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
