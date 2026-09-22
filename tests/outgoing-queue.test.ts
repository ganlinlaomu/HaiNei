import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, type OutgoingQueueRecord } from "@/db/dexie";
import { outgoingQueueRepository } from "@/repositories/outgoingQueueRepository";

const publish = vi.hoisted(() => vi.fn());
vi.mock("@/services/nostrClient", () => ({ nostrClient: { publish } }));

import {
  publishQueuedOutgoing,
  retryFailedOutgoing,
  retryOutgoingQueue
} from "@/nostr/messaging/service";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function queued(accountPubkey = ACCOUNT, outgoingId = "logical-1", state: OutgoingQueueRecord["state"] = "pending") {
  const event = { id: `wrap-${outgoingId}`, kind: 1059, pubkey: accountPubkey, created_at: 1, content: "cipher", sig: "", tags: [["p", OTHER]] };
  return {
    accountPubkey, outgoingId, state,
    message: { id: outgoingId, senderPubkey: accountPubkey, recipientPubkeys: [OTHER], plaintext: "private", createdAt: 1, protocol: "nip17", transportKind: 1059, tags: [] },
    events: [event], relays: ["wss://relay.test"], attempts: 0, createdAt: 1, updatedAt: 1
  } satisfies OutgoingQueueRecord;
}

beforeEach(async () => {
  publish.mockReset().mockResolvedValue([{ relay: "wss://relay.test", ok: true, ts: 1 }]);
  vi.stubGlobal("navigator", { onLine: true });
  await db.outgoingQueue.clear();
});

describe("durable outgoing queue", () => {
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
