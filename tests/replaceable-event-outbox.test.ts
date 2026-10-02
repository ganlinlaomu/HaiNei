import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase, type ReplaceableEventOutboxRecord } from "@/db/dexie";
import { ReplaceableEventOutboxRepository } from "@/repositories/replaceableEventOutboxRepository";

const ACCOUNT = "a".repeat(64);
let sequence = 0;
const databases: HaiNeiDatabase[] = [];

function setup() {
  const database = new HaiNeiDatabase(`replaceable-outbox-${sequence++}`, false);
  databases.push(database);
  return new ReplaceableEventOutboxRepository(database);
}

function queued(id: string, createdAt: number): ReplaceableEventOutboxRecord {
  return {
    accountPubkey: ACCOUNT,
    key: "10003",
    event: { id, pubkey: ACCOUNT, kind: 10003, created_at: createdAt, tags: [], content: "", sig: "s" },
    relays: ["wss://relay.test"],
    attempts: 0,
    createdAt: createdAt * 1000,
    updatedAt: createdAt * 1000,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async database => {
    database.close();
    await database.delete();
  }));
});

describe("replaceable event outbox", () => {
  it("keeps only the latest snapshot for an account and replaceable key", async () => {
    const repository = setup();
    await repository.putLatest(queued("old", 1));
    await repository.putLatest(queued("new", 2));

    expect(await repository.list(ACCOUNT)).toHaveLength(1);
    expect((await repository.get(ACCOUNT, "10003"))?.event.id).toBe("new");
  });

  it("persists retry metadata until the exact snapshot is deleted", async () => {
    const repository = setup();
    await repository.putLatest(queued("pending", 1));
    await repository.update(ACCOUNT, "10003", {
      attempts: 2,
      nextAttemptAt: 1234,
      lastError: "offline",
    });

    expect(await repository.get(ACCOUNT, "10003")).toMatchObject({
      attempts: 2,
      nextAttemptAt: 1234,
      lastError: "offline",
    });
    await repository.delete(ACCOUNT, "10003");
    expect(await repository.get(ACCOUNT, "10003")).toBeUndefined();
  });
});
