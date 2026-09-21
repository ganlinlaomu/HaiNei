import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
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
  beforeEach(() => {
    setActivePinia(createPinia());
    Object.defineProperty(globalThis, "localStorage", { value: createStorage(), configurable: true });
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

    expect(notifications.list.map(item => item.id)).toEqual(["like", "reply"]);
    expect(notifications.unreadCount).toBe(2);
    expect(JSON.parse(localStorage.getItem(`nostr_notifications_${account}`) || "[]").map((item: { id: string }) => item.id))
      .toEqual(["like", "reply"]);
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
});
