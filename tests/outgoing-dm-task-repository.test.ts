import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, type OutgoingDmTaskRecord } from "@/db/dexie";
import { outgoingDmTaskRepository } from "@/repositories/outgoingDmTaskRepository";

const ACCOUNT = "a".repeat(64);
const OTHER = "b".repeat(64);
const bytes = (value: string) => new TextEncoder().encode(value).buffer;

function pending(accountPubkey = ACCOUNT): OutgoingDmTaskRecord {
  return {
    accountPubkey,
    localId: "local-1",
    peerPubkey: "c".repeat(64),
    text: "pending",
    imageBytes: bytes("image"),
    imageName: "photo.jpg",
    imageType: "image/jpeg",
    preparedImage: {
      encryptedBytes: bytes("encrypted"), encryptedName: "photo.encrypted",
      previewBytes: bytes("preview"), mime: "image/jpeg",
      iv: "iv", key: "key", width: 10, height: 10,
    },
    state: "uploading",
    createdAt: 10,
    updatedAt: 10,
  };
}

function containsBlob(value: unknown): boolean {
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (!value || typeof value !== "object" || value instanceof ArrayBuffer) return false;
  return Object.values(value).some(containsBlob);
}

beforeEach(async () => {
  await db.outgoingDmTasks.clear();
});

describe("account-scoped outgoing DM task persistence", () => {
  it("persists only ArrayBuffer image and prepared data", async () => {
    await outgoingDmTaskRepository.put(pending());
    const restored = await outgoingDmTaskRepository.get(ACCOUNT, "local-1");
    expect(restored).toMatchObject({ state: "uploading", imageName: "photo.jpg", text: "pending" });
    expect(new TextDecoder().decode(restored!.imageBytes)).toBe("image");
    expect(new TextDecoder().decode(restored!.preparedImage!.encryptedBytes)).toBe("encrypted");
    expect(containsBlob(restored)).toBe(false);
    expect(containsBlob(await db.outgoingDmTasks.get([ACCOUNT, "local-1"]))).toBe(false);
  });

  it("migrates readable legacy Blob fields once without clearing the task", async () => {
    await db.outgoingDmTasks.put({
      ...pending(), imageBytes: undefined,
      imageBlob: new Blob(["legacy-image"], { type: "image/jpeg" }),
      preparedImage: {
        encryptedBlob: new Blob(["legacy-encrypted"]), encryptedName: "photo.encrypted",
        previewBlob: new Blob(["legacy-preview"], { type: "image/jpeg" }), mime: "image/jpeg",
        iv: "iv", key: "key", width: 10, height: 10,
      },
    } as any);

    const restored = await outgoingDmTaskRepository.get(ACCOUNT, "local-1");
    expect(new TextDecoder().decode(restored!.imageBytes)).toBe("legacy-image");
    expect(new TextDecoder().decode(restored!.preparedImage!.previewBytes)).toBe("legacy-preview");
    expect(containsBlob(await db.outgoingDmTasks.get([ACCOUNT, "local-1"]))).toBe(false);
  });

  it("keeps pending tasks isolated by account", async () => {
    await outgoingDmTaskRepository.put(pending(ACCOUNT));
    await outgoingDmTaskRepository.put({ ...pending(OTHER), localId: "local-2" });
    expect((await outgoingDmTaskRepository.list(ACCOUNT)).map(task => task.localId)).toEqual(["local-1"]);
    expect((await outgoingDmTaskRepository.list(OTHER)).map(task => task.localId)).toEqual(["local-2"]);
  });

  it("persists encrypted audio as clone-safe data and drops runtime objects", async () => {
    const runtimeRecorder = { stop() {} };
    await outgoingDmTaskRepository.put({
      accountPubkey: ACCOUNT,
      localId: "voice-1",
      peerPubkey: OTHER,
      text: "",
      mediaType: "audio",
      audioMime: "audio/mp4",
      audioDuration: 9,
      audioSize: 5,
      preparedAudio: {
        encryptedBytes: bytes("cipher"), encryptedName: "voice.encrypted", mime: "audio/mp4",
        iv: "iv", key: "key", duration: 9, size: 5,
      },
      state: "uploading",
      createdAt: 1,
      updatedAt: 1,
      recorder: runtimeRecorder,
      previewUrl: "blob:runtime",
    } as OutgoingDmTaskRecord & { recorder: unknown; previewUrl: string });

    const stored = await db.outgoingDmTasks.get([ACCOUNT, "voice-1"]) as any;
    expect(new TextDecoder().decode(stored.preparedAudio.encryptedBytes)).toBe("cipher");
    expect(stored).not.toHaveProperty("recorder");
    expect(stored).not.toHaveProperty("previewUrl");
    expect(JSON.stringify(stored)).not.toContain("blob:runtime");
  });
});
