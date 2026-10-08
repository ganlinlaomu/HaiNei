import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { HaiNeiDatabase } from "@/db/dexie";
import { lockLocalVault, unlockLocalVault } from "@/services/localVault";
import { PrivateSpaceRepository } from "@/repositories/privateSpaceRepository";
import {
  canImportDirectMessage,
  canImportPost,
  importPostToPrivateSpace,
  importDirectMessageToPrivateSpace,
  type PrivateSpaceImportSession,
} from "@/services/privateSpaceImport";

const A = "a".repeat(64), B = "b".repeat(64), PEER = "c".repeat(64);
const SECRET_A = "1".repeat(64), SECRET_B = "2".repeat(64);
const POST_ID = "d".repeat(64), DM_ID = "e".repeat(64);
const account = (pkHex = A): PrivateSpaceImportSession => ({
  pkHex, isUnlocked: true, sessionGeneration: 1,
});
let sequence = 0;
const dbs: HaiNeiDatabase[] = [];
function repo() {
  const database = new HaiNeiDatabase("private-space-import-test-" + sequence++, true);
  dbs.push(database);
  return { database, repository: new PrivateSpaceRepository(database) };
}
const post = () => ({
  id: POST_ID, pubkey: PEER, created_at: 1_760_000_000,
  content: "重要内容：勿忘！", tags: [["t", "hainei-post"]],
});
const dm = () => ({
  id: DM_ID, pubkey: PEER, created_at: 1_760_000_010,
  content: "只保存普通私信文字", tags: [["t", "hainei-dm"]],
});
afterEach(async () => {
  lockLocalVault(A);
  lockLocalVault(B);
  for (const database of dbs.splice(0)) {
    database.close();
    await Dexie.delete(database.name);
  }
});

describe("private space PR3-A: explicit post and DM imports", () => {
  it("imports post only after explicit action, encrypts locally and deduplicates source ID", async () => {
    const { database, repository } = repo();
    await unlockLocalVault(A, SECRET_A);
    expect((await repository.list(A))).toEqual([]);
    const first = await importPostToPrivateSpace(account(), post(), "好友名称", repository);
    expect(first.created).toBe(true);
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    const [saved] = await repository.list(A);
    expect(saved).toMatchObject({ id: first.id, kind: "note", revision: 1 });
    expect(saved.body).toContain("重要内容：勿忘！");
    expect(saved.body).toContain("消息 ID：" + POST_ID);
    const raw: any = await new Promise((resolve, reject) => {
      const transaction = database.backendDB().transaction("accountNotes", "readonly");
      const request = transaction.objectStore("accountNotes").get([A, first.id]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(JSON.stringify(raw)).not.toContain("重要内容：勿忘！");
    expect(JSON.stringify(raw)).not.toContain("好友名称");

    await repository.save(A, first.id, {
      kind: "note", title: "我的新标题", body: "我写的内容", tasks: [], pinned: true,
    });
    const again = await importPostToPrivateSpace(account(), post(), "新名字", repository);
    expect(again).toEqual({ id: first.id, created: false });
    expect((await repository.get(A, first.id))?.body).toBe("我写的内容");
    await repository.moveToTrash(A, first.id);
    const trashed = await importPostToPrivateSpace(account(), post(), "第三次", repository);
    expect(trashed.created).toBe(false);
    expect((await repository.get(A, first.id))?.deletedAt).toBeGreaterThan(0);
  });

  it("saves ordinary DM text with stable source identity, scoped per account", async () => {
    const { repository } = repo();
    await unlockLocalVault(A, SECRET_A);
    await unlockLocalVault(B, SECRET_B);
    const first = await importDirectMessageToPrivateSpace(account(), dm(), PEER, "老友", false, repository);
    expect(first.created).toBe(true);
    const saved = await repository.get(A, first.id);
    expect(saved?.body).toContain("只保存普通私信文字");
    expect(saved?.body).toContain("来源：海内普通私信");
    expect(saved?.body).toContain(PEER);
    expect((await repository.list(B))).toHaveLength(0);

    const second = await importDirectMessageToPrivateSpace(account(B), dm(), PEER, "老友", false, repository);
    expect(second.id).toBe(first.id);
    expect(second.created).toBe(true);
    expect((await repository.list(B))).toHaveLength(1);
  });

  it("refuses burn-tagged, already burned, receipt and burn-control DMs", async () => {
    const { repository } = repo();
    await unlockLocalVault(A, SECRET_A);
    const temporary = {
      ...dm(), tags: [["t", "hainei-dm"], ["t", "hainei-dm-disappearing"],
        ["expiration", "9999999999"], ["burn-after", "10"]],
    };
    expect(canImportDirectMessage(temporary, A, PEER)).toBe(false);
    expect(canImportDirectMessage(dm(), A, PEER, true)).toBe(false);
    await expect(importDirectMessageToPrivateSpace(account(), temporary, PEER, "老友", false, repository))
      .rejects.toThrow("private_space_dm_not_importable");
    await expect(importDirectMessageToPrivateSpace(account(), dm(), PEER, "老友", true, repository))
      .rejects.toThrow("private_space_dm_not_importable");
    const control = { ...dm(), content: JSON.stringify({ type: "hainei-dm-burn", messageId: DM_ID }) };
    expect(canImportDirectMessage(control, A, PEER)).toBe(false);
    const receipt = { ...dm(), tags: [["t", "hainei-dm"], ["t", "hainei-dm-receipt"]] };
    expect(canImportDirectMessage(receipt, A, PEER)).toBe(false);
    expect((await repository.list(A))).toHaveLength(0);
  });

  it("refuses DM injection into post saves and unsent or non-text DM items", async () => {
    expect(canImportPost({ ...post(), tags: [["t", "hainei-dm"]] })).toBe(false);
    expect(canImportPost({ ...post(), tags: [["t", "hainei-dm-disappearing"]] })).toBe(false);
    expect(canImportDirectMessage({ ...dm(), content: "![photo](https://file.example/photo.jpg)" }, A, PEER))
      .toBe(false);
    expect(canImportDirectMessage({ ...dm(), pubkey: B }, A, PEER)).toBe(false);
    expect(canImportDirectMessage({ ...dm(), outgoing: { localId: "pending", state: "sending", hasImage: false } }, A, PEER))
      .toBe(false);
  });

  it("refuses stale account sessions and oversized imports without partial notes", async () => {
    const { repository } = repo();
    await unlockLocalVault(A, SECRET_A);
    const session = account();
    session.isUnlocked = false;
    await expect(importPostToPrivateSpace(session, post(), "好友", repository))
      .rejects.toThrow("private_space_account_changed");
    expect((await repository.list(A))).toHaveLength(0);
    await expect(importPostToPrivateSpace(account(), { ...post(), content: "x".repeat(65_000) }, "好友", repository))
      .rejects.toThrow("private_space_import_too_large");
    expect((await repository.list(A))).toHaveLength(0);
  });
});
