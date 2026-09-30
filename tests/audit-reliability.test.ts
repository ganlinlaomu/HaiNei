import "fake-indexeddb/auto";
import { it, expect, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { HaiNeiDatabase } from "@/db/dexie";
import { SyncedMessageRepository } from "@/repositories/syncedMessageRepository";
import { downloadMedia, validEncryptedMedia } from "@/utils/mediaSafety";

it("pages same-second messages without gaps or duplicates and caches unread summaries", async () => {
  const db = new HaiNeiDatabase("audit-page");
  const repo = new SyncedMessageRepository(db);
  const account = "d".repeat(64);
  try {
    for (let i = 0; i < 120; i++)
      await repo.insertMessageIfAbsent(account, {
        id: String(i).padStart(3, "0"),
        createdAt: 100,
        senderPubkey: "e".repeat(64),
        recipientPubkeys: [account],
        conversationId: "c",
        protocol: "nip17",
        transportKind: 1059,
        plaintext: "secret",
        tags: [],
      } as any);
    const first = await repo.listConversationPage(account, "c");
    const second = await repo.listConversationPage(account, "c", first[0]);
    const third = await repo.listConversationPage(account, "c", second[0]);
    expect(new Set([...first, ...second, ...third].map((r) => r.id)).size).toBe(
      120,
    );
    expect(first).toHaveLength(50);
    expect(await repo.getUnreadCount(account, "c")).toBe(120);
    expect(
      (await db.conversationStates.get([account, "c"]))?.unreadCache?.count,
    ).toBe(120);
    await repo.markRead(account, "c", first.at(-1));
    expect(await repo.getUnreadCount(account, "c")).toBe(0);
  } finally {
    await db.delete();
  }
});
it("limits deferred sender queues without removing committed messages", async () => {
  const db = new HaiNeiDatabase("audit-deferred");
  const repo = new SyncedMessageRepository(db);
  const account = "f".repeat(64);
  try {
    for (let i = 0; i < 25; i++)
      await repo.deferAuthorizationMessage(
        account,
        { id: String(i), senderPubkey: "sender", createdAt: 1 } as any,
        { source: "realtime" },
      );
    await expect(
      repo.deferAuthorizationMessage(
        account,
        { id: "overflow", senderPubkey: "sender", createdAt: 1 } as any,
        { source: "realtime" },
      ),
    ).rejects.toThrow("deferred_queue_full");
    expect(await repo.listDeferredAuthorizationMessages(account)).toHaveLength(
      25,
    );
  } finally {
    await db.delete();
  }
});
it("aborts oversized streaming media and never sends credentials", async () => {
  let cancelled = false;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      expect(init).toMatchObject({
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(4));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
  try {
    await expect(
      downloadMedia("https://media.example/file", 5),
    ).rejects.toThrow("media_too_large");
    expect(cancelled).toBe(true);
  } finally {
    fetcher.mockRestore();
  }
  expect(
    validEncryptedMedia({
      url: "https://media.example/x",
      mime: "image/jpeg",
      alg: "AES-GCM",
      key: "bad",
      iv: "bad",
    }),
  ).toBe(false);
});
it("deduplicates push across worker restarts and ignores inactive account scope", async () => {
  const entries = new Map<string, Response>();
  const cache = {
    match: async (key: string) => entries.get(key)?.clone(),
    put: async (key: string, value: Response) => {
      entries.set(key, value.clone());
    },
  };
  const show = vi.fn(),
    badge = vi.fn();
  function worker() {
    const handlers: any = {};
    const self = {
      location: { origin: "https://app.test" },
      addEventListener: (name: string, handler: any) => {
        handlers[name] = handler;
      },
      clients: { matchAll: async () => [] },
      registration: { showNotification: show },
      navigator: { setAppBadge: badge, clearAppBadge: vi.fn() },
    };
    runInNewContext(
      readFileSync(
        new URL("../public/service-worker.js", import.meta.url),
        "utf8",
      ),
      { self, caches: { open: async () => cache }, URL, Response, console },
    );
    return async (name: string, data: any) => {
      let work: Promise<any> = Promise.resolve();
      handlers[name]({
        ...data,
        waitUntil: (p: Promise<any>) => {
          work = p;
        },
      });
      await work;
    };
  }
  let send = worker();
  await send("message", {
    data: { type: "SYNC_APP_BADGE", count: 0, accountScope: "A" },
  });
  const push = {
    data: {
      text: () =>
        JSON.stringify({
          type: "message",
          notificationId: "same",
          accountScope: "A",
        }),
    },
  };
  await send("push", push);
  send = worker();
  await send("push", push);
  await send("push", {
    data: {
      text: () =>
        JSON.stringify({
          type: "message",
          notificationId: "other",
          accountScope: "B",
        }),
    },
  });
  expect(show).toHaveBeenCalledTimes(1);
  expect(badge).toHaveBeenCalledWith();
});
it("retains the last direct message even when newer interactions fill the recent page", async () => {
  const db = new HaiNeiDatabase("audit-latest-direct"),
    repo = new SyncedMessageRepository(db),
    account = "17".repeat(32);
  const message = (id: string, time: number, direct = false) =>
    ({
      id,
      createdAt: time,
      senderPubkey: "18".repeat(32),
      recipientPubkeys: [account],
      conversationId: "c",
      protocol: "nip17",
      transportKind: 1059,
      plaintext: "secret",
      tags: direct ? [["t", "hainei-dm"]] : [],
    }) as any;
  try {
    await repo.insertMessageIfAbsent(account, message("dm", 1, true));
    for (let i = 0; i < 205; i++)
      await repo.insertMessageIfAbsent(
        account,
        message(`interaction-${i}`, i + 2),
      );
    expect(
      (await repo.listRecent(account)).some((row) => row.id === "dm"),
    ).toBe(true);
    expect(
      await repo.getVisibleUnreadCount(
        account,
        "c",
        "policy",
        undefined,
        (m) => m.createdAt > 0,
      ),
    ).toBe(1);
    await repo.insertMessageIfAbsent(account, message("new-dm", 300, true));
    expect(
      (await db.conversationStates.get([account, "c"]))?.visibleUnreadCache
        ?.count,
    ).toBe(2);
    expect(
      await repo.getVisibleUnreadCount(
        account,
        "c",
        "new-policy",
        undefined,
        (m) => m.createdAt > 100,
      ),
    ).toBe(1);
  } finally {
    await db.delete();
  }
});
it("keeps the original quarantine TTL and exposes later pages", async () => {
  const db = new HaiNeiDatabase("audit-deferred-pages"),
    repo = new SyncedMessageRepository(db),
    account = "19".repeat(32);
  try {
    for (let i = 0; i < 70; i++)
      await repo.deferAuthorizationMessage(
        account,
        {
          id: `${i}`.padStart(3, "0"),
          senderPubkey: `sender-${i}`,
          createdAt: 1,
        } as any,
        { source: "realtime" },
        1000,
      );
    const first = await repo.listDeferredAuthorizationMessages(account);
    expect(first).toHaveLength(50);
    expect(
      await repo.listDeferredAuthorizationMessages(account, first.at(-1)?.id),
    ).toHaveLength(20);
    await repo.deferAuthorizationMessage(
      account,
      { id: "000", senderPubkey: "sender-0", createdAt: 1 } as any,
      { source: "realtime" },
      2000,
    );
    expect(
      (await db.deferredAuthorizationMessages.get([account, "000"]))
        ?.deferredAt,
    ).toBe(1000);
    await repo.deferAuthorizationMessage(
      account,
      { id: "fresh", senderPubkey: "new", createdAt: 1 } as any,
      { source: "realtime" },
      8 * 86400000,
    );
    expect(
      await db.deferredAuthorizationMessages
        .where("accountPubkey")
        .equals(account)
        .count(),
    ).toBe(1);
  } finally {
    await db.delete();
  }
});
