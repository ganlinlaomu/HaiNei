import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ME = "a".repeat(64);
const FRIEND = "b".repeat(64);
const accepted = { accountPubkey: ME, peerPubkey: FRIEND, state: "accepted", acceptedAt: 1, acceptedWindows: [] };
let release: () => void = () => undefined;
const list = vi.fn(() => new Promise<any[]>(resolve => { release = () => resolve([accepted]); }));

vi.mock("@/repositories/friendshipRepository", () => ({ friendshipRepository: { list: () => list() } }));
vi.mock("@/repositories/outgoingQueueRepository", () => ({ outgoingQueueRepository: { get: async () => undefined } }));

import { useFriendshipsStore } from "@/stores/friendships";

describe("friendship records while they load", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    list.mockClear();
  });

  it("a second load joins the running one instead of clearing it", async () => {
    const store = useFriendshipsStore();
    const first = store.load(ME);
    const second = store.load(ME);
    expect(list).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(store.isAccepted(FRIEND)).toBe(true);
  });

  it("ensureLoaded waits for the records, not just for loadedFor", async () => {
    const store = useFriendshipsStore();
    void store.load(ME);
    // The race behind "only my own messages after opening the app":
    // loadedFor already names the account while the list is still empty.
    expect(store.loadedFor).toBe(ME);
    expect(store.getRecord(FRIEND)).toBeUndefined();
    let ready = false;
    const waiting = store.ensureLoaded(ME).then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await waiting;
    expect(store.getRecord(FRIEND)?.state).toBe("accepted");
  });

  it("ensureLoaded does not fail its caller when the read fails", async () => {
    const store = useFriendshipsStore();
    list.mockImplementationOnce(() => Promise.reject(new Error("idb closed")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // "Unknown", not "not a friend": callers must not cache or decide on it.
    await expect(store.ensureLoaded(ME)).resolves.toBe(false);
    release = () => undefined;
    list.mockImplementationOnce(async () => [accepted]);
    await expect(store.ensureLoaded(ME)).resolves.toBe(true);
    expect(store.isAccepted(FRIEND)).toBe(true);
    warn.mockRestore();
  });
});
