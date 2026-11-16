import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase, type OutgoingQueueRecord } from "@/db/dexie";
import { OutgoingQueueRepository, SENT_RETENTION_MS } from "@/repositories/outgoingQueueRepository";

const ACCOUNT = "1c".repeat(32);
const OTHER = "1d".repeat(32);
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
let db: HaiNeiDatabase;

function row(outgoingId: string, state: OutgoingQueueRecord["state"], updatedAt: number, extra: Partial<OutgoingQueueRecord> = {}, account = ACCOUNT): OutgoingQueueRecord {
  return {
    accountPubkey: account, outgoingId, state, updatedAt, createdAt: updatedAt, attempts: 0,
    message: { id: outgoingId }, events: [{ id: `wrap-${outgoingId}` }], relays: ["wss://relay.test"], ...extra,
  };
}

async function seed() {
  db = new HaiNeiDatabase(`outgoing-prune-${Math.random()}`);
  const repo = new OutgoingQueueRepository(db);
  for (const record of [
    row("pending", "pending", NOW - 30 * DAY),
    row("failed", "failed", NOW - 30 * DAY),
    row("sent-old", "sent", NOW - 30 * DAY),
    row("sent-old-kept", "sent", NOW - 30 * DAY),
    row("sent-week", "sent", NOW - 6 * DAY),
    row("sent-recent", "sent", NOW - 2 * DAY),
    row("sent-push", "sent", NOW - 60_000, { pushState: "pending", pushExpiresAt: NOW + DAY - 60_000 }),
    row("other-account", "sent", NOW - 30 * DAY, {}, OTHER),
  ]) await repo.putIfAbsent(record);
  return repo;
}

afterEach(async () => {
  db?.close();
  await db?.delete();
});

describe("outgoing queue reads and pruning", () => {
  it("reads unsent rows and recent sent rows through indexes", async () => {
    const repo = await seed();
    expect((await repo.listUnsent(ACCOUNT)).map(r => r.outgoingId).sort()).toEqual(["failed", "pending"]);
    expect((await repo.listSentSince(ACCOUNT, NOW - 3 * DAY)).map(r => r.outgoingId)).toEqual(["sent-push", "sent-recent"]);
    expect((await repo.listSentSince(ACCOUNT, NOW - 3 * DAY, 1)).map(r => r.outgoingId)).toEqual(["sent-push"]);
  });

  it("still finds a sent row whose Push is pending, without reading old sent rows", async () => {
    const repo = await seed();
    const retryable = await repo.listRetryable(ACCOUNT, true, NOW);
    expect(retryable.map(r => r.outgoingId).sort()).toEqual(["failed", "pending", "sent-push"]);
  });

  it("prunes only this account's old sent rows, keeping referenced and unsent ones", async () => {
    const repo = await seed();
    const deleted = await repo.pruneSent(ACCOUNT, NOW - SENT_RETENTION_MS, new Set(["sent-old-kept"]));
    expect(deleted).toBe(1);
    const left = (await db.outgoingQueue.toArray()).map(r => r.outgoingId).sort();
    expect(left).toEqual(["failed", "other-account", "pending", "sent-old-kept", "sent-push", "sent-recent", "sent-week"]);
  });
});
