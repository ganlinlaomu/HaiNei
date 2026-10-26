import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeCallNotification, clearCallHandledChallenge, prefetchCallHandledChallenge, triggerGenericPush } from "@/services/pushNotifications";
import { signWorkerRequest, signedWorkerPost } from "@/services/workerAuth";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@/services/deviceStorage", () => ({ deviceStorage: { getItem: (key: string) => storage.get(key) ?? null } }));
vi.mock("@/services/workerAuth", () => ({
  signedWorkerPost: vi.fn((_sign: unknown, _account: unknown, options: any) => options.send(options.payload)),
  signWorkerRequest: vi.fn(async () => ({ pubkey: "a".repeat(64), id: "signed-call-event" })),
}));
const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);
const MESSAGE = "c".repeat(64);
const sign = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearCallHandledChallenge();
  vi.clearAllMocks();
  storage.set(`hainei_push_enabled_${ACCOUNT}`, "1");
  vi.stubGlobal("window", { PushManager: {}, Notification: {}, location: { origin: "https://app.test" } });
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("navigator", { serviceWorker: { ready: Promise.resolve({
    pushManager: { getSubscription: async () => ({ endpoint: "https://web.push.apple.com/device" }) },
  }) } });
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ acknowledged: true, accepted: true })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { clearCallHandledChallenge(); vi.useRealTimers(); vi.unstubAllGlobals(); storage.clear(); });

describe("visible call claim and bounded call retries", () => {
  it("claims only the current visible call and includes the exact device endpoint", async () => {
    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/push\/call-handled$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      endpoint: "https://web.push.apple.com/device", senderPubkey: PEER, messageId: MESSAGE,
    });
  });


  it("uses a prewarmed, unconsumed challenge to acknowledge a visible call in one network request", async () => {
    const challenge = "d".repeat(64);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      challenge, expiresAt: Math.floor(Date.now() / 1000) + 300,
    }), { status: 201 }));
    expect(await prefetchCallHandledChallenge(ACCOUNT)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/auth\/challenge$/);
    fetchMock.mockClear();

    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/push\/call-handled$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      challenge, endpoint: "https://web.push.apple.com/device", senderPubkey: PEER, messageId: MESSAGE,
    });
    expect(signWorkerRequest).toHaveBeenCalledOnce();
    expect(signedWorkerPost).not.toHaveBeenCalled();
  });

  it("discards an expired prefetched challenge and falls back to the existing authorization flow", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T08:00:00Z"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      challenge: "e".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 30,
    }), { status: 201 }));
    expect(await prefetchCallHandledChallenge(ACCOUNT)).toBe(true);
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(31_000);

    await acknowledgeCallNotification(ACCOUNT, sign, PEER, MESSAGE, () => true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("challenge");
    expect(signedWorkerPost).toHaveBeenCalledOnce();
    expect(signWorkerRequest).not.toHaveBeenCalled();
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
