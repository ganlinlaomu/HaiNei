import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type OutgoingDmTaskRecord } from "@/db/dexie";
import { outgoingDmTaskRepository } from "@/repositories/outgoingDmTaskRepository";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);

function pending(accountPubkey = ACCOUNT): OutgoingDmTaskRecord {
  return {
    accountPubkey,
    localId: "local-1",
    peerPubkey: "c".repeat(64),
    text: "pending",
    imageBlob: new Blob(["image"], { type: "image/jpeg" }),
    imageName: "photo.jpg",
    imageType: "image/jpeg",
    state: "uploading",
    createdAt: 10,
    updatedAt: 10,
  };
}

beforeEach(async () => {
  await db.outgoingDmTasks.clear();
});

describe("account-scoped outgoing DM task persistence", () => {
  it("persists resumable image data and state across repository reads", async () => {
    await outgoingDmTaskRepository.put(pending());
    const restored = await outgoingDmTaskRepository.get(ACCOUNT, "local-1");
    expect(restored).toMatchObject({ state: "uploading", imageName: "photo.jpg", text: "pending" });
    expect(await restored!.imageBlob!.text()).toBe("image");
  });

  it("keeps pending tasks isolated by account", async () => {
    await outgoingDmTaskRepository.put(pending(ACCOUNT));
    await outgoingDmTaskRepository.put({ ...pending(OTHER), localId: "local-2" });
    expect((await outgoingDmTaskRepository.list(ACCOUNT)).map(task => task.localId)).toEqual(["local-1"]);
    expect((await outgoingDmTaskRepository.list(OTHER)).map(task => task.localId)).toEqual(["local-2"]);
  });
});
