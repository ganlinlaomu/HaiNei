import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { useKeyStore } from "@/stores/keys";
import { NEARBY_HISTORY_MAX_RECORDS, canStoreHistory, loadHistory, loadHistoryFile, putHistoryFile, putHistoryRecord, type StoredTransfer } from "@/services/nearbyHistory";
import { clearNearbyTransfer, nearbyState, resetNearby, restoreNearbyHistory } from "@/services/nearbySession";

const account = "ab".repeat(32);
const record = (id: string, createdAt: number, patch: Partial<StoredTransfer> = {}): StoredTransfer => ({
  id, kind: "own", direction: "in", peerName: "Mac", createdAt, state: "done",
  files: [{ name: "a.bin", size: 3, type: "application/octet-stream" }], stored: [true], ...patch,
});

beforeEach(async () => {
  setActivePinia(createPinia());
  useKeyStore().pkHex = account;
  await unlockLocalVault(account, "1".repeat(64));
});
afterEach(async () => {
  await resetNearby();
  await db.transferRecords.clear();
  await db.transferFileParts.clear();
  lockLocalVault(account);
});

describe("encrypted transfer history", () => {
  it("seals received files in bounded slices and restores identical bytes", { timeout: 30_000 }, async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024 + 5).map((_, index) => index % 251);
    expect(await putHistoryFile(account, "own:1", 0, new File([bytes], "big.bin", { type: "application/x-test" }))).toBe(true);
    const parts = await db.transferFileParts.where("[accountPubkey+recordId]").equals([account, "own:1"]).toArray();
    expect(parts.map(part => part.size).sort((a, b) => a - b)).toEqual([5, 4 * 1024 * 1024]);
    expect(new Uint8Array(parts[0].bytes).slice(0, 64)).not.toEqual(bytes.slice(0, 64));
    const restored = await loadHistoryFile(account, "own:1", 0, "big.bin", "application/x-test");
    expect(restored?.type).toBe("application/x-test");
    expect(Buffer.from(await restored!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
  });

  it("stores nothing and reads nothing while the vault is locked", async () => {
    lockLocalVault(account);
    expect(canStoreHistory(account)).toBe(false);
    expect(await putHistoryFile(account, "own:2", 0, new File(["x"], "x"))).toBe(false);
    expect(await loadHistory(account)).toEqual([]);
    expect(await db.transferFileParts.count()).toBe(0);
  });

  it("drops records older than 7 days and beyond the newest limit, with their files", async () => {
    const now = Date.now();
    await putHistoryRecord(account, record("old", now - 8 * 24 * 60 * 60 * 1000));
    await putHistoryFile(account, "old", 0, new File(["old"], "a.bin"));
    for (let index = 0; index < NEARBY_HISTORY_MAX_RECORDS + 2; index++) await putHistoryRecord(account, record(`r${index}`, now - index));
    const kept = await loadHistory(account, now);
    expect(kept).toHaveLength(NEARBY_HISTORY_MAX_RECORDS);
    expect(kept[0].id).toBe("r0");
    expect(await db.transferRecords.where("accountPubkey").equals(account).count()).toBe(NEARBY_HISTORY_MAX_RECORDS);
    expect(await db.transferFileParts.count()).toBe(0);
  });

  it("restores records into the assistant with files, marks unfinished ones interrupted, and deletes on removal", async () => {
    const now = Date.now();
    await putHistoryRecord(account, record("own:done", now, { text: "附言" }));
    await putHistoryFile(account, "own:done", 0, new File(["abc"], "a.bin"));
    await putHistoryRecord(account, record("own:half", now - 1, { state: "active", stored: [false] }));
    await putHistoryRecord(account, record("out:sent", now - 2, { direction: "out", state: "paused", stored: undefined }));
    await restoreNearbyHistory();
    expect(nearbyState.transfers.map(item => [item.id, item.state])).toEqual([["own:done", "done"], ["own:half", "failed"], ["out:sent", "failed"]]);
    const done = nearbyState.transfers[0];
    expect(done.restored).toBe(true);
    expect(done.text).toBe("附言");
    expect(await done.received[0]!.text()).toBe("abc");
    clearNearbyTransfer("own:done");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await db.transferRecords.get([account, "own:done"])).toBeUndefined();
    expect(await db.transferFileParts.count()).toBe(0);
  });
});
