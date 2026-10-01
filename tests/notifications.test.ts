import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { db } from "@/db/dexie";
import { metaRepository } from "@/repositories/metaRepository";
import { useNotificationsStore } from "@/stores/notifications";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); }
  };
}

describe("notifications store", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    Object.defineProperty(globalThis, "localStorage", { value: createStorage(), configurable: true });
    await db.open();
    await Promise.all([db.accountMeta.clear(), db.accountStateMirrors.clear()]);
  });

  it("removes legacy post notifications without affecting interaction notifications", async () => {
    const account = "a".repeat(64);
    localStorage.setItem(`nostr_notifications_${account}`, JSON.stringify([
      { id: "post", type: "message", from: "b", messageId: "p1", created_at: 10, read: false },
      { id: "like", type: "like", from: "b", messageId: "p1", created_at: 11, read: false },
      { id: "reply", type: "comment", from: "c", messageId: "p1", commentId: "c1", replyId: "c0", created_at: 12, read: false }
    ]));

    const notifications = useNotificationsStore();
    await notifications.load(account);

    expect(notifications.list.map(item => item.id)).toEqual(["like:p1:b", "reply"]);
    expect(notifications.unreadCount).toBe(2);
    expect(JSON.parse(localStorage.getItem(`nostr_notifications_${account}`) || "[]").map((item: { id: string }) => item.id))
      .toEqual(["like:p1:b", "reply"]);
  });

  it("rejects message notifications defensively", async () => {
    const account = "d".repeat(64);
    const notifications = useNotificationsStore();
    await notifications.load(account);
    notifications.addNotification({
      id: "legacy",
      type: "message",
      from: "e",
      messageId: "p2",
      created_at: Math.floor(Date.now() / 1000),
      read: false
    } as any);
    expect(notifications.list).toEqual([]);
  });

  it("restores cross-device read ids and the mark-all cursor before counting local notifications", async () => {
    const account = "f".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(`nostr_notifications_${account}`, JSON.stringify([
      { id: "older", type: "comment", from: "a", created_at: now - 30, read: false },
      { id: "same", type: "comment", from: "b", created_at: now - 20, read: false },
      { id: "individual", type: "like", from: "c", messageId: "p", created_at: now - 10, read: false },
      { id: "newer", type: "comment", from: "d", created_at: now, read: false },
    ]));
    await metaRepository.put(account, "notification_state", {
      dismissedIds: [],
      readIds: ["like:p:c"],
      readCursor: { lastReadCreatedAt: now - 20, lastReadMessageId: "same" },
    });

    const notifications = useNotificationsStore();
    await notifications.load(account);

    expect(notifications.list.map(item => [item.id, item.read])).toEqual([
      ["older", true],
      ["same", true],
      ["like:p:c", true],
      ["newer", false],
    ]);
    expect(notifications.unreadCount).toBe(1);
  });

  it("reconciles a Worker notification cursor that arrives after the local-first store load", async () => {
    const account = "1".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(`nostr_notifications_${account}`, JSON.stringify([
      { id: "restored", type: "comment", from: "2", created_at: now - 5, read: false },
    ]));
    const notifications = useNotificationsStore();
    await notifications.load(account);
    expect(notifications.unreadCount).toBe(1);

    await metaRepository.put(account, "notification_state", {
      dismissedIds: [],
      readIds: ["restored"],
    });
    await notifications.refreshSyncedState(account);

    expect(notifications.list[0].read).toBe(true);
    expect(notifications.unreadCount).toBe(0);
  });

  it("keeps historical Relay replays read while counting notifications after the restored cursor", async () => {
    const account = "3".repeat(64);
    const now = Math.floor(Date.now() / 1000);
    await metaRepository.put(account, "notification_state", {
      dismissedIds: [],
      readCursor: { lastReadCreatedAt: now - 10, lastReadMessageId: "watermark" },
    });
    const notifications = useNotificationsStore();
    await notifications.load(account);

    notifications.addNotification({ id: "old-replay", type: "comment", from: "4", created_at: now - 20, read: false });
    notifications.addNotification({ id: "new-event", type: "comment", from: "5", created_at: now, read: false });

    expect(notifications.list.find(item => item.id === "old-replay")?.read).toBe(true);
    expect(notifications.list.find(item => item.id === "new-event")?.read).toBe(false);
    expect(notifications.unreadCount).toBe(1);
  });
});
