import "fake-indexeddb/auto";
import Dexie from "dexie";
import { createPinia, setActivePinia } from "pinia";
import { isProxy, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);
const PEER = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  key: { pkHex: "a".repeat(64), supportsNip44: true },
  scheduleAccountStateSync: vi.fn(),
}));

vi.mock("@/stores/keys", () => ({ useKeyStore: () => mocks.key }));
vi.mock("@/services/accountStateSync", () => ({
  scheduleAccountStateSync: mocks.scheduleAccountStateSync,
}));

import { db, HaiNeiDatabase, type FriendshipRecord } from "@/db/dexie";
import { FriendRepository, friendRepository } from "@/repositories/friendRepository";
import { FriendshipRepository } from "@/repositories/friendshipRepository";
import { useFriendsStore } from "@/stores/friends";

let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function createDatabase() {
  const database = new HaiNeiDatabase(`hainei-friend-clone-${sequence++}`);
  databases.push(database);
  return database;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.key.pkHex = ACCOUNT;
  setActivePinia(createPinia());
  await db.open();
  await db.accountFriends.clear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const active = databases.splice(0);
  const names = active.map(database => database.name);
  active.forEach(database => database.close());
  await Promise.all(names.map(name => Dexie.delete(name)));
});

describe("friend IndexedDB clone boundaries", () => {
  it("persists reactive friend groups as plain serializable data", async () => {
    const database = createDatabase();
    const repository = new FriendRepository(database);
    const friend = reactive({
      pubkey: PEER,
      name: "朋友",
      group: "家人",
      groups: reactive(["家人", "同学"]),
      note: "备注",
      updatedAt: 123,
      deleted: false,
    });

    await expect(repository.put(ACCOUNT, friend)).resolves.toBeTruthy();
    const stored = await repository.get(ACCOUNT, PEER);
    expect(stored).toEqual({
      accountPubkey: ACCOUNT,
      pubkey: PEER,
      name: "朋友",
      group: "家人",
      groups: ["家人", "同学"],
      note: "备注",
      updatedAt: 123,
      deleted: false,
    });
    expect(isProxy(stored)).toBe(false);
    expect(isProxy(stored?.groups)).toBe(false);
    expect(() => structuredClone(stored)).not.toThrow();
  });

  it("persists reactive accepted windows as plain serializable data", async () => {
    const database = createDatabase();
    const repository = new FriendshipRepository(database);
    const record = reactive<FriendshipRecord>({
      accountPubkey: ACCOUNT,
      peerPubkey: PEER,
      state: "accepted",
      requestEventId: "request",
      acceptedEventId: "accept",
      requestedAt: 10,
      acceptedAt: 20,
      acceptedWindows: reactive([{
        acceptedAt: 20,
        acceptedEventId: "accept",
        endedAt: 30,
        endedEventId: "remove",
      }]),
      lastAction: "remove",
      lastControlAt: 30,
      lastControlEventId: "remove",
      updatedAt: 30_000,
    });

    await expect(repository.put(record)).resolves.toBeTruthy();
    const stored = await repository.get(ACCOUNT, PEER);
    expect(stored).toEqual({
      accountPubkey: ACCOUNT,
      peerPubkey: PEER,
      state: "accepted",
      requestEventId: "request",
      acceptedEventId: "accept",
      requestedAt: 10,
      acceptedAt: 20,
      acceptedWindows: [{
        acceptedAt: 20,
        acceptedEventId: "accept",
        endedAt: 30,
        endedEventId: "remove",
      }],
      lastAction: "remove",
      lastControlAt: 30,
      lastControlEventId: "remove",
      updatedAt: 30_000,
    });
    expect(isProxy(stored)).toBe(false);
    expect(isProxy(stored?.acceptedWindows)).toBe(false);
    expect(isProxy(stored?.acceptedWindows?.[0])).toBe(false);
    expect(() => structuredClone(stored)).not.toThrow();
  });

  it("schedules the D1 friend metadata snapshot only after IndexedDB persistence", async () => {
    const order: string[] = [];
    const originalPut = friendRepository.put.bind(friendRepository);
    vi.spyOn(friendRepository, "put").mockImplementation(async (account, friend) => {
      const result = await originalPut(account, friend);
      order.push("persisted");
      return result;
    });
    mocks.scheduleAccountStateSync.mockImplementation(() => { order.push("scheduled"); });

    const friends = useFriendsStore();
    friends.loadedFor = ACCOUNT;
    expect(friends.add(reactive({ pubkey: PEER, name: "朋友", groups: reactive(["家人"]) }))).toBe(true);

    await vi.waitFor(() => expect(mocks.scheduleAccountStateSync).toHaveBeenCalledWith(
      mocks.key,
      "friend_metadata"
    ));
    expect(order).toEqual(["persisted", "scheduled"]);
    expect(await db.accountFriends.get([ACCOUNT, PEER])).toMatchObject({ groups: ["家人"] });
  });
});
