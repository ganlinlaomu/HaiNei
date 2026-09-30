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
