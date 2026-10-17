// Regression: Home could mount before keys.loadAccountStores unlocked the
// local vault. messages.load() then failed with local_vault_locked but kept
// loadedFor set, so every later load returned early and Home stayed blank.
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const mocks = vi.hoisted(() => ({ list: vi.fn(), outgoing: vi.fn(), purgeExpired: vi.fn() }));
vi.mock("@/repositories/syncedMessageRepository", () => ({
  syncedMessageRepository: { listRecent: mocks.list, insertMessageIfAbsent: vi.fn(), purgeExpiredDisappearing: mocks.purgeExpired },
}));
vi.mock("@/repositories/outgoingQueueRepository", () => ({ outgoingQueueRepository: { list: mocks.outgoing } }));

import { useMessagesStore } from "@/stores/messages";
import { db } from "@/db/dexie";
import { putDeviceValue } from "@/services/deviceStorage";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.purgeExpired.mockReset().mockResolvedValue(0);
  mocks.outgoing.mockReset().mockResolvedValue([]);
  mocks.list.mockReset();
});

describe("Home waits for the unlocked account", () => {
  it("lets a later messages.load retry after the vault was still locked", async () => {
    const record = {
      accountPubkey: ACCOUNT, id: "post-1", senderPubkey: OTHER, recipientPubkeys: [ACCOUNT], conversationId: "c",
      plaintext: "hello", createdAt: 100, protocol: "nip17", transportKind: 1059, transportEventIds: ["w"],
      tags: [["t", "hainei-post"]], firstSeenAt: 1, lastSeenAt: 1,
    };
    mocks.list.mockRejectedValueOnce(new Error("local_vault_locked")).mockResolvedValue([record]);
    const messages = useMessagesStore();

    await expect(messages.load(ACCOUNT)).rejects.toThrow("local_vault_locked");
    expect(messages.loadedFor).toBe("");

    await messages.load(ACCOUNT);
    expect(messages.loadedFor).toBe(ACCOUNT);
    expect(messages.inbox.map(item => item.id)).toEqual(["post-1"]);
  });

  it("initializes Home only once the key store reports the account's local stores ready", () => {
    const keys = readFileSync("src/stores/keys.ts", "utf8");
    expect(keys).toContain("this.accountStoresReadyFor = pk;");
    const reset = keys.slice(keys.indexOf("resetAccountStores(currentPk: string) {"), keys.indexOf("refreshAccounts()"));
    expect(reset).toContain('this.accountStoresReadyFor = "";');

    const home = readFileSync("src/views/Home.vue", "utf8");
    const init = home.slice(home.indexOf("async function initializeHomeWhenReady"), home.indexOf("onMounted(() => {"));
    expect(init).toContain("if (keys.accountStoresReadyFor !== accountPk) return;");
    expect(home).toContain("watch(() => keys.accountStoresReadyFor, () => { void initializeHomeWhenReady(); });");
  });

  it("drops late private device writes for a locked account instead of throwing", async () => {
    const account = "c".repeat(64);
    await db.open();
    await unlockLocalVault(account, "1".repeat(64));
    lockLocalVault(account);
    await expect(putDeviceValue(`nostr_connection_health_${account}`, "{}")).resolves.toBeUndefined();
    expect(await db.accountMeta.get([account, `private-device:nostr_connection_health_${account}`])).toBeUndefined();
  });
});
