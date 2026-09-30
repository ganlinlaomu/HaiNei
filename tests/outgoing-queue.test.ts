import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type OutgoingQueueRecord } from "@/db/dexie";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";

const { publish, triggerPush } = vi.hoisted(() => ({ publish: vi.fn(), triggerPush: vi.fn() }));
vi.mock("@/services/nostrClient", () => ({ nostrClient: { publish } }));
vi.mock("@/services/pushNotifications", () => ({ triggerGenericPush: triggerPush }));

import {
  cancelOutgoingWorkForAccount,
  publishQueuedOutgoing,
  registerOutgoingPushSigner,
  retryFailedOutgoing,
  retryOutgoingQueue
} from "@/nostr/messaging/service";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function queued(accountPubkey = ACCOUNT, outgoingId = "logical-1", state: OutgoingQueueRecord["state"] = "pending") {
  const event = { id: `wrap-${outgoingId}`, kind: 1059, pubkey: accountPubkey, created_at: 1, content: "cipher", sig: "", tags: [["p", OTHER]] };
  return {
    accountPubkey, outgoingId, state,
    message: { id: outgoingId, senderPubkey: accountPubkey, recipientPubkeys: [OTHER], plaintext: "private", createdAt: 1, protocol: "nip17", transportKind: 1059, tags: [["t", "hainei-dm"]] },
    events: [event], relays: ["wss://relay.test"], attempts: 0, createdAt: 1, updatedAt: 1
  } satisfies OutgoingQueueRecord;
}

beforeEach(async () => {
  cancelOutgoingWorkForAccount(ACCOUNT);
  cancelOutgoingWorkForAccount(OTHER);
  publish.mockReset().mockResolvedValue([{ relay: "wss://relay.test", ok: true, ts: 1 }]);
  triggerPush.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { onLine: true });
  await db.outgoingQueue.clear();
});

describe("durable outgoing queue", () => {
  it("uses an explicit private-message push category at publish time", async () => {
    await outgoingQueueRepository.putIfAbsent(queued());
    const signer = vi.fn();
    registerOutgoingPushSigner(ACCOUNT, signer);
    await publishQueuedOutgoing(ACCOUNT, "logical-1", "message");
    expect(triggerPush).toHaveBeenCalledWith([OTHER], ACCOUNT, signer, "message", "logical-1");
  });

  it("persists failed push work and retries after reopening without republishing the DM", async () => {
    await outgoingQueueRepository.putIfAbsent(queued());
    registerOutgoingPushSigner(ACCOUNT, vi.fn());
    triggerPush.mockRejectedValueOnce(new Error("network lost"));
    await publishQueuedOutgoing(ACCOUNT, "logical-1");
    expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "sent", pushState: "pending" });
    cancelOutgoingWorkForAccount(ACCOUNT);
    db.close();
    await db.open();
    registerOutgoingPushSigner(ACCOUNT, vi.fn());
    await outgoingQueueRepository.update(ACCOUNT, "logical-1", { pushNextAttemptAt: 0 });
    await retryOutgoingQueue(ACCOUNT);
    expect(publish).toHaveBeenCalledOnce();
    expect(triggerPush).toHaveBeenCalledTimes(2);
    expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "sent", pushState: "accepted" });
    await retryOutgoingQueue(ACCOUNT);
    expect(triggerPush).toHaveBeenCalledTimes(2);
  });

  it("recovers a push interrupted after relay acknowledgement and ignores historical sent messages", async () => {
    await outgoingQueueRepository.putIfAbsent(queued(ACCOUNT, "old", "sent"));
    await outgoingQueueRepository.putIfAbsent({ ...queued(ACCOUNT, "interrupted", "sent"), pushState: "pending", pushExpiresAt: Date.now() + 60_000 });
    registerOutgoingPushSigner(ACCOUNT, vi.fn());
    await retryOutgoingQueue(ACCOUNT);
    expect(publish).not.toHaveBeenCalled();
    expect(triggerPush).toHaveBeenCalledOnce();
    expect(triggerPush.mock.calls[0][4]).toBe("interrupted");
  });

  it("is durable before publish and does not duplicate a concurrent logical retry", async () => {
    await outgoingQueueRepository.putIfAbsent(queued());
    publish.mockImplementationOnce(async () => {
      expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "sending" });
      return [{ relay: "wss://relay.test", ok: true, ts: 1 }];
    });
    await Promise.all([
      publishQueuedOutgoing(ACCOUNT, "logical-1"),
      publishQueuedOutgoing(ACCOUNT, "logical-1")
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "sent" });
  });

  it("moves offline work to waiting_network and retries after reconnect", async () => {
    await outgoingQueueRepository.putIfAbsent(queued());
    vi.stubGlobal("navigator", { onLine: false });
    await expect(publishQueuedOutgoing(ACCOUNT, "logical-1")).rejects.toThrow("联网后重试");
    expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "waiting_network" });
    vi.stubGlobal("navigator", { onLine: true });
    const results = await retryOutgoingQueue(ACCOUNT);
    expect(results[0].status).toBe("fulfilled");
    expect(await outgoingQueueRepository.get(ACCOUNT, "logical-1")).toMatchObject({ state: "sent" });
  });

  it("manually retries failed work and keeps accounts isolated", async () => {
    await outgoingQueueRepository.putIfAbsent(queued(ACCOUNT, "failed", "failed"));
    await outgoingQueueRepository.putIfAbsent(queued(OTHER, "other", "failed"));
    const results = await retryFailedOutgoing(ACCOUNT);
    expect(results).toHaveLength(1);
    expect(await outgoingQueueRepository.get(ACCOUNT, "failed")).toMatchObject({ state: "sent" });
    expect(await outgoingQueueRepository.get(OTHER, "other")).toMatchObject({ state: "failed" });
  });
});
