import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import {
  unlockLocalVault,
  lockLocalVault,
  migrateLocalVault,
} from "@/services/localVault";
const account = "a".repeat(64);
it("migrates, encrypts and restores drafts including binary data; rejects reads while locked", async () => {
  const db = new HaiNeiDatabase("vault-test");
  try {
    await db.accountMeta.put({
      accountPubkey: account,
      key: "draft",
      value: { text: "private secret" },
    });
    await unlockLocalVault(account, "1".repeat(64));
    await migrateLocalVault(db, account);
    await db.accountMeta.update([account, "draft"], {
      value: { text: "updated secret", bytes: Uint8Array.of(1, 2).buffer },
    });
    expect((await db.accountMeta.get([account, "draft"]))?.value).toEqual({
      text: "updated secret",
      bytes: Uint8Array.of(1, 2).buffer,
    });
    const raw = await new Promise<any>((resolve, reject) => {
      const tx = db.backendDB().transaction("accountMeta");
      const req = tx.objectStore("accountMeta").get([account, "draft"]);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(JSON.stringify(raw)).not.toContain("secret");
    expect(raw._vault.v).toBe(1);
    expect(
      (
        await db.accountMeta
          .where("accountPubkey")
          .equals(account)
          .filter((r) => r.key === "draft")
          .toArray()
      )[0].value,
    ).toHaveProperty("text", "updated secret");
    lockLocalVault(account);
    await expect(db.accountMeta.get([account, "draft"])).rejects.toThrow(
      "local_vault_locked",
    );
    await unlockLocalVault(account, "1".repeat(64));
    expect(
      (await db.accountMeta.get([account, "draft"]))?.value,
    ).toHaveProperty("text", "updated secret");
  } finally {
    lockLocalVault(account);
    await db.delete();
  }
});

it("seals per-recipient DM routes and cached relay URLs", async () => {
  const db = new HaiNeiDatabase("vault-dm-relays-test");
  const peer = "b".repeat(64);
  try {
    await unlockLocalVault(account, "1".repeat(64));
    await db.outgoingQueue.put({
      accountPubkey: account,
      outgoingId: "logical-1",
      state: "pending",
      message: { plaintext: "private" },
      events: [],
      relays: ["wss://legacy.test"],
      eventRoutes: [{
        eventId: "event-1",
        targetPubkey: peer,
        relays: ["wss://peer-dm.test"],
        source: "nip17-10050",
        resolvedAt: 1,
      }],
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.dmRelayDirectory.put({
      accountPubkey: account,
      ownerPubkey: peer,
      relays: ["wss://peer-dm.test"],
      fetchedAt: 1,
      expiresAt: 2,
      source: "nip17",
    });

    const raw = await new Promise<{ outgoing: any; directory: any }>((resolve, reject) => {
      const tx = db.backendDB().transaction(["outgoingQueue", "dmRelayDirectory"]);
      const outgoingRequest = tx.objectStore("outgoingQueue").get([account, "logical-1"]);
      const directoryRequest = tx.objectStore("dmRelayDirectory").get([account, peer]);
      tx.oncomplete = () => resolve({ outgoing: outgoingRequest.result, directory: directoryRequest.result });
      tx.onerror = () => reject(tx.error);
    });
    expect(JSON.stringify(raw.outgoing)).not.toContain("peer-dm.test");
    expect(JSON.stringify(raw.outgoing)).not.toContain(peer);
    expect(JSON.stringify(raw.directory)).not.toContain("peer-dm.test");
    expect((await db.outgoingQueue.get([account, "logical-1"]))?.eventRoutes?.[0].relays).toEqual(["wss://peer-dm.test"]);
    expect((await db.dmRelayDirectory.get([account, peer]))?.relays).toEqual(["wss://peer-dm.test"]);

    lockLocalVault(account);
    await expect(db.outgoingQueue.get([account, "logical-1"])).rejects.toThrow("local_vault_locked");
    await expect(db.dmRelayDirectory.get([account, peer])).rejects.toThrow("local_vault_locked");
  } finally {
    lockLocalVault(account);
    await db.delete();
  }
});
