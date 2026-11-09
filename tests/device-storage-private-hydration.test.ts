import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const settingsKey = (account: string) => `nostr_settings_${account}`;

async function fresh() {
  vi.resetModules();
  const { db } = await import("@/db/dexie");
  await db.open();
  await Promise.all([db.deviceKeyValues.clear(), db.accountMeta.clear()]);
  const storage = await import("@/services/deviceStorage");
  return { db, ...storage };
}

describe("启动时读取账号的设备私有设置", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("只读 private-device: 开头的行，不读其他账号数据", async () => {
    const { db, hydrateDeviceStorage, hydratePrivateDeviceValues, deviceStorage } = await fresh();
    await db.accountMeta.bulkPut([
      { accountPubkey: ACCOUNT, key: `private-device:${settingsKey(ACCOUNT)}`, value: "mine" },
      { accountPubkey: ACCOUNT, key: "dm-draft:peer", value: "draft" },
      { accountPubkey: ACCOUNT, key: "read-cursor:peer", value: "1" },
      { accountPubkey: OTHER, key: `private-device:${settingsKey(OTHER)}`, value: "theirs" },
    ]);
    await hydrateDeviceStorage();
    await hydratePrivateDeviceValues(ACCOUNT);
    expect(deviceStorage.getItem(settingsKey(ACCOUNT))).toBe("mine");
    expect(deviceStorage.getItem(settingsKey(OTHER))).toBeNull();
    expect(deviceStorage.getItem("dm-draft:peer")).toBeNull();
  });

  it("旧格式的私有行迁移进 accountMeta 并删除原行", async () => {
    const { db, hydrateDeviceStorage, hydratePrivateDeviceValues, deviceStorage } = await fresh();
    await db.deviceKeyValues.bulkPut([
      { key: settingsKey(ACCOUNT), value: "legacy", updatedAt: 1 },
      { key: settingsKey(OTHER), value: "other-legacy", updatedAt: 1 },
      { key: "theme", value: "dark", updatedAt: 1 },
    ]);
    await hydrateDeviceStorage();
    // Private rows are never exposed before their account is unlocked.
    expect(deviceStorage.getItem(settingsKey(ACCOUNT))).toBeNull();
    expect(deviceStorage.getItem("theme")).toBe("dark");

    await hydratePrivateDeviceValues(ACCOUNT);

    expect(deviceStorage.getItem(settingsKey(ACCOUNT))).toBe("legacy");
    expect(await db.deviceKeyValues.get(settingsKey(ACCOUNT))).toBeUndefined();
    expect(await db.accountMeta.get([ACCOUNT, `private-device:${settingsKey(ACCOUNT)}`])).toMatchObject({ value: "legacy" });
    expect(await db.deviceKeyValues.get(settingsKey(OTHER))).toMatchObject({ value: "other-legacy" });
  });

  it("启动时没看到旧格式行，就不再整表读取 deviceKeyValues", async () => {
    const { db, hydrateDeviceStorage, hydratePrivateDeviceValues } = await fresh();
    await db.deviceKeyValues.put({ key: "theme", value: "dark", updatedAt: 1 });
    await hydrateDeviceStorage();
    const toArray = vi.spyOn(db.deviceKeyValues, "toArray");
    await hydratePrivateDeviceValues(ACCOUNT);
    expect(toArray).not.toHaveBeenCalled();
  });

  it("另一个账号还有旧格式行时，切换到它照样迁移", async () => {
    const { db, hydrateDeviceStorage, hydratePrivateDeviceValues, deviceStorage } = await fresh();
    await db.deviceKeyValues.put({ key: settingsKey(OTHER), value: "other-legacy", updatedAt: 1 });
    await hydrateDeviceStorage();
    await hydratePrivateDeviceValues(ACCOUNT);
    await hydratePrivateDeviceValues(OTHER);
    expect(deviceStorage.getItem(settingsKey(OTHER))).toBe("other-legacy");
    expect(await db.deviceKeyValues.get(settingsKey(OTHER))).toBeUndefined();
  });
});
