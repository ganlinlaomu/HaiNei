import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, reactive } from "vue";

const ACCOUNT = "a".repeat(64);
const keys = reactive({ pkHex: ACCOUNT, isUnlocked: true, supportsNip44: true, sessionGeneration: 1, accountStoresReadyFor: "" });
const records: any[] = [];
const sync = { schedulePrivateSpaceSync: vi.fn(), syncPrivateSpace: vi.fn(async () => undefined), subscribePrivateSpaceSync: vi.fn(() => () => undefined) };
vi.mock("@/stores/keys", () => ({ useKeyStore: () => keys }));
vi.mock("@/repositories/privateSpaceRepository", () => ({ privateSpaceRepository: { list: vi.fn(async () => records) } }));
vi.mock("@/services/privateSpaceSync", () => sync);
vi.mock("@/utils/debugLog", () => ({ startupMark: vi.fn() }));

const sharedList = { accountPubkey: ACCOUNT, id: "l", kind: "todo", title: "", body: "", tasks: [{ id: "t", text: "洗碗", done: false }],
  pinned: false, createdAt: 1, updatedAt: 1, revision: 1, share: { owner: ACCOUNT, members: [ACCOUNT, "b".repeat(64)] } };

async function settle() {
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(0); await nextTick(); }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { visibilityState: "visible" });
  Object.assign(keys, { pkHex: ACCOUNT, isUnlocked: true, sessionGeneration: 1, accountStoresReadyFor: "" });
  records.length = 0;
  vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Home pulls shared to-do lists", () => {
  it("syncs once when the account is ready, even on a cold start without a resume event", async () => {
    const { usePrivateFeedCards } = await import("@/composables/usePrivateFeedCards");
    const scope = effectScope();
    scope.run(() => usePrivateFeedCards(() => undefined));
    await settle();
    expect(sync.schedulePrivateSpaceSync).not.toHaveBeenCalled(); // friendships not loaded yet
    keys.accountStoresReadyFor = ACCOUNT;
    await settle();
    expect(sync.schedulePrivateSpaceSync).toHaveBeenCalledTimes(1);
    keys.isUnlocked = false; await settle(); keys.isUnlocked = true; await settle();
    expect(sync.schedulePrivateSpaceSync).toHaveBeenCalledTimes(1); // same session
    scope.stop();
  });

  it("polls every minute while Home is visible, only when a shared list exists", async () => {
    const { usePrivateFeedCards } = await import("@/composables/usePrivateFeedCards");
    keys.accountStoresReadyFor = ACCOUNT;
    const scope = effectScope();
    const feed = scope.run(() => usePrivateFeedCards(() => undefined))!;
    await settle();
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(sync.syncPrivateSpace).not.toHaveBeenCalled();

    records.push(sharedList);
    await feed.reload();
    expect(feed.todos.value[0]).toMatchObject({ text: "洗碗", shared: true });
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(sync.syncPrivateSpace).toHaveBeenCalledTimes(1);

    vi.stubGlobal("document", { visibilityState: "hidden" });
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(sync.syncPrivateSpace).toHaveBeenCalledTimes(1);
    scope.stop();
    vi.stubGlobal("document", { visibilityState: "visible" });
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(sync.syncPrivateSpace).toHaveBeenCalledTimes(1); // stopped with Home
  });
});
