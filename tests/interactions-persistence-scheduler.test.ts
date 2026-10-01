import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  const scheduled = new Map<string, () => void | Promise<void>>();
  return {
    values,
    scheduled,
    putDeviceValue: vi.fn<(key: string, value: string) => Promise<void>>(),
    cancelBackgroundTask: vi.fn((key: string) => { scheduled.delete(key); }),
    scheduleBackgroundTask: vi.fn((key: string, run: () => void | Promise<void>) => {
      scheduled.set(key, run);
      return () => scheduled.delete(key);
    }),
    key: {
      pkHex: "",
      isLoggedIn: true,
      supportsNip44: true,
      nip44Encrypt: vi.fn(),
      signEvent: vi.fn(),
    },
    friendships: {
      loadedFor: "",
      load: vi.fn(),
      isAccepted: vi.fn(() => true),
    },
    send: vi.fn(),
  };
});

vi.mock("@/services/deviceStorage", () => ({
  deviceStorage: {
    getItem: (key: string) => mocks.values.get(key) ?? null,
    setItem: (key: string, value: string) => { mocks.values.set(key, String(value)); },
    removeItem: (key: string) => { mocks.values.delete(key); },
    key: () => null,
    get length() { return mocks.values.size; },
  },
  putDeviceValue: mocks.putDeviceValue,
}));

vi.mock("@/services/backgroundWorkScheduler", () => ({
  scheduleBackgroundTask: mocks.scheduleBackgroundTask,
  cancelBackgroundTask: mocks.cancelBackgroundTask,
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/stores/friendships", () => ({ useFriendshipsStore: () => mocks.friendships }));
vi.mock("@/nostr/relays", () => ({ getRelaysFromStorage: () => ["wss://relay.test"] }));
vi.mock("@/nostr/messaging/service", () => ({ sendDirectMessage: mocks.send }));

import {
  INTERACTION_SAVE_DEBOUNCE_MS,
  INTERACTION_SAVE_MAX_WAIT_MS,
  useInteractionsStore,
  type Comment,
} from "@/stores/interactions";
import { prepareAccountLock } from "@/services/accountLifecycle";

let accountIndex = 0;

function nextAccount() {
  const digit = ((accountIndex++ % 8) + 1).toString(16);
  return digit.repeat(64);
}

function addComment(store: ReturnType<typeof useInteractionsStore>, id: string, text = id) {
  const comment: Comment = {
    id,
    messageId: "post",
    author: store.loadedFor,
    text,
    timestamp: Date.now(),
    type: "comment",
  };
  store._addInteraction(comment);
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromiseQueue() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.values.clear();
  mocks.scheduled.clear();
  mocks.putDeviceValue.mockResolvedValue(undefined);
  setActivePinia(createPinia());
  const account = nextAccount();
  mocks.key.pkHex = account;
  mocks.friendships.loadedFor = account;
  useInteractionsStore().loadedFor = account;
});

describe("interaction persistence scheduling", () => {
  it("coalesces quiet changes into one idle save", async () => {
    const store = useInteractionsStore();
    addComment(store, "one");
    addComment(store, "two");

    expect(mocks.putDeviceValue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERACTION_SAVE_DEBOUNCE_MS);
    expect(mocks.scheduled.size).toBe(1);
    expect(mocks.putDeviceValue).not.toHaveBeenCalled();

    await mocks.scheduled.values().next().value?.();
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(mocks.putDeviceValue.mock.calls[0][1]);
    expect(payload.interactions.post).toHaveLength(2);
  });

  it("forces a save after the maximum wait during continuous updates", async () => {
    const store = useInteractionsStore();

    for (let index = 0; index < 8; index += 1) {
      addComment(store, `continuous-${index}`);
      await vi.advanceTimersByTimeAsync(Math.floor(INTERACTION_SAVE_DEBOUNCE_MS / 2));
    }

    expect(mocks.putDeviceValue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERACTION_SAVE_MAX_WAIT_MS);
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalled();
  });

  it("serializes same-account writes so an older snapshot cannot overwrite a newer one", async () => {
    const store = useInteractionsStore();
    const firstWrite = deferred();
    const secondWrite = deferred();
    mocks.putDeviceValue
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    addComment(store, "first");
    const firstFlush = store._flushToStorage();
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalledTimes(1);

    addComment(store, "second");
    const secondFlush = store._flushToStorage();
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalledTimes(1);

    firstWrite.resolve();
    await firstFlush;
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalledTimes(2);

    const older = JSON.parse(mocks.putDeviceValue.mock.calls[0][1]);
    const newer = JSON.parse(mocks.putDeviceValue.mock.calls[1][1]);
    expect(older.interactions.post).toHaveLength(1);
    expect(newer.interactions.post).toHaveLength(2);

    secondWrite.resolve();
    await secondFlush;
  });

  it("flushes the current account before account-lock cleanup and keeps account writes separated", async () => {
    const store = useInteractionsStore();
    const firstAccount = store.loadedFor;
    const lockWrite = deferred();
    mocks.putDeviceValue.mockImplementationOnce(() => lockWrite.promise);

    addComment(store, "before-lock");
    let lockFinished = false;
    const locking = prepareAccountLock(firstAccount).then(() => { lockFinished = true; });
    await flushPromiseQueue();
    expect(mocks.putDeviceValue).toHaveBeenCalledTimes(1);
    expect(lockFinished).toBe(false);

    lockWrite.resolve();
    await locking;
    expect(lockFinished).toBe(true);

    store.reset(false);
    const secondAccount = nextAccount();
    store.loadedFor = secondAccount;
    mocks.key.pkHex = secondAccount;
    mocks.friendships.loadedFor = secondAccount;
    mocks.putDeviceValue.mockResolvedValue(undefined);
    addComment(store, "after-switch");
    await store._flushToStorage();

    expect(mocks.putDeviceValue.mock.calls[0][0]).toBe(`interactions_${firstAccount}`);
    expect(mocks.putDeviceValue.mock.calls.at(-1)?.[0]).toBe(`interactions_${secondAccount}`);
    const firstPayload = JSON.parse(mocks.putDeviceValue.mock.calls[0][1]);
    expect(JSON.stringify(firstPayload)).not.toContain("after-switch");
  });
});
