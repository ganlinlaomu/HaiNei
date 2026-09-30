import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { HaiNeiDatabase, db as appDb } from "@/db/dexie";
import {
  unlockLocalVault,
  lockLocalVault,
  migrateLocalVault,
} from "@/services/localVault";
import { clearAccountDeviceData } from "@/services/accountDeviceData";
import {
  deviceStorage,
  putDeviceValue,
  clearPrivateDeviceValues,
} from "@/services/deviceStorage";
import { installBackgroundLock } from "@/services/autoLock";
import { timedJsonFetch } from "@/utils/timedFetch";

it("requires unlock before new protected writes, including after reopen", async () => {
  const account = "12".repeat(32),
    database = new HaiNeiDatabase("strict-vault", true);
  try {
    await expect(
      database.accountMeta.put({
        accountPubkey: account,
        key: "draft",
        value: "secret",
      }),
    ).rejects.toThrow("local_vault_locked");
    await unlockLocalVault(account, "1".repeat(64));
    await database.accountMeta.put({
      accountPubkey: account,
      key: "draft",
      value: "secret",
    });
    lockLocalVault(account);
    database.close();
    await database.open();
    await expect(
      database.accountMeta.put({
        accountPubkey: account,
        key: "new",
        value: "new secret",
      }),
    ).rejects.toThrow("local_vault_locked");
  } finally {
    lockLocalVault(account);
    await database.delete();
  }
});
it("resumes an interrupted vault migration without losing old rows", async () => {
  const account = "13".repeat(32),
    database = new HaiNeiDatabase("interrupted-vault");
  try {
    await database.accountMeta.bulkPut(
      Array.from({ length: 101 }, (_, i) => ({
        accountPubkey: account,
        key: `${i}`.padStart(3, "0"),
        value: `secret-${i}`,
      })),
    );
    await unlockLocalVault(account, "2".repeat(64));
    const originalTable = database.table.bind(database);
    const meta = originalTable("accountMeta");
    const write = meta.bulkPut.bind(meta);
    let calls = 0;
    const writeFault = vi
      .spyOn(meta, "bulkPut")
      .mockImplementation((...args: any[]) => {
        if (++calls === 2)
          return Promise.reject(new Error("simulated quota failure")) as any;
        return (write as any)(...args);
      });
    const fault = vi
      .spyOn(database, "table")
      .mockImplementation((name: string) =>
        name === "accountMeta" ? meta : originalTable(name),
      );
    await expect(migrateLocalVault(database, account)).rejects.toThrow(
      "simulated quota failure",
    );
    fault.mockRestore();
    writeFault.mockRestore();
    await migrateLocalVault(database, account);
    expect((await database.accountMeta.get([account, "100"]))?.value).toBe(
      "secret-100",
    );
    expect(
      await database.accountMeta.where("accountPubkey").equals(account).count(),
    ).toBe(102);
  } finally {
    lockLocalVault(account);
    await database.delete();
  }
});
it("deletes only the selected account, including while its vault is locked", async () => {
  const a = "14".repeat(32),
    b = "15".repeat(32),
    database = new HaiNeiDatabase("scoped-deletion");
  try {
    await unlockLocalVault(a, "3".repeat(64));
    await unlockLocalVault(b, "4".repeat(64));
    await database.accountMeta.bulkPut([
      { accountPubkey: a, key: "draft", value: "A" },
      { accountPubkey: b, key: "draft", value: "B" },
    ]);
    await database.deviceKeyValues.bulkPut([
      { key: `hainei_background_lock_${a}`, value: "1", updatedAt: 1 },
      { key: `hainei_background_lock_${b}`, value: "1", updatedAt: 1 },
    ]);
    lockLocalVault(a);
    await clearAccountDeviceData(a, database);
    expect(
      await database.accountMeta.where("accountPubkey").equals(a).count(),
    ).toBe(0);
    expect((await database.accountMeta.get([b, "draft"]))?.value).toBe("B");
    expect(
      (await database.deviceKeyValues.get(`hainei_background_lock_${b}`))
        ?.value,
    ).toBe("1");
  } finally {
    lockLocalVault(a);
    lockLocalVault(b);
    await database.delete();
  }
});
it("seals post drafts and embedded media references instead of writing device plaintext", async () => {
  const account = "16".repeat(32),
    key = `nostr_post_draft_${account}`;
  try {
    await unlockLocalVault(account, "5".repeat(64));
    await putDeviceValue(key, "private draft and AES key");
    expect(await appDb.deviceKeyValues.get(key)).toBeUndefined();
    const raw = await new Promise<any>((resolve, reject) => {
      const request = appDb
        .backendDB()
        .transaction("accountMeta")
        .objectStore("accountMeta")
        .get([account, `private-device:${key}`]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(raw)).not.toContain("AES key");
    clearPrivateDeviceValues(account);
    expect(deviceStorage.getItem(key)).toBeNull();
  } finally {
    lockLocalVault(account);
    await clearAccountDeviceData(account);
  }
});
it("background lock grants five minutes and never transfers A's timeout to B", async () => {
  vi.useFakeTimers();
  const read = vi.spyOn(deviceStorage, "getItem").mockReturnValue("1");
  const target = new EventTarget() as Document;
  Object.defineProperty(target, "visibilityState", {
    value: "visible",
    writable: true,
  });
  let account = "A";
  const lock = vi.fn(async () => {});
  const stop = installBackgroundLock(
    { account: () => account, eligible: () => true, lock },
    target,
  );
  const visibility = (state: string) => {
    (target as any).visibilityState = state;
    target.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(30_000);
    visibility("visible");
    expect(lock).not.toHaveBeenCalled();
    visibility("hidden");
    account = "B";
    await vi.advanceTimersByTimeAsync(300_000);
    visibility("visible");
    expect(lock).not.toHaveBeenCalled();
    visibility("hidden");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(lock).toHaveBeenCalledOnce();
  } finally {
    stop();
    read.mockRestore();
    vi.useRealTimers();
  }
});
it("times out a stalled JSON response body, not only the initial headers", async () => {
  vi.useFakeTimers();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_url, init) =>
      ({
        text: () =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            ),
          ),
      }) as any,
  );
  try {
    const request = timedJsonFetch("https://worker.test/api", {}, 10);
    const failure = expect(request).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(10);
    await failure;
  } finally {
    fetcher.mockRestore();
    vi.useRealTimers();
  }
});
